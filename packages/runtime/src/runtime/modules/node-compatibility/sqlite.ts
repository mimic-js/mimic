import type { ScriptEvaluator } from '../module-execution-engine';
import { dirname } from '../virtual-file-system';
import { resolveFileSystemPath } from './filesystem-shared';
import { sqliteEngineAssets } from './sqlite-engine-assets';

/**
 * `node:sqlite` over the publisher SQLite WebAssembly build of
 * `node-sqlite3-wasm` (ADR-0017). The engine's own VFS performs file I/O
 * through Node's synchronous `fs` API, so it is handed the runtime's `node:fs`
 * and database files live on the Virtual File System in SQLite's own format.
 */

type SqliteValue = null | number | bigint | string | Uint8Array;
type SqliteRow = Record<string, SqliteValue>;

type RunResult = {
  changes: number | bigint;
  lastInsertRowid: number | bigint;
};

/** The slice of `node:fs` the engine's VFS calls. */
type SqliteHostFileSystem = {
  readonly constants: Readonly<Record<string, number>>;
  accessSync(path: string, mode?: number): void;
  closeSync(descriptor: number): void;
  fstatSync(descriptor: number): { readonly size: number };
  fsyncSync(descriptor: number): void;
  ftruncateSync(descriptor: number, length?: number): void;
  mkdirSync(path: string): void;
  openSync(path: string, flags?: string | number, mode?: number): number;
  readSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
  rmdirSync(path: string): void;
  unlinkSync(path: string): void;
  writeSync(descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number): number;
};

export type SqliteBuiltinOptions = {
  /** Read on use, so relative database paths follow `process.chdir()`. */
  readonly cwd: string;
  /** The `node:fs` builtin of the same Execution Context. */
  readonly fileSystem: object;
  readonly scriptEvaluator: ScriptEvaluator;
};

type EngineStatement = {
  readonly isFinalized: boolean;
  readonly _db: EngineDatabase;
  readonly _ptr: number;
  _bindValue(value: unknown, position: number): void;
  finalize(): void;
  iterate(values: readonly SqliteValue[]): IterableIterator<SqliteRow>;
};

type EngineDatabase = {
  readonly inTransaction: boolean;
  readonly _ptr: number;
  _handleError(status: number): void;
  close(): void;
  exec(sql: string): void;
  prepare(sql: string): EngineStatement;
};

/** The Emscripten module object `node-sqlite3-wasm` exports. */
type EngineModule = {
  wasmBinary?: Uint8Array;
  Database?: new (filename: string, options?: { readonly readOnly?: boolean }) => EngineDatabase;
  cwrap?(name: string, returnType: string, argumentTypes: readonly string[]): (...parameters: unknown[]) => unknown;
  _sqlite3_bind_double?(statement: number, position: number, value: number): number;
  _sqlite3_changes?(database: number): number;
  _sqlite3_column_count?(statement: number): number;
  _sqlite3_column_type?(statement: number, column: number): number;
  _sqlite3_last_insert_rowid?(database: number): bigint;
  _sqlite3_reset?(statement: number): number;
};

type SqliteEngine = {
  open(location: string, readOnly: boolean): EngineDatabase;
  changes(database: EngineDatabase): number;
  columnCount(statement: EngineStatement): number;
  columnName(statement: EngineStatement, column: number): string;
  columnType(statement: EngineStatement, column: number): number;
  lastInsertRowid(database: EngineDatabase): bigint;
  parameterIndex(statement: EngineStatement, name: string): number;
  reset(statement: EngineStatement): void;
};

type EngineFactory = (
  loadBuiltin: (specifier: string) => unknown,
  module: { exports: unknown },
  filename: string,
  directory: string,
  process: { readonly argv: readonly string[]; readonly platform: string },
  Module: EngineModule
) => void;

type DatabaseSettings = {
  readonly enableForeignKeyConstraints: boolean;
  readonly readOnly: boolean;
  readonly timeout: number;
};

const SQLITE_INTEGER = 1;
const SQLITE_CANTOPEN = 14;
const MIN_INT64 = -(2n ** 63n);
const MAX_INT64 = 2n ** 63n - 1n;
const ENGINE_STATUS = Symbol('sqliteStatus');
const STATEMENT_CONSTRUCTION = Symbol('StatementSync');

/** `sqlite3_errstr()` for the primary result codes; the engine does not export it. */
const RESULT_CODE_MESSAGES: Readonly<Record<number, string>> = {
  1: 'SQL logic error',
  3: 'access permission denied',
  4: 'query aborted',
  5: 'database is locked',
  6: 'database table is locked',
  7: 'out of memory',
  8: 'attempt to write a readonly database',
  9: 'interrupted',
  10: 'disk I/O error',
  11: 'database disk image is malformed',
  12: 'unknown operation',
  13: 'database or disk is full',
  14: 'unable to open database file',
  15: 'locking protocol',
  17: 'database schema has changed',
  18: 'string or blob too big',
  19: 'constraint failed',
  20: 'datatype mismatch',
  21: 'bad parameter or other API misuse',
  22: 'large file support is disabled',
  23: 'authorization denied',
  25: 'column index out of range',
  26: 'file is not a database'
};

const CHANGESET_CONSTANTS = Object.freeze({
  SQLITE_CHANGESET_OMIT: 0,
  SQLITE_CHANGESET_REPLACE: 1,
  SQLITE_CHANGESET_ABORT: 2,
  SQLITE_CHANGESET_DATA: 1,
  SQLITE_CHANGESET_NOTFOUND: 2,
  SQLITE_CHANGESET_CONFLICT: 3,
  SQLITE_CHANGESET_CONSTRAINT: 4,
  SQLITE_CHANGESET_FOREIGN_KEY: 5
});

export function createSqliteBuiltin(options: SqliteBuiltinOptions): unknown {
  let loadedEngine: SqliteEngine | undefined;
  // The engine is compiled on the first opened database, not on `require`.
  const engine = (): SqliteEngine => (loadedEngine ??= loadSqliteEngine(options));

  class StatementSync {
    readonly #statement: EngineStatement;
    readonly #source: PreparedSource;
    #columnNames: readonly string[] | undefined;
    #allowBareNamedParameters = true;
    #allowUnknownNamedParameters = false;
    #readBigInts = false;

    constructor(token?: unknown, statement?: EngineStatement, sql?: string) {
      if (token !== STATEMENT_CONSTRUCTION || !statement || sql === undefined) {
        throw nodeError(Error, 'ERR_ILLEGAL_CONSTRUCTOR', 'Illegal constructor');
      }
      this.#statement = statement;
      this.#source = preparedSource(sql);
      for (const [index, name] of this.#source.parameters.entries()) {
        if (name !== null && engine().parameterIndex(statement, name) !== index + 1) {
          throw unsupported(`a statement whose parameter ${name} cannot be located`);
        }
      }
    }

    get sourceSQL(): string {
      this.#assertUsable();
      const { text } = this.#source;
      if (text === undefined) throw unsupported('StatementSync.sourceSQL of a statement followed by more SQL');
      return text;
    }

    get expandedSQL(): string {
      throw unsupported('StatementSync.expandedSQL');
    }

    run(...parameters: unknown[]): RunResult {
      const rows = this.#execute(parameters);
      try {
        for (;;) if (rows.next().done) break;
      } finally {
        rows.return();
      }
      const connection = this.#statement._db;
      const changes = engine().changes(connection);
      const lastInsertRowid = engine().lastInsertRowid(connection);
      return this.#readBigInts
        ? { changes: BigInt(changes), lastInsertRowid }
        : { changes, lastInsertRowid: safeInteger(lastInsertRowid) };
    }

    get(...parameters: unknown[]): SqliteRow | undefined {
      const rows = this.#execute(parameters);
      try {
        const first = rows.next();
        return first.done ? undefined : first.value;
      } finally {
        rows.return();
      }
    }

    all(...parameters: unknown[]): SqliteRow[] {
      return [...this.#execute(parameters)];
    }

    iterate(...parameters: unknown[]): IterableIterator<SqliteRow> {
      return this.#execute(parameters);
    }

    columns(): never {
      throw unsupported('StatementSync.columns()');
    }

    setAllowBareNamedParameters(enabled: unknown): void {
      this.#allowBareNamedParameters = booleanArgument(enabled, 'allowBareNamedParameters');
    }

    setAllowUnknownNamedParameters(enabled: unknown): void {
      this.#allowUnknownNamedParameters = booleanArgument(enabled, 'enabled');
    }

    setReadBigInts(enabled: unknown): void {
      this.#readBigInts = booleanArgument(enabled, 'readBigInts');
    }

    setReturnArrays(): never {
      throw unsupported('StatementSync.setReturnArrays()');
    }

    /** Binds eagerly, like Node, and steps lazily; the statement is reset once the rows are done with. */
    #execute(parameters: readonly unknown[]): Generator<SqliteRow, void, undefined> {
      this.#assertUsable();
      return this.#rows(this.#bindings(parameters));
    }

    *#rows(values: readonly SqliteValue[]): Generator<SqliteRow, void, undefined> {
      this.#assertUsable();
      try {
        for (const row of this.#statement.iterate(values)) yield this.#row(row);
      } catch (error) {
        throw sqliteError(error);
      } finally {
        // A statement left mid-result keeps its file lock, and an unreset
        // failure would resurface on the next execution.
        if (!this.#statement.isFinalized) engine().reset(this.#statement);
      }
    }

    #assertUsable(): void {
      if (this.#statement.isFinalized) throw invalidState('statement has been finalized');
    }

    #bindings(parameters: readonly unknown[]): SqliteValue[] {
      const names = this.#source.parameters;
      const values: SqliteValue[] = names.map(() => null);
      let anonymous = parameters;
      const [named] = parameters;
      if (typeof named === 'object' && named !== null && !ArrayBuffer.isView(named)) {
        anonymous = parameters.slice(1);
        for (const [key, value] of Object.entries(named)) {
          let index = names.indexOf(key);
          if (index < 0 && this.#allowBareNamedParameters) index = bareParameterIndex(names, key);
          if (index >= 0) values[index] = bindableValue(value, index + 1);
          else if (!this.#allowUnknownNamedParameters) throw invalidState(`Unknown named parameter '${key}'`);
        }
      }
      // Anonymous values fill the slots without a name of their own, `?NNN`
      // included, in order. A surplus value lands past the last parameter,
      // where the engine reports the range error.
      let index = 0;
      for (const value of anonymous) {
        while (names[index]?.startsWith('?') === false) index += 1;
        values[index] = bindableValue(value, index + 1);
        index += 1;
      }
      return values;
    }

    #row(row: SqliteRow): SqliteRow {
      const integerColumns = this.#readBigInts ? this.#integerColumns() : undefined;
      const result = Object.create(null) as SqliteRow;
      for (const [name, value] of Object.entries(row)) {
        if (integerColumns) {
          result[name] = integerColumns.has(name) && typeof value === 'number' ? BigInt(value) : value;
        } else {
          // Only an INTEGER outside the safe range arrives as a bigint.
          result[name] = typeof value === 'bigint' ? safeInteger(value) : value;
        }
      }
      return result;
    }

    /**
     * The engine returns safe INTEGER values as numbers, which a REAL holding a
     * whole number also is, so the storage class of the current row decides.
     */
    #integerColumns(): Set<string> {
      const statement = this.#statement;
      this.#columnNames ??= Array.from({ length: engine().columnCount(statement) }, (_, column) =>
        engine().columnName(statement, column)
      );
      const integers = new Set<string>();
      for (const [column, name] of this.#columnNames.entries()) {
        // A repeated column name keeps its last value, so its last type decides.
        if (engine().columnType(statement, column) === SQLITE_INTEGER) integers.add(name);
        else integers.delete(name);
      }
      return integers;
    }
  }

  class DatabaseSync {
    readonly #location: string;
    readonly #settings: DatabaseSettings;
    readonly #statements = new Set<EngineStatement>();
    /** Releases the engine statement of a StatementSync the program dropped. */
    readonly #droppedStatements = new FinalizationRegistry<EngineStatement>((statement) => {
      if (this.#statements.delete(statement)) statement.finalize();
    });
    #connection: EngineDatabase | undefined;

    constructor(path?: unknown, settings?: unknown) {
      this.#location = databaseLocation(path);
      const { open, ...databaseSettings } = databaseOptions(settings);
      this.#settings = databaseSettings;
      if (open) this.open();
    }

    get isOpen(): boolean {
      return this.#connection !== undefined;
    }

    get isTransaction(): boolean {
      return this.#open().inTransaction;
    }

    open(): void {
      if (this.#connection) throw invalidState('database is already open');
      let connection: EngineDatabase;
      try {
        connection = engine().open(this.#location, this.#settings.readOnly);
      } catch (error) {
        throw sqliteError(error, SQLITE_CANTOPEN);
      }
      try {
        connection.exec(`PRAGMA foreign_keys = ${this.#settings.enableForeignKeyConstraints ? 'ON' : 'OFF'}`);
        if (this.#settings.timeout > 0) connection.exec(`PRAGMA busy_timeout = ${this.#settings.timeout}`);
      } catch (error) {
        connection.close();
        throw sqliteError(error);
      }
      this.#connection = connection;
    }

    close(): void {
      const connection = this.#open();
      for (const statement of this.#statements) statement.finalize();
      this.#statements.clear();
      this.#connection = undefined;
      try {
        connection.close();
      } catch (error) {
        throw sqliteError(error);
      }
    }

    exec(sql: unknown): void {
      const connection = this.#open();
      try {
        connection.exec(stringArgument(sql, 'sql'));
      } catch (error) {
        throw sqliteError(error);
      }
    }

    prepare(sql: unknown): StatementSync {
      const connection = this.#open();
      const source = stringArgument(sql, 'sql');
      let statement: EngineStatement;
      try {
        statement = connection.prepare(source);
      } catch (error) {
        throw sqliteError(error);
      }
      this.#statements.add(statement);
      const prepared = new StatementSync(STATEMENT_CONSTRUCTION, statement, source);
      this.#droppedStatements.register(prepared, statement);
      return prepared;
    }

    location(databaseName?: unknown): string | null {
      this.#open();
      if (databaseName !== undefined && databaseName !== 'main') {
        throw unsupported('DatabaseSync.location() of an attached database');
      }
      const inMemory = this.#location === ':memory:' || this.#location === '';
      return inMemory ? null : resolveFileSystemPath(this.#location, options.cwd);
    }

    // The engine binds a whole-number result as INTEGER where Node returns a REAL.
    function(): never {
      throw unsupported('DatabaseSync.function()');
    }

    aggregate(): never {
      throw unsupported('DatabaseSync.aggregate()');
    }

    createSession(): never {
      throw unsupported('DatabaseSync.createSession()');
    }

    applyChangeset(): never {
      throw unsupported('DatabaseSync.applyChangeset()');
    }

    enableLoadExtension(): never {
      throw unsupported('DatabaseSync.enableLoadExtension()');
    }

    loadExtension(): never {
      throw unsupported('DatabaseSync.loadExtension()');
    }

    #open(): EngineDatabase {
      if (!this.#connection) throw invalidState('database is not open');
      return this.#connection;
    }
  }

  const backup = (): never => {
    throw unsupported('backup()');
  };
  const sqlite = { DatabaseSync, StatementSync, backup, constants: CHANGESET_CONSTANTS };
  return { ...sqlite, default: sqlite };
}

/**
 * Evaluates the publisher's CommonJS glue once per Execution Context. The glue
 * instantiates WebAssembly synchronously and expects Node's module scope, so
 * it runs inside a module wrapper whose `require` serves the VFS-backed
 * builtins it asks for.
 */
function loadSqliteEngine(options: SqliteBuiltinOptions): SqliteEngine {
  const hostFileSystem = options.fileSystem as SqliteHostFileSystem;
  const builtins: Readonly<Record<string, unknown>> = {
    'node:fs': {
      ...hostFileSystem,
      // The engine addresses pages with the 64-bit offsets WebAssembly hands it.
      readSync: (descriptor: number, buffer: Uint8Array, offset: number, length: number, position: number | bigint) =>
        hostFileSystem.readSync(descriptor, buffer, offset, length, Number(position))
    },
    'node:path': {
      // The glue only takes the directory of a SQLite full pathname, which
      // `resolve` below has already normalised.
      dirname,
      resolve: (path: string) => resolveFileSystemPath(path, options.cwd)
    },
    'node:crypto': { randomFillSync }
  };
  const engine = readSqliteEngine();
  const module: EngineModule = { wasmBinary: engine.wasm };
  const factory = options.scriptEvaluator.evaluate(
    `(function (require, module, __filename, __dirname, process, Module) {\n${engine.glue}\n})`,
    { filename: 'node:sqlite/node-sqlite3-wasm.js' }
  ) as EngineFactory;
  factory(
    (specifier) => {
      if (specifier in builtins) return builtins[specifier];
      throw new Error(`node:sqlite engine requested an unexpected module: ${specifier}`);
    },
    { exports: {} },
    '/node-sqlite3-wasm.js',
    '/',
    { argv: [], platform: 'browser' },
    module
  );

  const {
    Database,
    cwrap,
    _sqlite3_bind_double: bindDouble,
    _sqlite3_changes: changes,
    _sqlite3_column_count: columnCount,
    _sqlite3_column_type: columnType,
    _sqlite3_last_insert_rowid: lastInsertRowid,
    _sqlite3_reset: reset
  } = module;
  if (!Database || !cwrap || !bindDouble || !changes || !columnCount || !columnType || !lastInsertRowid || !reset) {
    throw new Error('node:sqlite engine did not initialise');
  }

  /** Keeps the result code the engine's error only reports as a message. */
  class Connection extends Database {
    _handleError(status: number): void {
      try {
        super._handleError(status);
      } catch (error) {
        throw Object.assign(error as object, { [ENGINE_STATUS]: status });
      }
    }
  }

  // Node binds every JavaScript number as a REAL, while the engine binds whole
  // numbers as INTEGER, which changes arithmetic such as `? / 2`.
  const probe = new Connection(':memory:');
  const statementPrototype = Object.getPrototypeOf(probe.prepare('SELECT 1')) as EngineStatement;
  probe.close();
  const bindValue = statementPrototype._bindValue;
  if (typeof bindValue !== 'function' || typeof Database.prototype._handleError !== 'function') {
    throw new Error('node:sqlite engine does not match the pinned node-sqlite3-wasm version');
  }
  statementPrototype._bindValue = function (this: EngineStatement, value: unknown, position: number): void {
    if (typeof value !== 'number') return bindValue.call(this, value, position);
    const status = bindDouble(this._ptr, position, value);
    if (status !== 0) this._db._handleError(status);
  };

  const parameterIndex = cwrap('sqlite3_bind_parameter_index', 'number', ['number', 'string']);
  const columnName = cwrap('sqlite3_column_name', 'string', ['number', 'number']);
  return {
    open: (location, readOnly) => new Connection(location, { readOnly }),
    changes: (database) => changes(database._ptr),
    columnCount: (statement) => columnCount(statement._ptr),
    columnName: (statement, column) => String(columnName(statement._ptr, column)),
    columnType: (statement, column) => columnType(statement._ptr, column),
    lastInsertRowid: (database) => lastInsertRowid(database._ptr),
    parameterIndex: (statement, name) => Number(parameterIndex(statement._ptr, name)),
    reset: (statement) => {
      reset(statement._ptr);
    }
  };
}

/**
 * Unit tests run the runtime inside Node, where the SQLite binary is a host
 * file. The host process is captured before a program's own `process` global
 * replaces it.
 */
const hostProcess = (
  globalThis as {
    readonly process?: { getBuiltinModule?(id: string): { readFileSync(path: URL): Uint8Array } | undefined };
  }
).process;
let sqliteEngine: { readonly glue: string; readonly wasm: Uint8Array } | undefined;

/**
 * The SQLite binary and the publisher's glue for it are separate package
 * assets, fetched once per worker on first use, so a process that never opens
 * a database loads neither. Opening a database is synchronous, so the reads
 * are too.
 */
function readSqliteEngine(): { readonly glue: string; readonly wasm: Uint8Array } {
  const assets = sqliteEngineAssets();
  sqliteEngine ??= {
    glue: new TextDecoder().decode(readSqliteAsset(new URL(assets.glue))),
    wasm: readSqliteAsset(new URL(assets.wasm))
  };
  return sqliteEngine;
}

function readSqliteAsset(url: URL): Uint8Array {
  if (url.protocol === 'file:') {
    const hostFileSystem = hostProcess?.getBuiltinModule?.('node:fs');
    if (!hostFileSystem) throw new Error(`node:sqlite cannot read its SQLite engine asset: ${url.href}`);
    return hostFileSystem.readFileSync(url);
  }
  if (typeof XMLHttpRequest !== 'function') {
    throw new Error('node:sqlite needs synchronous XMLHttpRequest to load its SQLite engine assets');
  }
  const request = new XMLHttpRequest();
  request.open('GET', url, false);
  request.responseType = 'arraybuffer';
  request.send();
  if (request.status !== 200 || !(request.response instanceof ArrayBuffer)) {
    throw new Error(`node:sqlite could not load its SQLite engine asset: ${url.href} (${request.status})`);
  }
  return new Uint8Array(request.response);
}

function randomFillSync<Bytes extends Uint8Array>(bytes: Bytes): Bytes {
  // Web Crypto fills at most 65536 bytes per call.
  for (let offset = 0; offset < bytes.byteLength; offset += 65_536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, offset + 65_536));
  }
  return bytes;
}

type PreparedSource = {
  /** Parameter names by zero-based index; `null` marks an anonymous `?`. */
  readonly parameters: readonly (string | null)[];
  /** The statement SQLite compiled, when its end in `sql` is certain. */
  readonly text: string | undefined;
};

/**
 * Lists the parameters of the first statement in `sql` by index, as SQLite
 * numbers them. The engine does not export `sqlite3_bind_parameter_name()`,
 * which Node uses to resolve bare names and to keep anonymous values off named
 * slots, so the names are read from the already-compiled source instead.
 */
function preparedSource(sql: string): PreparedSource {
  const names: (string | null)[] = [];
  const skipTo = (terminator: string, from: number): number => {
    const end = sql.indexOf(terminator, from);
    return end < 0 ? sql.length : end + terminator.length;
  };
  let index = 0;
  while (index < sql.length) {
    const character = sql[index];
    if (character === ';') break;
    if (character === "'" || character === '"' || character === '`') {
      // A doubled quote is an escape, which reads as two adjacent literals.
      index = skipTo(character, index + 1);
    } else if (character === '[') {
      index = skipTo(']', index + 1);
    } else if (sql.startsWith('--', index)) {
      index = skipTo('\n', index + 2);
    } else if (sql.startsWith('/*', index)) {
      index = skipTo('*/', index + 2);
    } else if (character === '?') {
      const digits = /\d*/y;
      digits.lastIndex = index + 1;
      const [position] = digits.exec(sql) ?? [''];
      if (position) names[Number(position) - 1] = `?${position}`;
      else names.push(null);
      index += 1 + position.length;
    } else if (character === ':' || character === '@' || character === '$') {
      const identifier = /[\w$\u0080-￿]+/y;
      identifier.lastIndex = index + 1;
      const name = character + (identifier.exec(sql)?.[0] ?? '');
      index += name.length;
      if (!names.includes(name)) names.push(name);
    } else {
      // Identifiers and numbers may contain `$`, which must not start a parameter.
      const word = /[\w\u0080-￿][\w$\u0080-￿]*/y;
      word.lastIndex = index;
      index += word.exec(sql)?.[0].length ?? 1;
    }
  }
  // A `;` inside a trigger body does not end the statement, so text after the
  // first one leaves the compiled extent unknown.
  const end = Math.min(index + 1, sql.length);
  return {
    // Indexes a numbered parameter skipped over are unnamed slots.
    parameters: Array.from(names, (name) => name ?? null),
    text: sql.slice(end).trim() === '' ? sql.slice(0, end) : undefined
  };
}

function bareParameterIndex(names: readonly (string | null)[], bareName: string): number {
  let match = -1;
  for (const [index, name] of names.entries()) {
    if (name === null || name.startsWith('?') || name.slice(1) !== bareName) continue;
    if (match >= 0) {
      throw invalidState(
        `Cannot create bare named parameter '${bareName}' because of conflicting names '${names[match]}' and '${name}'.`
      );
    }
    match = index;
  }
  return match;
}

function bindableValue(value: unknown, position: number): SqliteValue {
  if (value === null || typeof value === 'number' || typeof value === 'string') return value;
  if (typeof value === 'bigint') {
    if (value < MIN_INT64 || value > MAX_INT64) {
      throw nodeError(TypeError, 'ERR_INVALID_ARG_VALUE', 'BigInt value is too large to bind.');
    }
    return value;
  }
  if (ArrayBuffer.isView(value)) return binaryValue(value);
  throw nodeError(
    TypeError,
    'ERR_INVALID_ARG_TYPE',
    `Provided value cannot be bound to SQLite parameter ${position}.`
  );
}

function binaryValue(view: ArrayBufferView): Uint8Array {
  return view instanceof Uint8Array ? view : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

function safeInteger(value: bigint): number {
  if (value < BigInt(Number.MIN_SAFE_INTEGER) || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw nodeError(
      RangeError,
      'ERR_OUT_OF_RANGE',
      `Value is too large to be represented as a JavaScript number: ${value}`
    );
  }
  return Number(value);
}

function databaseLocation(path: unknown): string {
  let location: string | undefined;
  if (typeof path === 'string') location = path;
  else if (path instanceof Uint8Array) location = new TextDecoder().decode(path);
  else if (path instanceof URL && path.protocol === 'file:') location = decodeURIComponent(path.pathname);
  if (location === undefined || location.includes('\0')) {
    throw nodeError(
      TypeError,
      'ERR_INVALID_ARG_TYPE',
      'The "path" argument must be a string, Uint8Array, or URL without null bytes.'
    );
  }
  return location;
}

function databaseOptions(settings: unknown): DatabaseSettings & { readonly open: boolean } {
  if (settings !== undefined && (typeof settings !== 'object' || settings === null)) {
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options" argument must be an object.');
  }
  const record = (settings ?? {}) as Record<string, unknown>;
  const flag = (name: string, fallback: boolean): boolean => {
    const value = record[name];
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "options.${name}" argument must be a boolean.`);
  };
  const timeout = record.timeout ?? 0;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout)) {
    throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', 'The "options.timeout" argument must be an integer.');
  }
  if (flag('allowExtension', false)) throw unsupported('DatabaseSync with the allowExtension option');
  // The engine is compiled without them and exports no sqlite3_db_config().
  if (flag('enableDoubleQuotedStringLiterals', false)) {
    throw unsupported('DatabaseSync with the enableDoubleQuotedStringLiterals option');
  }
  return {
    enableForeignKeyConstraints: flag('enableForeignKeyConstraints', true),
    open: flag('open', true),
    readOnly: flag('readOnly', false),
    timeout
  };
}

function stringArgument(value: unknown, name: string): string {
  if (typeof value === 'string') return value;
  throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be a string.`);
}

function booleanArgument(value: unknown, name: string): boolean {
  if (typeof value === 'boolean') return value;
  throw nodeError(TypeError, 'ERR_INVALID_ARG_TYPE', `The "${name}" argument must be a boolean.`);
}

/** Projects an engine failure onto the error Node's binding throws; anything else passes through. */
function sqliteError(error: unknown, fallbackStatus = 1): unknown {
  if (!(error instanceof Error) || error.name !== 'SQLite3Error') return error;
  const status = (error as { [ENGINE_STATUS]?: number })[ENGINE_STATUS];
  const errcode = status ?? fallbackStatus;
  const errstr = RESULT_CODE_MESSAGES[errcode & 0xff] ?? 'unknown error';
  return Object.assign(new Error(status === undefined && errcode !== 1 ? errstr : error.message), {
    code: 'ERR_SQLITE_ERROR',
    errcode,
    errstr
  });
}

function invalidState(message: string): Error {
  return nodeError(Error, 'ERR_INVALID_STATE', message);
}

function unsupported(feature: string): Error {
  return nodeError(Error, 'ENOTSUP', `node:sqlite ${feature} is not supported in Mimic`);
}

function nodeError(ErrorClass: ErrorConstructor, code: string, message: string): Error {
  return Object.assign(new ErrorClass(message), { code });
}

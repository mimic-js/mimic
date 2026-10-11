import { runInThisContext } from 'node:vm';

import { describe, expect, test } from 'vitest';

import { BrowserBuffer } from '../buffer';
import { type NodeCompatibilityGlobals } from '../node-compatibility';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';
import { createNodeCompatibilityHarness } from './node-compatibility-harness';

type Row = Record<string, unknown>;
type RunResult = { readonly changes: number | bigint; readonly lastInsertRowid: number | bigint };
type StatementSync = {
  readonly expandedSQL: string;
  readonly sourceSQL: string;
  all(...parameters: unknown[]): Row[];
  columns(): unknown;
  get(...parameters: unknown[]): Row | undefined;
  iterate(...parameters: unknown[]): IterableIterator<Row>;
  run(...parameters: unknown[]): RunResult;
  setAllowBareNamedParameters(enabled: boolean): void;
  setAllowUnknownNamedParameters(enabled: boolean): void;
  setReadBigInts(enabled: boolean): void;
};
type DatabaseSync = {
  readonly isOpen: boolean;
  readonly isTransaction: boolean;
  close(): void;
  createSession(): unknown;
  exec(sql: string): void;
  function(name: string, implementation: (...parameters: never[]) => unknown): void;
  location(): string | null;
  open(): void;
  prepare(sql: string): StatementSync;
};
type SqliteBuiltin = {
  readonly DatabaseSync: new (path: string | Uint8Array | URL, options?: Record<string, unknown>) => DatabaseSync;
  readonly StatementSync: new () => StatementSync;
  readonly default: Omit<SqliteBuiltin, 'default'>;
};

const hostSqlite = process.getBuiltinModule('node:sqlite') as typeof import('node:sqlite') | undefined;


/*
 * The expectations below were pinned against the host `node:sqlite` (Node
 * 22.20), except where a comment names a documented engine limit.
 */
describe('Node Compatibility sqlite', () => {
  test('keeps named and default exports on one builtin identity surface', () => {
    const { sqlite } = loadSqlite();

    expect(sqlite.default.DatabaseSync).toBe(sqlite.DatabaseSync);
    expect(sqlite.default.StatementSync).toBe(sqlite.StatementSync);
    expect(() => new sqlite.StatementSync()).toThrow(expect.objectContaining({ code: 'ERR_ILLEGAL_CONSTRUCTOR' }));
  });

  test('joins tables, inserts several rows per statement, and uses a created index', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE author (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE book (id INTEGER PRIMARY KEY, author_id INTEGER NOT NULL REFERENCES author(id), title TEXT, pages INTEGER);
      CREATE INDEX book_by_author ON book (author_id, pages);
    `);

    expect(database.prepare("INSERT INTO author (name) VALUES ('Ada'), ('Brian'), ('Chloe')").run()).toEqual({
      changes: 3,
      lastInsertRowid: 3
    });
    const insertBook = database.prepare('INSERT INTO book (author_id, title, pages) VALUES (?, ?, ?), (?, ?, ?)');
    expect(insertBook.run(1, 'Notes', 120, 1, 'Engines', 300)).toEqual({ changes: 2, lastInsertRowid: 2 });
    expect(insertBook.run(2, 'C', 250, 2, 'Unix', 90)).toEqual({ changes: 2, lastInsertRowid: 4 });

    expect(
      database
        .prepare(
          `SELECT author.name AS author, COUNT(book.id) AS books, SUM(book.pages) AS pages
             FROM author LEFT JOIN book ON book.author_id = author.id
            GROUP BY author.id HAVING books >= ? ORDER BY pages DESC`
        )
        .all(0)
    ).toEqual([
      { author: 'Ada', books: 2, pages: 420 },
      { author: 'Brian', books: 2, pages: 340 },
      { author: 'Chloe', books: 0, pages: null }
    ]);
    expect(
      database
        .prepare('SELECT title FROM book JOIN author ON author.id = book.author_id WHERE author.name = ? ORDER BY pages')
        .all('Brian')
    ).toEqual([{ title: 'Unix' }, { title: 'C' }]);
    expect(
      database.prepare('EXPLAIN QUERY PLAN SELECT title FROM book WHERE author_id = ? AND pages > ?').get(1, 100)?.detail
    ).toContain('USING INDEX book_by_author');
    expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()).toEqual([
      { name: 'book_by_author' }
    ]);
    database.close();
  });

  test('commits and rolls back transactions, restoring the data a rollback discards', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync('/home/project/ledger.db');
    database.exec('CREATE TABLE entry (id INTEGER PRIMARY KEY, amount INTEGER NOT NULL)');
    const insert = database.prepare('INSERT INTO entry (amount) VALUES (?)');
    const amounts = () => database.prepare('SELECT amount FROM entry ORDER BY id').all().map((row) => row.amount);

    expect(database.isTransaction).toBe(false);
    database.exec('BEGIN');
    expect(database.isTransaction).toBe(true);
    insert.run(10);
    insert.run(20);
    database.exec('COMMIT');
    expect(database.isTransaction).toBe(false);
    expect(amounts()).toEqual([10, 20]);

    database.exec('BEGIN');
    insert.run(30);
    database.exec('UPDATE entry SET amount = amount * 2');
    database.exec('DELETE FROM entry WHERE id = 1');
    expect(amounts()).toEqual([40, 60]);
    database.exec('ROLLBACK');
    expect(amounts()).toEqual([10, 20]);

    database.exec('BEGIN; INSERT INTO entry (amount) VALUES (1); SAVEPOINT inner; DELETE FROM entry;');
    database.exec('ROLLBACK TO inner; COMMIT');
    expect(amounts()).toEqual([10, 20, 1]);
    database.close();
  });

  test('stores a database file SQLite can read back after the connection reopens', () => {
    const { sqlite, fileSystem } = loadSqlite();
    const writer = new sqlite.DatabaseSync('store.db');
    expect(writer.location()).toBe('/home/project/store.db');
    // The engine's VFS has no shared memory, so a write-ahead log request keeps the rollback journal.
    expect(writer.prepare('PRAGMA journal_mode = WAL').get()).toEqual({ journal_mode: 'delete' });
    writer.exec('PRAGMA synchronous = NORMAL; PRAGMA wal_checkpoint(TRUNCATE); PRAGMA optimize');
    writer.exec('CREATE TABLE package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');
    const set = writer.prepare('INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)');
    for (let index = 0; index < 500; index += 1) set.run(`package-${index}`, new Uint8Array(64).fill(index));
    set.run('package-7', new Uint8Array([7]));
    writer.close();

    const file = fileSystem.readFileSync('/home/project/store.db');
    expect(new TextDecoder().decode(file.subarray(0, 16))).toBe('SQLite format 3\0');
    const pageSize = (file[16] << 8) | file[17];
    expect(file.byteLength % pageSize).toBe(0);
    expect(file.byteLength / pageSize).toBeGreaterThan(8);
    // A rollback journal and the engine's lock directory do not outlive the connection.
    expect(fileSystem.readdirSync('/home/project').sort()).toEqual(['store.db']);

    const reader = new sqlite.DatabaseSync('/home/project/store.db', { readOnly: true });
    expect(reader.prepare('SELECT COUNT(*) AS count FROM package_index').get()).toEqual({ count: 500 });
    expect(reader.prepare('SELECT data FROM package_index WHERE key = ?').get('package-7')).toEqual({
      data: new Uint8Array([7])
    });
    expect(reader.prepare('PRAGMA integrity_check').all()).toEqual([{ integrity_check: 'ok' }]);
    expect(() => reader.exec("DELETE FROM package_index WHERE key = 'package-7'")).toThrow(
      expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 8, errstr: 'attempt to write a readonly database' })
    );
    reader.close();
  });

  // The host SQLite is a second witness of the file format where the host Node ships one.
  test.skipIf(!hostSqlite)('reads a database the host SQLite wrote and writes one the host SQLite reads', () => {
    const host = hostSqlite!;
    const hostFs = process.getBuiltinModule('node:fs');
    const directory = hostFs.mkdtempSync(`${process.getBuiltinModule('node:os').tmpdir()}/mimic-sqlite-`);
    try {
      const hostDatabase = new host.DatabaseSync(`${directory}/host.db`);
      hostDatabase.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('from-host')");
      hostDatabase.close();

      const { sqlite, fileSystem } = loadSqlite();
      fileSystem.writeFileSync('/home/project/host.db', new Uint8Array(hostFs.readFileSync(`${directory}/host.db`)));
      const database = new sqlite.DatabaseSync('/home/project/host.db');
      expect(database.prepare('SELECT name FROM t').all()).toEqual([{ name: 'from-host' }]);
      database.prepare('INSERT INTO t (name) VALUES (?)').run('from-runtime');
      database.close();

      hostFs.writeFileSync(`${directory}/runtime.db`, fileSystem.readFileSync('/home/project/host.db'));
      const reopened = new host.DatabaseSync(`${directory}/runtime.db`);
      expect(reopened.prepare('SELECT name FROM t ORDER BY id').all().map((row) => row.name)).toEqual([
        'from-host',
        'from-runtime'
      ]);
      expect(reopened.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' });
      reopened.close();
    } finally {
      hostFs.rmSync(directory, { recursive: true, force: true });
    }
  });

  test('binds anonymous, numbered, prefixed, and bare named parameters as Node does', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:');
    const named = database.prepare('SELECT :a AS a, $b AS b, @c AS c');

    expect(named.get({ ':a': 1, $b: 2, '@c': 3 })).toEqual({ a: 1, b: 2, c: 3 });
    expect(named.get({ a: 1, b: 2, c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
    expect(named.get({ a: 1 })).toEqual({ a: 1, b: null, c: null });
    expect(() => named.get({ a: 1, missing: 2 })).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_STATE', message: "Unknown named parameter 'missing'" })
    );
    named.setAllowUnknownNamedParameters(true);
    expect(named.get({ a: 1, missing: 2 })).toEqual({ a: 1, b: null, c: null });
    named.setAllowBareNamedParameters(false);
    named.setAllowUnknownNamedParameters(false);
    expect(() => named.get({ a: 1 })).toThrow(expect.objectContaining({ code: 'ERR_INVALID_STATE' }));
    expect(() => database.prepare('SELECT :a AS a, $a AS b').get({ a: 1 })).toThrow(
      expect.objectContaining({
        code: 'ERR_INVALID_STATE',
        message: "Cannot create bare named parameter 'a' because of conflicting names ':a' and '$a'."
      })
    );

    expect(database.prepare('SELECT :a AS a, ? AS b').get({ a: 1 }, 2)).toEqual({ a: 1, b: 2 });
    expect(database.prepare('SELECT :a AS a, ? AS b').get(5)).toEqual({ a: null, b: 5 });
    expect(database.prepare('SELECT ?2 AS a, ?1 AS b').get({ '?1': 1, '?2': 2 })).toEqual({ a: 2, b: 1 });
    expect(database.prepare('SELECT ?3 AS a, ? AS b').get(1, 2)).toEqual({ a: null, b: null });
    expect(database.prepare('SELECT ? AS a, typeof(?1) AS b').get(1)).toEqual({ a: 1, b: 'real' });
    expect(
      database.prepare("SELECT ? AS a, ':skipped ''?' AS b, 3 AS \"$c ?\" /* ? */, ? AS d, 4 AS e$f -- ?").get(1, 2)
    ).toEqual({ a: 1, b: ":skipped '?", '$c ?': 3, d: 2, e$f: 4 });
    expect(database.prepare('SELECT ? AS a, ? AS b').get(1)).toEqual({ a: 1, b: null });
    expect(() => database.prepare('SELECT ? AS a').get(1, 2)).toThrow(
      expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 25, errstr: 'column index out of range' })
    );
    expect(() => database.prepare('SELECT ? AS a').get([1])).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_STATE', message: "Unknown named parameter '0'" })
    );
    database.close();
  });

  test('converts values between JavaScript and SQLite storage classes as Node does', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:');
    const echo = database.prepare('SELECT ? AS value, typeof(?1) AS type');

    expect(echo.get(3)).toEqual({ value: 3, type: 'real' });
    expect(database.prepare('SELECT ? / 2 AS half').get(3)).toEqual({ half: 1.5 });
    expect(echo.get(3n)).toEqual({ value: 3, type: 'integer' });
    expect(echo.get('text')).toEqual({ value: 'text', type: 'text' });
    expect(echo.get(null)).toEqual({ value: null, type: 'null' });
    expect(echo.get(new Uint8Array([1, 2, 3]))).toEqual({ value: new Uint8Array([1, 2, 3]), type: 'blob' });
    expect(echo.get(new DataView(new Uint8Array([9, 8]).buffer))).toEqual({ value: new Uint8Array([9, 8]), type: 'blob' });
    expect(echo.get(new Uint8Array())).toEqual({ value: new Uint8Array(), type: 'blob' });
    expect(Object.getPrototypeOf(echo.get(1))).toBeNull();

    for (const rejected of [true, undefined, {}, new ArrayBuffer(2)]) {
      expect(() => database.prepare('SELECT ? AS a, ? AS b').get(1, rejected)).toThrow(
        expect.objectContaining({
          code: 'ERR_INVALID_ARG_TYPE',
          message: 'Provided value cannot be bound to SQLite parameter 2.'
        })
      );
    }
    expect(() => echo.get(2n ** 70n)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_VALUE', message: 'BigInt value is too large to bind.' })
    );

    const large = database.prepare('SELECT ? AS value, 2.0 AS real, 7 AS small');
    expect(() => large.get(2n ** 62n)).toThrow(
      expect.objectContaining({
        code: 'ERR_OUT_OF_RANGE',
        message: 'Value is too large to be represented as a JavaScript number: 4611686018427387904'
      })
    );
    large.setReadBigInts(true);
    expect(large.get(2n ** 62n)).toEqual({ value: 2n ** 62n, real: 2, small: 7n });
    database.close();
  });

  test('reports run results and rows through get, all, and iterate', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:');
    database.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT UNIQUE)');
    const insert = database.prepare('INSERT INTO t (name) VALUES (?)');

    expect(insert.run('a')).toEqual({ changes: 1, lastInsertRowid: 1 });
    expect(insert.sourceSQL).toBe('INSERT INTO t (name) VALUES (?)');
    insert.setReadBigInts(true);
    expect(insert.run('b')).toEqual({ changes: 1n, lastInsertRowid: 2n });
    expect(database.prepare("INSERT INTO t (name) VALUES ('c') RETURNING id, name").all()).toEqual([
      { id: 3, name: 'c' }
    ]);
    expect(database.prepare("INSERT INTO t (name) VALUES ('d')").get()).toBeUndefined();
    expect(database.prepare('SELECT name FROM t WHERE name = ?').get('missing')).toBeUndefined();
    expect(database.prepare('SELECT 1 AS a, 2 AS a').get()).toEqual({ a: 2 });
    expect(database.prepare('SELECT 1 AS a; SELECT 2 AS b').get()).toEqual({ a: 1 });

    const rows = database.prepare('SELECT name FROM t ORDER BY id').iterate();
    expect(rows.next()).toEqual({ done: false, value: { name: 'a' } });
    expect([...rows]).toEqual([{ name: 'b' }, { name: 'c' }, { name: 'd' }]);

    // A partly read statement holds no lock that would block the transaction.
    const partial = database.prepare('SELECT name FROM t ORDER BY id');
    expect(partial.get()).toEqual({ name: 'a' });
    database.exec('BEGIN; DELETE FROM t WHERE id = 4; COMMIT');
    expect(partial.all()).toHaveLength(3);
    database.close();
  });

  test('throws Node-shaped SQLite errors and recovers the statement afterwards', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:');
    database.exec(`
      CREATE TABLE parent (id INTEGER PRIMARY KEY, name TEXT UNIQUE);
      CREATE TABLE child (parent_id INTEGER REFERENCES parent(id));
    `);
    const insert = database.prepare('INSERT INTO parent (name) VALUES (?)');
    insert.run('once');

    // Node reports the extended result code (2067 and 787); the engine exports only the primary one.
    expect(() => insert.run('once')).toThrow(
      expect.objectContaining({
        code: 'ERR_SQLITE_ERROR',
        errcode: 19,
        errstr: 'constraint failed',
        message: 'UNIQUE constraint failed: parent.name'
      })
    );
    expect(insert.run('twice')).toEqual({ changes: 1, lastInsertRowid: 2 });
    expect(() => database.exec('INSERT INTO child VALUES (99)')).toThrow(
      expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 19, message: 'FOREIGN KEY constraint failed' })
    );
    expect(() => database.exec('SELEC 1')).toThrow(
      expect.objectContaining({
        code: 'ERR_SQLITE_ERROR',
        errcode: 1,
        errstr: 'SQL logic error',
        message: 'near "SELEC": syntax error'
      })
    );
    expect(() => database.prepare('SELECT * FROM nope')).toThrow(
      expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 1, message: 'no such table: nope' })
    );
    expect(() => database.exec(5 as never)).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE', message: 'The "sql" argument must be a string.' })
    );
    expect(() => new sqlite.DatabaseSync('/home/project/missing/dir.db')).toThrow(
      expect.objectContaining({
        code: 'ERR_SQLITE_ERROR',
        errcode: 14,
        errstr: 'unable to open database file',
        message: 'unable to open database file'
      })
    );
    expect(() => new sqlite.DatabaseSync(5 as never)).toThrow(expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' }));
    database.close();
  });

  test('honors the open, foreign-key, and lifecycle contract of DatabaseSync', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:', { open: false });
    const notOpen = expect.objectContaining({ code: 'ERR_INVALID_STATE', message: 'database is not open' });

    expect(database.isOpen).toBe(false);
    expect(() => database.exec('SELECT 1')).toThrow(notOpen);
    database.open();
    expect(database.isOpen).toBe(true);
    expect(database.location()).toBeNull();
    expect(() => database.open()).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_STATE', message: 'database is already open' })
    );
    expect(database.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const statement = database.prepare('SELECT 1 AS one');

    database.close();
    expect(database.isOpen).toBe(false);
    expect(() => database.isTransaction).toThrow(notOpen);
    expect(() => database.prepare('SELECT 1')).toThrow(notOpen);
    expect(() => database.close()).toThrow(notOpen);
    expect(() => statement.get()).toThrow(
      expect.objectContaining({ code: 'ERR_INVALID_STATE', message: 'statement has been finalized' })
    );

    const lenient = new sqlite.DatabaseSync(':memory:', { enableForeignKeyConstraints: false });
    expect(lenient.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 0 });
    lenient.close();
    expect(new sqlite.DatabaseSync(new TextEncoder().encode(':memory:')).isOpen).toBe(true);
  });

  test('rejects the parts of node:sqlite the engine cannot honor instead of approximating them', () => {
    const { sqlite } = loadSqlite();
    const database = new sqlite.DatabaseSync(':memory:');
    const statement = database.prepare('SELECT 1 AS one');
    const unsupported = expect.objectContaining({ code: 'ENOTSUP' });

    expect(() => statement.expandedSQL).toThrow(unsupported);
    expect(() => statement.columns()).toThrow(unsupported);
    expect(() => database.createSession()).toThrow(unsupported);
    expect(() => database.function('twice', (value: number) => value * 2)).toThrow(unsupported);
    expect(() => database.prepare('SELECT 1 AS a; SELECT 2 AS b').sourceSQL).toThrow(unsupported);
    expect(database.prepare('SELECT 1 AS a; ').sourceSQL).toBe('SELECT 1 AS a;');
    expect(() => new sqlite.DatabaseSync(':memory:', { allowExtension: true })).toThrow(unsupported);
    expect(() => new sqlite.DatabaseSync(':memory:', { enableDoubleQuotedStringLiterals: true })).toThrow(unsupported);
    database.close();
  });

  test('keeps separate connections to one file consistent and serializes their writes', () => {
    const { sqlite, fileSystem } = loadSqlite();
    const first = new sqlite.DatabaseSync('/home/project/shared.db');
    const second = new sqlite.DatabaseSync('/home/project/shared.db');
    first.exec('CREATE TABLE t (value INTEGER)');
    first.prepare('INSERT INTO t VALUES (?)').run(1);
    expect(second.prepare('SELECT value FROM t').all()).toEqual([{ value: 1 }]);

    first.exec('BEGIN IMMEDIATE');
    expect(() => second.exec('INSERT INTO t VALUES (2)')).toThrow(
      expect.objectContaining({ code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' })
    );
    first.exec('INSERT INTO t VALUES (3); COMMIT');
    second.exec('INSERT INTO t VALUES (4)');
    expect(first.prepare('SELECT value FROM t ORDER BY value').all()).toEqual([{ value: 1 }, { value: 3 }, { value: 4 }]);
    first.close();
    second.close();
    expect(fileSystem.readdirSync('/home/project').sort()).toEqual(['shared.db']);
  });
});

function loadSqlite(): { readonly sqlite: SqliteBuiltin; readonly fileSystem: VirtualFileSystem } {
  const fileSystem = new VirtualFileSystem('/home/project');
  const compatibility = createNodeCompatibilityHarness({
    fileSystem,
    globals: nodeCompatibilityGlobals(),
    scriptEvaluator: { evaluate: (source, options) => runInThisContext(source, { filename: options?.filename }) }
  });
  const loaded = compatibility.builtinModuleProvider.load('node:sqlite');
  if (!loaded.found) throw new Error('node:sqlite was not found');
  return { sqlite: loaded.module as SqliteBuiltin, fileSystem };
}

function nodeCompatibilityGlobals(): NodeCompatibilityGlobals {
  return {
    process: {
      arch: 'wasm32',
      platform: 'browser',
      version: 'v22.22.3',
      versions: { node: '22.22.3' },
      release: {
        name: 'node',
        lts: 'Jod',
        sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz',
        headersUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'
      }
    },
    console,
    Buffer: BrowserBuffer,
    URL,
    URLSearchParams,
    TextEncoder,
    TextDecoder,
    WebSocket,
    MessageChannel,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    setImmediate,
    clearImmediate,
    queueMicrotask
  };
}

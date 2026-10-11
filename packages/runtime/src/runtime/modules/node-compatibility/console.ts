import { formatWithOptions, inspect, type InspectOptions } from './inspect';

export interface NodeConsoleStream {
  write(chunk: string): unknown;
}

export interface NodeConsoleOptions {
  readonly stdout: NodeConsoleStream;
  readonly stderr?: NodeConsoleStream;
  readonly inspectOptions?: InspectOptions;
  readonly groupIndentation?: number;
}

export interface NodeConsole {
  log(...values: unknown[]): void;
  info(...values: unknown[]): void;
  debug(...values: unknown[]): void;
  error(...values: unknown[]): void;
  warn(...values: unknown[]): void;
  trace(...values: unknown[]): void;
  assert(condition?: unknown, ...values: unknown[]): void;
  dir(value?: unknown, options?: InspectOptions): void;
  dirxml(...values: unknown[]): void;
  table(data?: unknown, columns?: readonly string[]): void;
  group(...values: unknown[]): void;
  groupCollapsed(...values: unknown[]): void;
  groupEnd(): void;
  time(label?: string): void;
  timeLog(label?: string, ...values: unknown[]): void;
  timeEnd(label?: string): void;
  count(label?: string): void;
  countReset(label?: string): void;
  clear(): void;
  profile(): void;
  profileEnd(): void;
  timeStamp(): void;
  Console: new (options: NodeConsoleOptions | NodeConsoleStream, stderr?: NodeConsoleStream) => NodeConsole;
}

function now(): number {
  return typeof performance === 'undefined' ? Date.now() : performance.now();
}

function formatDuration(milliseconds: number): string {
  if (milliseconds >= 3_600_000) return `${(milliseconds / 3_600_000).toFixed(3)}h`;
  if (milliseconds >= 60_000) return `${(milliseconds / 60_000).toFixed(3)}min`;
  if (milliseconds >= 1_000) return `${(milliseconds / 1_000).toFixed(3)}s`;
  return `${milliseconds.toFixed(3)}ms`;
}

function renderTable(head: readonly string[], rows: readonly (readonly string[])[]): string {
  const widths = head.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => (row[column] ?? '').length)) + 2
  );
  const line = (cells: readonly string[]) =>
    `│${widths.map((width, column) => ` ${(cells[column] ?? '').padEnd(width - 1)}`).join('│')}│`;
  const rule = (left: string, middle: string, right: string) =>
    `${left}${widths.map((width) => '─'.repeat(width)).join(middle)}${right}`;
  return [
    rule('┌', '┬', '┐'),
    line(head),
    rule('├', '┼', '┤'),
    ...rows.map(line),
    rule('└', '┴', '┘')
  ].join('\n');
}

/**
 * A Node `console` that formats through `util.format` and writes to the
 * given streams. Every method is bound, so it can be detached and called.
 */
export function createNodeConsole(options: NodeConsoleOptions): NodeConsole {
  const stdout = options.stdout;
  const stderr = options.stderr ?? options.stdout;
  const inspectOptions = options.inspectOptions ?? {};
  const groupIndentation = options.groupIndentation ?? 2;
  const timers = new Map<string, number>();
  const counts = new Map<string, number>();
  let indent = '';

  const write = (stream: NodeConsoleStream, text: string) => {
    const indented = indent === '' ? text : `${indent}${text.replaceAll('\n', `\n${indent}`)}`;
    stream.write(`${indented}\n`);
  };
  const format = (values: unknown[]) => formatWithOptions(inspectOptions, ...values);
  const log = (...values: unknown[]) => write(stdout, format(values));
  const warn = (...values: unknown[]) => write(stderr, format(values));
  const tableCell = (value: unknown) =>
    inspect(value, { ...inspectOptions, depth: value !== null && typeof value === 'object' ? 0 : 1, maxArrayLength: 3, breakLength: Infinity });

  const nodeConsole: NodeConsole = {
    log,
    info: log,
    debug: log,
    error: warn,
    warn,
    trace: (...values) => {
      const error = new Error(format(values));
      error.name = 'Trace';
      write(stderr, error.stack ?? `Trace: ${error.message}`);
    },
    assert: (condition, ...values) => {
      if (condition) return;
      if (typeof values[0] === 'string') values[0] = `Assertion failed: ${values[0]}`;
      else values.unshift('Assertion failed');
      warn(...values);
    },
    dir: (value, dirOptions) => write(stdout, inspect(value, { customInspect: false, ...inspectOptions, ...dirOptions })),
    dirxml: log,
    table: (data, columns) => {
      if (data === null || typeof data !== 'object') {
        log(data);
        return;
      }
      const indexHeader = '(index)';
      const valueHeader = 'Values';
      const entries: [string, unknown][] =
        data instanceof Map
          ? [...data].map(([key, value], index) => [String(index), [key, value]] as [string, unknown])
          : data instanceof Set
            ? [...data].map((value, index) => [String(index), value] as [string, unknown])
            : Object.entries(data);
      const keys: string[] = [];
      let hasPrimitive = false;
      for (const [, row] of entries) {
        if (row === null || typeof row !== 'object') {
          hasPrimitive = true;
          continue;
        }
        for (const key of Object.keys(row)) {
          if (!keys.includes(key) && (!columns || columns.includes(key))) keys.push(key);
        }
      }
      const head = [indexHeader, ...(columns ?? keys), ...(hasPrimitive ? [valueHeader] : [])];
      const rows = entries.map(([index, row]) => {
        const isObject = row !== null && typeof row === 'object';
        return [
          index,
          ...(columns ?? keys).map((key) =>
            isObject && Object.hasOwn(row, key) ? tableCell((row as Record<string, unknown>)[key]) : ''
          ),
          ...(hasPrimitive ? [isObject ? '' : tableCell(row)] : [])
        ];
      });
      write(stdout, renderTable(head, rows));
    },
    group: (...values) => {
      if (values.length > 0) log(...values);
      indent += ' '.repeat(groupIndentation);
    },
    groupCollapsed: (...values) => nodeConsole.group(...values),
    groupEnd: () => {
      indent = indent.slice(0, Math.max(0, indent.length - groupIndentation));
    },
    time: (label = 'default') => {
      const key = String(label);
      if (timers.has(key)) {
        warn(`Warning: Label '${key}' already exists for console.time()`);
        return;
      }
      timers.set(key, now());
    },
    timeLog: (label = 'default', ...values) => {
      const key = String(label);
      const started = timers.get(key);
      if (started === undefined) {
        warn(`Warning: No such label '${key}' for console.timeLog()`);
        return;
      }
      log(`${key}: ${formatDuration(now() - started)}`, ...values);
    },
    timeEnd: (label = 'default') => {
      const key = String(label);
      const started = timers.get(key);
      if (started === undefined) {
        warn(`Warning: No such label '${key}' for console.timeEnd()`);
        return;
      }
      timers.delete(key);
      log(`${key}: ${formatDuration(now() - started)}`);
    },
    count: (label = 'default') => {
      const key = String(label);
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      log(`${key}: ${count}`);
    },
    countReset: (label = 'default') => {
      const key = String(label);
      if (!counts.has(key)) {
        warn(`Warning: Count for '${key}' does not exist`);
        return;
      }
      counts.delete(key);
    },
    clear: () => undefined,
    profile: () => undefined,
    profileEnd: () => undefined,
    timeStamp: () => undefined,
    Console: NodeConsoleConstructor
  };
  return nodeConsole;
}

const consoleInstances = new WeakMap<object, NodeConsole>();
type ConsoleMethod = Exclude<keyof NodeConsole, 'Console'>;

/**
 * `console.Console`. As in Node, its methods live on `Console.prototype` and
 * are bound to each instance, so a subclass overrides them and reaches the
 * originals through `super`, as Jest's consoles do.
 */
const NodeConsoleConstructor = function Console(
  this: Record<string, unknown>,
  consoleOptions: NodeConsoleOptions | NodeConsoleStream,
  errorStream?: NodeConsoleStream
): unknown {
  if (!new.target) return new (NodeConsoleConstructor as unknown as new (...args: unknown[]) => unknown)(consoleOptions, errorStream);
  consoleInstances.set(
    this,
    createNodeConsole('stdout' in consoleOptions ? consoleOptions : { stdout: consoleOptions, stderr: errorStream })
  );
  for (const name of CONSOLE_METHODS) {
    const method = this[name];
    if (typeof method === 'function') {
      Object.defineProperty(this, name, { configurable: true, enumerable: true, writable: true, value: method.bind(this) });
    }
  }
  return undefined;
} as unknown as NodeConsole['Console'];

const CONSOLE_METHODS = Object.keys(
  createNodeConsole({ stdout: { write: () => true } })
).filter((name): name is ConsoleMethod => name !== 'Console');

for (const name of CONSOLE_METHODS) {
  Object.defineProperty(NodeConsoleConstructor.prototype, name, {
    configurable: true,
    writable: true,
    value: function (this: object, ...values: unknown[]): unknown {
      const instance = consoleInstances.get(this);
      if (!instance) throw new TypeError(`Console.prototype.${name} called on an object that is not a Console`);
      return (instance[name] as (...args: unknown[]) => unknown)(...values);
    }
  });
}

import { posixBasename, posixDirname, resolvePosixPath } from './posix-path';

type MaybePromise<Value> = Value | Promise<Value>;

export interface CoreUtilityFileStatus {
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
  readonly size: number;
  readonly mtimeMs: number;
  readonly mode: number;
}

/** The filesystem surface the core utilities need; every path is absolute. */
export interface CoreUtilityFileSystem {
  /** Resolves to `undefined` when the path does not exist. */
  stat(
    path: string,
    options?: { readonly followSymlinks?: boolean }
  ): MaybePromise<CoreUtilityFileStatus | undefined>;
  readFile(path: string): MaybePromise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): MaybePromise<void>;
  readDirectory(path: string): MaybePromise<readonly string[]>;
  makeDirectory(path: string, options: { readonly recursive: boolean }): MaybePromise<void>;
  remove(path: string, options: { readonly recursive: boolean }): MaybePromise<void>;
  rename(from: string, to: string): MaybePromise<void>;
  setModifiedTime(path: string, mtimeMs: number): MaybePromise<void>;
  readLink(path: string): MaybePromise<string>;
  symlink(target: string, path: string): MaybePromise<void>;
}

export interface CoreUtilityWriter {
  write(chunk: string | Uint8Array): void | Promise<void>;
}

export interface CoreUtilityContext {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly stdin: { read(): Promise<Uint8Array | undefined> };
  readonly stdout: CoreUtilityWriter;
  readonly stderr: CoreUtilityWriter;
  readonly fileSystem: CoreUtilityFileSystem;
  /** Runs `argv` in place of the utility with the given environment (`env command ...`). */
  readonly exec?: (argv: readonly string[], env: Readonly<Record<string, string>>) => Promise<number>;
}

export interface CoreUtility {
  readonly id: string;
  readonly commands: readonly string[];
  run(args: readonly string[], context: CoreUtilityContext): Promise<number>;
}

/** Commands `which` reports even though no file backs them. */
export type CoreUtilityCommandCatalog = () => readonly (readonly string[])[];

type ParsedOptions =
  | { readonly ok: true; readonly flags: ReadonlySet<string>; readonly values: ReadonlyMap<string, string>; readonly operands: readonly string[] }
  | { readonly ok: false; readonly message: string };

function parseOptions(
  args: readonly string[],
  spec: {
    readonly flags: string;
    readonly valued?: string;
    readonly long?: Readonly<Record<string, string>>;
  }
): ParsedOptions {
  const flags = new Set<string>();
  const values = new Map<string, string>();
  const operands: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === '--') {
      operands.push(...args.slice(index + 1));
      break;
    }
    if (argument.startsWith('--')) {
      const flag = spec.long?.[argument.slice(2)];
      if (!flag) return { ok: false, message: `unrecognized option '${argument}'` };
      flags.add(flag);
      continue;
    }
    if (!argument.startsWith('-') || argument === '-') {
      operands.push(argument);
      continue;
    }
    for (let offset = 1; offset < argument.length; offset += 1) {
      const flag = argument[offset]!;
      if (spec.valued?.includes(flag)) {
        const value = argument.slice(offset + 1) || args[(index += 1)];
        if (value === undefined) return { ok: false, message: `option requires an argument -- '${flag}'` };
        values.set(flag, value);
        break;
      }
      if (!spec.flags.includes(flag)) return { ok: false, message: `invalid option -- '${flag}'` };
      flags.add(flag);
    }
  }
  return { ok: true, flags, values, operands };
}

function describeFailure(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  switch (code) {
    case 'ENOENT':
    case 'NOT_FOUND':
      return 'No such file or directory';
    case 'EEXIST':
    case 'ALREADY_EXISTS':
      return 'File exists';
    case 'ENOTDIR':
    case 'NOT_A_DIRECTORY':
      return 'Not a directory';
    case 'EISDIR':
    case 'IS_A_DIRECTORY':
      return 'Is a directory';
    case 'ENOTEMPTY':
    case 'NOT_EMPTY':
      return 'Directory not empty';
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

class Reporter {
  failed = false;

  constructor(
    private readonly name: string,
    private readonly context: CoreUtilityContext
  ) {}

  async error(message: string): Promise<void> {
    this.failed = true;
    await this.context.stderr.write(`${this.name}: ${message}\n`);
  }

  async usage(message: string): Promise<number> {
    await this.context.stderr.write(`${this.name}: ${message}\n`);
    return 2;
  }
}

/** Interprets `echo` arguments; shared by the Runtime Program and the Shell Program builtin. */
export function formatEcho(args: readonly string[]): string {
  let newline = true;
  let escapes = false;
  let index = 0;
  for (; index < args.length; index += 1) {
    const argument = args[index]!;
    if (!/^-[neE]+$/.test(argument)) break;
    for (const flag of argument.slice(1)) {
      if (flag === 'n') newline = false;
      else escapes = flag === 'e';
    }
  }
  let text = args.slice(index).join(' ');
  if (escapes) {
    const expanded = expandBackslashEscapes(text, true);
    text = expanded.text;
    if (expanded.stop) newline = false;
  }
  return newline ? `${text}\n` : text;
}

/** Expands `\n`-style escapes; `\c` stops all further output when `allowStop` is set. */
export function expandBackslashEscapes(
  text: string,
  allowStop: boolean
): { readonly text: string; readonly stop: boolean } {
  const simple: Readonly<Record<string, string>> = {
    a: '\x07',
    b: '\b',
    e: '\x1b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\'
  };
  let result = '';
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!;
    const escaped = text[index + 1];
    if (character !== '\\' || escaped === undefined) {
      result += character;
      continue;
    }
    if (escaped === 'c' && allowStop) return { text: result, stop: true };
    if (simple[escaped] !== undefined) {
      result += simple[escaped];
      index += 1;
      continue;
    }
    const numeric =
      escaped === '0'
        ? /^0[0-7]{0,3}/.exec(text.slice(index + 1))
        : escaped === 'x'
          ? /^x[0-9a-fA-F]{1,2}/.exec(text.slice(index + 1))
          : undefined;
    if (numeric) {
      const digits = numeric[0].slice(1);
      result += String.fromCharCode(digits === '' ? 0 : parseInt(digits, escaped === 'x' ? 16 : 8));
      index += numeric[0].length;
      continue;
    }
    result += character;
  }
  return { text: result, stop: false };
}

const echo: CoreUtility = {
  id: 'echo',
  commands: ['echo', '/bin/echo'],
  async run(args, context) {
    await context.stdout.write(formatEcho(args));
    return 0;
  }
};

const cat: CoreUtility = {
  id: 'cat',
  commands: ['cat', '/bin/cat'],
  async run(args, context) {
    const report = new Reporter('cat', context);
    const options = parseOptions(args, { flags: 'nu' });
    if (!options.ok) return report.usage(options.message);
    let line = 1;
    let atLineStart = true;
    const decoder = new TextDecoder();
    const emit = async (chunk: Uint8Array, last: boolean): Promise<void> => {
      if (!options.flags.has('n')) {
        if (chunk.byteLength > 0) await context.stdout.write(chunk);
        return;
      }
      let numbered = '';
      for (const character of decoder.decode(chunk, { stream: !last })) {
        if (atLineStart) numbered += `${String(line++).padStart(6)}\t`;
        numbered += character;
        atLineStart = character === '\n';
      }
      if (numbered !== '') await context.stdout.write(numbered);
    };
    for (const operand of options.operands.length === 0 ? ['-'] : options.operands) {
      if (operand === '-') {
        for (let chunk = await context.stdin.read(); chunk; chunk = await context.stdin.read()) {
          await emit(chunk, false);
        }
        continue;
      }
      const path = resolvePosixPath(operand, context.cwd);
      try {
        const status = await context.fileSystem.stat(path);
        if (!status) await report.error(`${operand}: No such file or directory`);
        else if (status.kind === 'directory') await report.error(`${operand}: Is a directory`);
        else await emit(await context.fileSystem.readFile(path), false);
      } catch (error) {
        await report.error(`${operand}: ${describeFailure(error)}`);
      }
    }
    await emit(new Uint8Array(), true);
    return report.failed ? 1 : 0;
  }
};

const rm: CoreUtility = {
  id: 'rm',
  commands: ['rm', '/bin/rm'],
  async run(args, context) {
    const report = new Reporter('rm', context);
    const options = parseOptions(args, {
      flags: 'rRfdv',
      long: { recursive: 'r', force: 'f', dir: 'd', verbose: 'v' }
    });
    if (!options.ok) return report.usage(options.message);
    const recursive = options.flags.has('r') || options.flags.has('R');
    const force = options.flags.has('f');
    if (options.operands.length === 0) return force ? 0 : report.usage('missing operand');
    for (const operand of options.operands) {
      const path = resolvePosixPath(operand, context.cwd);
      if (path === '/') {
        await report.error("it is dangerous to operate recursively on '/'");
        continue;
      }
      try {
        const status = await context.fileSystem.stat(path, { followSymlinks: false });
        if (!status) {
          if (!force) await report.error(`cannot remove '${operand}': No such file or directory`);
          continue;
        }
        if (status.kind === 'directory' && !recursive) {
          const removable =
            options.flags.has('d') && (await context.fileSystem.readDirectory(path)).length === 0;
          if (!removable) {
            await report.error(
              `cannot remove '${operand}': ${options.flags.has('d') ? 'Directory not empty' : 'Is a directory'}`
            );
            continue;
          }
        }
        await context.fileSystem.remove(path, { recursive: status.kind === 'directory' });
        if (options.flags.has('v')) await context.stdout.write(`removed '${operand}'\n`);
      } catch (error) {
        await report.error(`cannot remove '${operand}': ${describeFailure(error)}`);
      }
    }
    return report.failed ? 1 : 0;
  }
};

const mkdir: CoreUtility = {
  id: 'mkdir',
  commands: ['mkdir', '/bin/mkdir'],
  async run(args, context) {
    const report = new Reporter('mkdir', context);
    const options = parseOptions(args, {
      flags: 'pv',
      valued: 'm',
      long: { parents: 'p', verbose: 'v' }
    });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length === 0) return report.usage('missing operand');
    const parents = options.flags.has('p');
    for (const operand of options.operands) {
      const path = resolvePosixPath(operand, context.cwd);
      try {
        const status = await context.fileSystem.stat(path);
        if (status) {
          if (!parents || status.kind !== 'directory') {
            await report.error(`cannot create directory '${operand}': File exists`);
          }
          continue;
        }
        if (!parents && (await context.fileSystem.stat(posixDirname(path)))?.kind !== 'directory') {
          await report.error(`cannot create directory '${operand}': No such file or directory`);
          continue;
        }
        await context.fileSystem.makeDirectory(path, { recursive: parents });
        if (options.flags.has('v')) await context.stdout.write(`mkdir: created directory '${operand}'\n`);
      } catch (error) {
        await report.error(`cannot create directory '${operand}': ${describeFailure(error)}`);
      }
    }
    return report.failed ? 1 : 0;
  }
};

const touch: CoreUtility = {
  id: 'touch',
  commands: ['touch', '/bin/touch', '/usr/bin/touch'],
  async run(args, context) {
    const report = new Reporter('touch', context);
    const options = parseOptions(args, { flags: 'acm', long: { 'no-create': 'c' } });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length === 0) return report.usage('missing file operand');
    for (const operand of options.operands) {
      const path = resolvePosixPath(operand, context.cwd);
      try {
        if (await context.fileSystem.stat(path)) {
          await context.fileSystem.setModifiedTime(path, Date.now());
        } else if (!options.flags.has('c')) {
          await context.fileSystem.writeFile(path, new Uint8Array());
        }
      } catch (error) {
        await report.error(`cannot touch '${operand}': ${describeFailure(error)}`);
      }
    }
    return report.failed ? 1 : 0;
  }
};

/** Resolves `source... destination` operands into per-source targets, as `cp` and `mv` do. */
async function resolveTransferTargets(
  operands: readonly string[],
  context: CoreUtilityContext,
  report: Reporter
): Promise<readonly { readonly operand: string; readonly from: string; readonly to: string }[] | undefined> {
  const destinationOperand = operands.at(-1)!;
  const destination = resolvePosixPath(destinationOperand, context.cwd);
  const sources = operands.slice(0, -1);
  const intoDirectory = (await context.fileSystem.stat(destination))?.kind === 'directory';
  if (!intoDirectory && (sources.length > 1 || destinationOperand.endsWith('/'))) {
    await report.error(`target '${destinationOperand}' is not a directory`);
    return undefined;
  }
  return sources.map((operand) => {
    const from = resolvePosixPath(operand, context.cwd);
    return {
      operand,
      from,
      to: intoDirectory ? resolvePosixPath(posixBasename(from), destination) : destination
    };
  });
}

function isInside(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor === '/' ? '/' : `${ancestor}/`);
}

const cp: CoreUtility = {
  id: 'cp',
  commands: ['cp', '/bin/cp'],
  async run(args, context) {
    const report = new Reporter('cp', context);
    const options = parseOptions(args, {
      flags: 'rRafpvnLPd',
      long: { recursive: 'r', archive: 'a', force: 'f', verbose: 'v', 'no-clobber': 'n' }
    });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length < 2) {
      return report.usage(
        options.operands.length === 0
          ? 'missing file operand'
          : `missing destination file operand after '${options.operands[0]}'`
      );
    }
    const recursive = ['r', 'R', 'a'].some((flag) => options.flags.has(flag));
    const preserveLinks = recursive && !options.flags.has('L');
    const targets = await resolveTransferTargets(options.operands, context, report);
    if (!targets) return 1;
    const fileSystem = context.fileSystem;

    const copy = async (from: string, to: string, operand: string): Promise<void> => {
      const status = await fileSystem.stat(from, { followSymlinks: !preserveLinks });
      if (!status) {
        await report.error(`cannot stat '${operand}': No such file or directory`);
        return;
      }
      if (status.kind === 'directory') {
        if (!recursive) {
          await report.error(`-r not specified; omitting directory '${operand}'`);
          return;
        }
        if (isInside(to, from)) {
          await report.error(`cannot copy a directory, '${operand}', into itself`);
          return;
        }
        const existing = await fileSystem.stat(to);
        if (existing && existing.kind !== 'directory') {
          await report.error(`cannot overwrite non-directory '${to}' with directory '${operand}'`);
          return;
        }
        if (!existing) await fileSystem.makeDirectory(to, { recursive: true });
        for (const name of await fileSystem.readDirectory(from)) {
          await copy(`${from}/${name}`, `${to}/${name}`, `${operand}/${name}`);
        }
        return;
      }
      if (from === to) {
        await report.error(`'${operand}' and '${operand}' are the same file`);
        return;
      }
      const existing = await fileSystem.stat(to, { followSymlinks: false });
      if (existing && options.flags.has('n')) return;
      if (existing?.kind === 'directory') {
        await report.error(`cannot overwrite directory '${to}' with non-directory`);
        return;
      }
      if (status.kind === 'symlink') {
        if (existing) await fileSystem.remove(to, { recursive: false });
        await fileSystem.symlink(await fileSystem.readLink(from), to);
      } else {
        await fileSystem.writeFile(to, await fileSystem.readFile(from));
        if (options.flags.has('p') || options.flags.has('a')) {
          await fileSystem.setModifiedTime(to, status.mtimeMs);
        }
      }
      if (options.flags.has('v')) await context.stdout.write(`'${operand}' -> '${to}'\n`);
    };

    for (const target of targets) {
      try {
        await copy(target.from, target.to, target.operand);
      } catch (error) {
        await report.error(`cannot copy '${target.operand}': ${describeFailure(error)}`);
      }
    }
    return report.failed ? 1 : 0;
  }
};

const mv: CoreUtility = {
  id: 'mv',
  commands: ['mv', '/bin/mv'],
  async run(args, context) {
    const report = new Reporter('mv', context);
    const options = parseOptions(args, {
      flags: 'fnv',
      long: { force: 'f', 'no-clobber': 'n', verbose: 'v' }
    });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length < 2) {
      return report.usage(
        options.operands.length === 0
          ? 'missing file operand'
          : `missing destination file operand after '${options.operands[0]}'`
      );
    }
    const targets = await resolveTransferTargets(options.operands, context, report);
    if (!targets) return 1;
    for (const { operand, from, to } of targets) {
      try {
        const status = await context.fileSystem.stat(from, { followSymlinks: false });
        if (!status) {
          await report.error(`cannot stat '${operand}': No such file or directory`);
          continue;
        }
        if (from === to) continue;
        if (status.kind === 'directory' && isInside(to, from)) {
          await report.error(`cannot move '${operand}' to a subdirectory of itself, '${to}'`);
          continue;
        }
        const existing = await context.fileSystem.stat(to, { followSymlinks: false });
        if (existing && options.flags.has('n')) continue;
        if (existing?.kind === 'directory' && status.kind !== 'directory') {
          await report.error(`cannot overwrite directory '${to}' with non-directory`);
          continue;
        }
        await context.fileSystem.rename(from, to);
        if (options.flags.has('v')) await context.stdout.write(`renamed '${operand}' -> '${to}'\n`);
      } catch (error) {
        await report.error(`cannot move '${operand}': ${describeFailure(error)}`);
      }
    }
    return report.failed ? 1 : 0;
  }
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatMode(status: CoreUtilityFileStatus): string {
  const type = status.kind === 'directory' ? 'd' : status.kind === 'symlink' ? 'l' : '-';
  const bits = status.mode & 0o777;
  let permissions = '';
  for (let shift = 6; shift >= 0; shift -= 3) {
    const triplet = (bits >> shift) & 0o7;
    permissions += `${triplet & 4 ? 'r' : '-'}${triplet & 2 ? 'w' : '-'}${triplet & 1 ? 'x' : '-'}`;
  }
  return `${type}${permissions}`;
}

function formatTimestamp(mtimeMs: number): string {
  const date = new Date(mtimeMs);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${MONTHS[date.getMonth()]} ${String(date.getDate()).padStart(2)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

const ls: CoreUtility = {
  id: 'ls',
  commands: ['ls', '/bin/ls'],
  async run(args, context) {
    const report = new Reporter('ls', context);
    const options = parseOptions(args, {
      flags: 'aAl1dFRhp',
      long: { all: 'a', 'almost-all': 'A', recursive: 'R', directory: 'd', classify: 'F' }
    });
    if (!options.ok) return report.usage(options.message);
    const fileSystem = context.fileSystem;
    const long = options.flags.has('l');
    const lines: string[] = [];

    const describeEntry = async (name: string, path: string): Promise<string> => {
      const status = await fileSystem.stat(path, { followSymlinks: false });
      const marker =
        status?.kind === 'directory' && (options.flags.has('F') || options.flags.has('p'))
          ? '/'
          : status?.kind === 'symlink' && options.flags.has('F') && !long
            ? '@'
            : status?.kind === 'file' && options.flags.has('F') && status.mode & 0o111
              ? '*'
              : '';
      if (!long || !status) return `${name}${marker}`;
      const link = status.kind === 'symlink' ? ` -> ${await fileSystem.readLink(path)}` : '';
      return `${formatMode(status)} 1 user user ${String(status.size).padStart(8)} ${formatTimestamp(status.mtimeMs)} ${name}${marker}${link}`;
    };

    const listDirectory = async (path: string, label: string, heading: boolean): Promise<void> => {
      const names = [...(await fileSystem.readDirectory(path))]
        .filter((name) => options.flags.has('a') || options.flags.has('A') || !name.startsWith('.'))
        .sort();
      if (heading) lines.push(`${label}:`);
      if (options.flags.has('a')) lines.push(...(long ? [] : ['.', '..']));
      for (const name of names) lines.push(await describeEntry(name, resolvePosixPath(name, path)));
      if (!options.flags.has('R')) return;
      for (const name of names) {
        const child = resolvePosixPath(name, path);
        if ((await fileSystem.stat(child, { followSymlinks: false }))?.kind !== 'directory') continue;
        lines.push('');
        await listDirectory(child, `${label.replace(/\/$/, '')}/${name}`, true);
      }
    };

    const operands = options.operands.length === 0 ? ['.'] : [...options.operands].sort();
    const files: string[] = [];
    const directories: string[] = [];
    for (const operand of operands) {
      const status = await fileSystem.stat(resolvePosixPath(operand, context.cwd));
      if (!status) await report.error(`cannot access '${operand}': No such file or directory`);
      else if (status.kind === 'directory' && !options.flags.has('d')) directories.push(operand);
      else files.push(operand);
    }
    for (const operand of files) {
      lines.push(await describeEntry(operand, resolvePosixPath(operand, context.cwd)));
    }
    const heading = operands.length > 1 || options.flags.has('R');
    for (const [index, operand] of directories.entries()) {
      if (index > 0 || files.length > 0) lines.push('');
      try {
        await listDirectory(resolvePosixPath(operand, context.cwd), operand, heading);
      } catch (error) {
        await report.error(`cannot open directory '${operand}': ${describeFailure(error)}`);
      }
    }
    if (lines.length > 0) await context.stdout.write(`${lines.join('\n')}\n`);
    return report.failed ? 2 : 0;
  }
};

const env: CoreUtility = {
  id: 'env',
  commands: ['env', '/usr/bin/env'],
  async run(args, context) {
    const report = new Reporter('env', context);
    let environment: Record<string, string> = { ...context.env };
    let index = 0;
    for (; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === '--') {
        index += 1;
        break;
      }
      if (argument === '-i' || argument === '-' || argument === '--ignore-environment') {
        environment = {};
      } else if (argument === '-u' || argument === '--unset') {
        const name = args[(index += 1)];
        if (name === undefined) return report.usage("option requires an argument -- 'u'");
        delete environment[name];
      } else if (argument.startsWith('-u') && argument.length > 2) {
        delete environment[argument.slice(2)];
      } else if (argument.startsWith('-') && argument.length > 1) {
        return report.usage(`invalid option -- '${argument.slice(1)}'`);
      } else {
        break;
      }
    }
    for (; index < args.length; index += 1) {
      const assignment = /^([^=]+)=([\s\S]*)$/.exec(args[index]!);
      if (!assignment) break;
      environment[assignment[1]!] = assignment[2]!;
    }
    const command = args.slice(index);
    if (command.length === 0) {
      const lines = Object.entries(environment).map(([name, value]) => `${name}=${value}\n`);
      await context.stdout.write(lines.join(''));
      return 0;
    }
    if (!context.exec) {
      await report.error(`'${command[0]}': cannot run a command in this context`);
      return 126;
    }
    return context.exec(command, environment);
  }
};

function createWhich(catalog: CoreUtilityCommandCatalog): CoreUtility {
  return {
    id: 'which',
    commands: ['which', '/usr/bin/which'],
    async run(args, context) {
      const report = new Reporter('which', context);
      const options = parseOptions(args, { flags: 'as', long: { all: 'a' } });
      if (!options.ok) return report.usage(options.message);
      let missing = options.operands.length === 0;
      const isFile = async (path: string): Promise<boolean> =>
        (await context.fileSystem.stat(path))?.kind === 'file';
      for (const name of options.operands) {
        const found: string[] = [];
        // Command resolution prefers a Runtime Program over a file of the same name on PATH.
        const program = catalog().find((commands) => commands.includes(name));
        if (program) found.push(program.find((command) => command.startsWith('/')) ?? name);
        if (name.includes('/')) {
          if (!program && (await isFile(resolvePosixPath(name, context.cwd)))) found.push(name);
        } else {
          for (const directory of (context.env.PATH ?? '').split(':')) {
            const candidate = resolvePosixPath(`${directory || '.'}/${name}`, context.cwd);
            if (await isFile(candidate)) found.push(candidate);
          }
        }
        if (found.length === 0) {
          missing = true;
          continue;
        }
        if (options.flags.has('s')) continue;
        const reported = options.flags.has('a') ? [...new Set(found)] : found.slice(0, 1);
        await context.stdout.write(reported.map((path) => `${path}\n`).join(''));
      }
      return missing ? 1 : 0;
    }
  };
}

const dirname: CoreUtility = {
  id: 'dirname',
  commands: ['dirname', '/usr/bin/dirname'],
  async run(args, context) {
    const report = new Reporter('dirname', context);
    const options = parseOptions(args, { flags: 'z', long: { zero: 'z' } });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length === 0) return report.usage('missing operand');
    const terminator = options.flags.has('z') ? '\0' : '\n';
    await context.stdout.write(
      options.operands.map((operand) => `${posixDirnameOf(operand)}${terminator}`).join('')
    );
    return 0;
  }
};

/** `dirname` of a relative or absolute operand, as POSIX specifies: `.` when it names no directory. */
function posixDirnameOf(operand: string): string {
  const trimmed = operand.replace(/\/+$/u, '');
  if (trimmed === '') return operand.startsWith('/') ? '/' : '.';
  const index = trimmed.lastIndexOf('/');
  if (index === -1) return '.';
  const parent = trimmed.slice(0, index).replace(/\/+$/u, '');
  return parent === '' ? '/' : parent;
}

const basename: CoreUtility = {
  id: 'basename',
  commands: ['basename', '/usr/bin/basename'],
  async run(args, context) {
    const report = new Reporter('basename', context);
    const options = parseOptions(args, { flags: 'az', valued: 's', long: { multiple: 'a', zero: 'z' } });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length === 0) return report.usage('missing operand');
    const terminator = options.flags.has('z') ? '\0' : '\n';
    const suffix = options.values.get('s');
    const multiple = options.flags.has('a') || suffix !== undefined;
    const names = multiple ? options.operands : options.operands.slice(0, 1);
    const trailing = multiple ? suffix : options.operands[1];
    if (!multiple && options.operands.length > 2) {
      return report.usage(`extra operand '${options.operands[2]}'`);
    }
    const lines = names.map((operand) => {
      let name = posixBasename(operand) || (operand.startsWith('/') ? '/' : '');
      if (trailing && name !== trailing && name.endsWith(trailing)) name = name.slice(0, -trailing.length);
      return `${name}${terminator}`;
    });
    await context.stdout.write(lines.join(''));
    return 0;
  }
};

/** What `uname` reports: the Linux identity of ADR-0039, as `node:os` reports it. */
const UNAME = Object.freeze({
  kernel: 'Linux',
  node: 'mimic',
  release: '0.0.0',
  version: '#1 Mimic',
  machine: 'wasm32',
  operatingSystem: 'GNU/Linux'
});

/**
 * The native addon build, as `node-gyp` runs it, and where it ends here: the
 * runtime has no C/C++ toolchain and no Python, and no addon built for one
 * would load in a browser. A build reports that the package stays without its
 * native addon and succeeds, so the install goes on and the package decides
 * at run time whether it can do without it (a JavaScript fallback, a cache it
 * disables) rather than failing the whole install (ADR-0040).
 */
const nodeGyp: CoreUtility = {
  id: 'node-gyp',
  commands: ['node-gyp'],
  async run(args, context) {
    const { command, directory } = nodeGypInvocation(args, context.cwd);
    if (args.includes('-v') || args.includes('--version')) {
      await context.stdout.write(`v${NODE_GYP_REPORTED_VERSION}\n`);
      return 0;
    }
    if (command === undefined || command === 'help') {
      await context.stdout.write('usage: node-gyp <command>: no native toolchain in Mimic\n');
      return 0;
    }
    // node-gyp's build directory comes and goes as it would: tools that wrap
    // the build move it (node-pre-gyp renames it per N-API version), and it
    // holds no addon.
    const buildDirectory = resolvePosixPath('build', directory);
    if (command === 'clean' || command === 'rebuild') {
      try {
        await context.fileSystem.remove(buildDirectory, { recursive: true });
      } catch {
        // Nothing was built.
      }
    }
    if (['build', 'rebuild', 'configure', 'install'].includes(command)) {
      const name = await packageName(context, directory);
      await context.stderr.write(
        `gyp info Mimic has no native toolchain (linux/wasm32): ` +
          `${name ?? directory} stays without its native addon\n`
      );
    }
    if (command === 'configure' || command === 'rebuild') {
      await context.fileSystem.makeDirectory(buildDirectory, { recursive: true });
      await context.fileSystem.writeFile(
        `${buildDirectory}/config.gypi`,
        new TextEncoder().encode('# Mimic has no native toolchain: nothing is built here.\n{}\n')
      );
    }
    // `list` and `remove` have nothing to act on.
    return 0;
  }
};

/** The release whose command line the native build answers to. */
const NODE_GYP_REPORTED_VERSION = '11.0.0';

/** The commands node-gyp takes; any other word on its command line is an option's value. */
const NODE_GYP_COMMANDS = new Set(['build', 'clean', 'configure', 'rebuild', 'install', 'list', 'remove', 'help']);

/**
 * The command a node-gyp command line names, and the directory it runs in:
 * `-C <dir>`, `--directory <dir>` or `--directory=<dir>`, else the working
 * directory.
 */
function nodeGypInvocation(
  args: readonly string[],
  cwd: string
): { readonly command: string | undefined; readonly directory: string } {
  let command: string | undefined;
  let directory = cwd;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if ((argument === '-C' || argument === '--directory') && index + 1 < args.length) {
      directory = resolvePosixPath(args[++index]!, cwd);
    } else if (argument.startsWith('--directory=')) {
      directory = resolvePosixPath(argument.slice('--directory='.length), cwd);
    } else if (command === undefined && NODE_GYP_COMMANDS.has(argument)) {
      command = argument;
    }
  }
  return { command, directory };
}

async function packageName(context: CoreUtilityContext, directory: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(new TextDecoder().decode(await context.fileSystem.readFile(resolvePosixPath('package.json', directory)))) as {
      name?: unknown;
      version?: unknown;
    };
    return typeof manifest.name === 'string'
      ? `${manifest.name}${typeof manifest.version === 'string' ? `@${manifest.version}` : ''}`
      : undefined;
  } catch {
    return undefined;
  }
}

const uname: CoreUtility = {
  id: 'uname',
  commands: ['uname', '/usr/bin/uname', '/bin/uname'],
  async run(args, context) {
    const report = new Reporter('uname', context);
    const options = parseOptions(args, {
      flags: 'asnrvmpio',
      long: {
        all: 'a',
        'kernel-name': 's',
        nodename: 'n',
        'kernel-release': 'r',
        'kernel-version': 'v',
        machine: 'm',
        processor: 'p',
        'hardware-platform': 'i',
        'operating-system': 'o'
      }
    });
    if (!options.ok) return report.usage(options.message);
    if (options.operands.length > 0) return report.usage(`extra operand '${options.operands[0]}'`);
    const all = options.flags.has('a');
    const parts = [
      ['s', UNAME.kernel],
      ['n', UNAME.node],
      ['r', UNAME.release],
      ['v', UNAME.version],
      ['m', UNAME.machine],
      ['p', UNAME.machine],
      ['i', UNAME.machine],
      ['o', UNAME.operatingSystem]
    ] as const;
    const selected = parts
      .filter(([flag]) => (all ? flag !== 'p' && flag !== 'i' : options.flags.has(flag)))
      .map(([, value]) => value);
    await context.stdout.write(`${(selected.length === 0 ? [UNAME.kernel] : selected).join(' ')}\n`);
    return 0;
  }
};

/**
 * The system variables programs ask `getconf` for: the word size of the
 * `wasm32` machine `uname` reports, which `arch` (clipboardy, Cypress's
 * installer) reads on Linux, and the processor count `os.cpus()` reports.
 */
const getconf: CoreUtility = {
  id: 'getconf',
  commands: ['getconf', '/usr/bin/getconf', '/bin/getconf'],
  async run(args, context) {
    const report = new Reporter('getconf', context);
    if (args.length !== 1) return report.usage('expected one system variable');
    const processors = () => String(globalThis.navigator?.hardwareConcurrency ?? 1);
    const variables: Readonly<Record<string, () => string>> = {
      LONG_BIT: () => '32',
      _NPROCESSORS_CONF: processors,
      _NPROCESSORS_ONLN: processors
    };
    const value = Object.hasOwn(variables, args[0]!) ? variables[args[0]!]!() : undefined;
    if (value === undefined) {
      await context.stderr.write(`getconf: Unrecognized variable '${args[0]}'\n`);
      return 1;
    }
    await context.stdout.write(`${value}\n`);
    return 0;
  }
};

type SedAddress =
  | { readonly kind: 'line'; readonly line: number }
  | { readonly kind: 'last' }
  | { readonly kind: 'pattern'; readonly pattern: RegExp };

type SedCommand = Readonly<{
  address?: SedAddress;
  negated: boolean;
  name: 's' | 'p' | 'd' | 'q';
  pattern?: RegExp;
  replacement?: string;
  global?: boolean;
  print?: boolean;
}>;

/**
 * The stream editor subset package scripts and the shims package managers
 * write use: `s` with any delimiter and the `g`, `i` and `p` flags, `p`, `d`
 * and `q`, each with an optional line, `$` or pattern address, over the input
 * files or standard input, in place with `-i`.
 */
const sed: CoreUtility = {
  id: 'sed',
  commands: ['sed', '/usr/bin/sed', '/bin/sed'],
  async run(args, context) {
    const report = new Reporter('sed', context);
    const scripts: string[] = [];
    const operands: string[] = [];
    let quiet = false;
    let extended = false;
    let inPlace: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      if (argument === '--') {
        operands.push(...args.slice(index + 1));
        break;
      }
      if (argument === '-n' || argument === '--quiet' || argument === '--silent') quiet = true;
      else if (argument === '-E' || argument === '-r' || argument === '--regexp-extended') extended = true;
      else if (argument === '-e' || argument === '--expression') {
        const script = args[(index += 1)];
        if (script === undefined) return report.usage("option requires an argument -- 'e'");
        scripts.push(script);
      } else if (argument.startsWith('--expression=')) scripts.push(argument.slice('--expression='.length));
      else if (argument.startsWith('-e') && argument.length > 2) scripts.push(argument.slice(2));
      else if (argument === '-i' || argument === '--in-place') inPlace = '';
      else if (argument.startsWith('-i') && argument.length > 2) inPlace = argument.slice(2);
      else if (argument.startsWith('--in-place=')) inPlace = argument.slice('--in-place='.length);
      else if (argument.startsWith('-') && argument.length > 1) return report.usage(`unknown option -- '${argument.slice(1)}'`);
      else operands.push(argument);
    }
    if (scripts.length === 0) {
      const script = operands.shift();
      if (script === undefined) return report.usage('no script given');
      scripts.push(script);
    }
    let commands: SedCommand[];
    try {
      commands = scripts.flatMap((script) => parseSedScript(script, extended));
    } catch (error) {
      await report.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
    const decoder = new TextDecoder();
    const readInput = async (): Promise<string> => {
      const chunks: Uint8Array[] = [];
      for (let chunk = await context.stdin.read(); chunk; chunk = await context.stdin.read()) chunks.push(chunk);
      return chunks.map((chunk, index) => decoder.decode(chunk, { stream: index < chunks.length - 1 })).join('');
    };
    const edit = (text: string): string => {
      const trailingNewline = text.endsWith('\n');
      const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n');
      if (text === '') lines.length = 0;
      const output: string[] = [];
      let quit = false;
      for (const [index, original] of lines.entries()) {
        let line = original;
        let deleted = false;
        for (const command of commands) {
          const matches = sedAddressMatches(command.address, line, index + 1, index === lines.length - 1);
          if (matches === command.negated) continue;
          if (command.name === 'd') {
            deleted = true;
            break;
          }
          if (command.name === 'p') output.push(line);
          else if (command.name === 'q') {
            quit = true;
            break;
          } else {
            const replaced = command.global
              ? line.replace(command.pattern!, command.replacement!)
              : replaceFirst(line, command.pattern!, command.replacement!);
            if (command.print && replaced !== line) output.push(replaced);
            line = replaced;
          }
        }
        if (!deleted && !quiet) output.push(line);
        if (quit) break;
      }
      return output.length === 0 ? '' : `${output.join('\n')}${trailingNewline || output.length > 0 ? '\n' : ''}`;
    };
    if (inPlace !== undefined) {
      if (operands.length === 0) return report.usage('no input files');
      for (const operand of operands) {
        const path = resolvePosixPath(operand, context.cwd);
        try {
          const source = decoder.decode(await context.fileSystem.readFile(path));
          if (inPlace !== '') await context.fileSystem.writeFile(`${path}${inPlace}`, new TextEncoder().encode(source));
          await context.fileSystem.writeFile(path, new TextEncoder().encode(edit(source)));
        } catch (error) {
          await report.error(`can't read ${operand}: ${describeFailure(error)}`);
        }
      }
      return report.failed ? 2 : 0;
    }
    for (const operand of operands.length === 0 ? ['-'] : operands) {
      let source: string;
      if (operand === '-') source = await readInput();
      else {
        try {
          source = decoder.decode(await context.fileSystem.readFile(resolvePosixPath(operand, context.cwd)));
        } catch (error) {
          await report.error(`can't read ${operand}: ${describeFailure(error)}`);
          continue;
        }
      }
      const output = edit(source);
      if (output !== '') await context.stdout.write(output);
    }
    return report.failed ? 2 : 0;
  }
};

function parseSedScript(script: string, extended: boolean): SedCommand[] {
  const commands: SedCommand[] = [];
  let index = 0;
  const skipBlanks = (): void => {
    while (index < script.length && /[\s;]/u.test(script[index]!)) index += 1;
  };
  const readDelimited = (delimiter: string): string => {
    let text = '';
    while (index < script.length && script[index] !== delimiter) {
      if (script[index] === '\\' && index + 1 < script.length) {
        // An escaped delimiter is the delimiter itself; other escapes stay for the regular expression.
        text += script[index + 1] === delimiter ? delimiter : `\\${script[index + 1]}`;
        index += 2;
      } else {
        text += script[index];
        index += 1;
      }
    }
    if (index >= script.length) throw new Error(`-e expression #1, char ${index}: unterminated \`s' command`);
    index += 1;
    return text;
  };
  const readAddress = (): SedAddress | undefined => {
    const character = script[index];
    if (character === undefined) return undefined;
    if (character === '$') {
      index += 1;
      return { kind: 'last' };
    }
    if (/\d/u.test(character)) {
      const digits = /^\d+/u.exec(script.slice(index))![0];
      index += digits.length;
      return { kind: 'line', line: Number(digits) };
    }
    if (character === '/' || character === '\\') {
      const delimiter = character === '/' ? '/' : script[(index += 1)]!;
      index += 1;
      return { kind: 'pattern', pattern: sedRegExp(readDelimited(delimiter), extended, '') };
    }
    return undefined;
  };
  while (true) {
    skipBlanks();
    if (index >= script.length) return commands;
    const address = readAddress();
    skipBlanks();
    let negated = false;
    if (script[index] === '!') {
      negated = true;
      index += 1;
      skipBlanks();
    }
    const name = script[index];
    index += 1;
    if (name === 'p' || name === 'd' || name === 'q') {
      commands.push({ address, negated, name });
      continue;
    }
    if (name !== 's') throw new Error(`-e expression #1, char ${index}: unknown command: \`${name ?? ''}'`);
    const delimiter = script[index];
    if (delimiter === undefined) throw new Error(`-e expression #1, char ${index}: unterminated \`s' command`);
    index += 1;
    const pattern = readDelimited(delimiter);
    const replacement = readDelimited(delimiter);
    let flags = '';
    while (index < script.length && /[gip]/u.test(script[index]!)) flags += script[index++];
    commands.push({
      address,
      negated,
      name: 's',
      pattern: sedRegExp(pattern, extended, `${flags.includes('i') ? 'i' : ''}${flags.includes('g') ? 'g' : ''}`),
      replacement: sedReplacement(replacement),
      global: flags.includes('g'),
      print: flags.includes('p')
    });
  }
}

/** Translates a POSIX basic or extended regular expression into a JavaScript one. */
function sedRegExp(source: string, extended: boolean, flags: string): RegExp {
  let translated = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\' && index + 1 < source.length) {
      const escaped = source[index + 1]!;
      index += 1;
      // In a basic expression `\(`, `\)`, `\{`, `\}`, `\|`, `\+` and `\?` are the operators.
      if (!extended && '(){}|+?'.includes(escaped)) translated += escaped;
      else if (extended && '(){}|+?'.includes(escaped)) translated += `\\${escaped}`;
      else translated += `\\${escaped}`;
      continue;
    }
    if (!extended && '(){}|+?'.includes(character)) translated += `\\${character}`;
    else translated += character;
  }
  return new RegExp(translated, `${flags}${isUnicodeSafe(translated) ? 'u' : ''}`);
}

function isUnicodeSafe(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/** Translates a sed replacement (`&`, `\1`, `\n`) into a JavaScript one. */
function sedReplacement(source: string): string {
  let result = '';
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    if (character === '\\' && index + 1 < source.length) {
      const escaped = source[index + 1]!;
      index += 1;
      if (/\d/u.test(escaped)) result += `$${escaped}`;
      else if (escaped === 'n') result += '\n';
      else if (escaped === 't') result += '\t';
      else if (escaped === '&') result += '$&';
      else if (escaped === '$') result += '$$';
      else result += escaped;
      continue;
    }
    if (character === '&') result += '$&';
    else if (character === '$') result += '$$';
    else result += character;
  }
  return result;
}

function replaceFirst(line: string, pattern: RegExp, replacement: string): string {
  const once = new RegExp(pattern.source, pattern.flags.replace('g', ''));
  return line.replace(once, replacement);
}

function sedAddressMatches(address: SedAddress | undefined, line: string, number: number, last: boolean): boolean {
  if (!address) return true;
  if (address.kind === 'line') return address.line === number;
  if (address.kind === 'last') return last;
  return address.pattern.test(line);
}

/**
 * Package-neutral Runtime Programs for the file and environment commands that
 * package scripts assume a POSIX host provides.
 */
export function createCoreUtilities(catalog: CoreUtilityCommandCatalog = () => []): readonly CoreUtility[] {
  const utilities: CoreUtility[] = [echo, cat, rm, mkdir, cp, mv, ls, touch, env, dirname, basename, uname, getconf, sed, nodeGyp];
  utilities.push(
    createWhich(() => [...utilities.map((utility) => utility.commands), ...catalog()])
  );
  return utilities;
}

/** Identities of the core utilities, for the Runtime Program registry. */
export const coreUtilityDefinitions: readonly Pick<CoreUtility, 'id' | 'commands'>[] =
  /* @__PURE__ */ coreUtilityIdentities();

function coreUtilityIdentities(): readonly Pick<CoreUtility, 'id' | 'commands'>[] {
  return createCoreUtilities().map(({ id, commands }) => ({ id, commands }));
}

import { expandBackslashEscapes, formatEcho } from './core-utilities';
import { resolvePosixPath } from './posix-path';
import { parseShellScript, ShellSyntaxError } from './shell-parser';
import type { ProcessExecutionSignal } from './process-execution';
import type { ShellFileSystemPort, ShellInterpreter, ShellIo, ShellOptions, ShellState } from './shell-program';

export interface ShellBuiltin {
  /** POSIX special builtins keep their prefix assignments in the shell environment. */
  readonly special: boolean;
  run(args: readonly string[], state: ShellState, io: ShellIo): Promise<number>;
}

const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function setShellOptionFlag(options: ShellOptions, flag: string, enable: boolean): boolean {
  if (flag === 'e') options.errexit = enable;
  else if (flag === 'u') options.nounset = enable;
  else if (flag === 'x') options.xtrace = enable;
  else return false;
  return true;
}

export function setNamedShellOption(options: ShellOptions, name: string, enable: boolean): boolean {
  if (name === 'errexit') options.errexit = enable;
  else if (name === 'nounset') options.nounset = enable;
  else if (name === 'xtrace') options.xtrace = enable;
  else if (name === 'pipefail') options.pipefail = enable;
  else return false;
  return true;
}

export function createShellBuiltins(shell: ShellInterpreter): ReadonlyMap<string, ShellBuiltin> {
  const print = async (io: ShellIo, text: string): Promise<void> => {
    await io.outputs.get(1)?.write(text);
  };
  const fail = async (io: ShellIo, message: string, status = 1): Promise<number> => {
    await io.outputs.get(2)?.write(`sh: ${message}\n`);
    return status;
  };
  const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;
  const count = async (name: string, argument: string | undefined, io: ShellIo): Promise<number | undefined> => {
    if (argument === undefined) return 1;
    if (/^\d+$/.test(argument)) return Number(argument);
    await fail(io, `${name}: ${argument}: numeric argument required`, 2);
    return undefined;
  };

  const run = async (source: string, state: ShellState, io: ShellIo, name: string): Promise<number> => {
    try {
      return await shell.evaluateList(parseShellScript(source), state, io);
    } catch (error) {
      if (!(error instanceof ShellSyntaxError)) throw error;
      return fail(io, `${name}: ${error.message}`, 2);
    }
  };

  const source: ShellBuiltin = {
    special: true,
    async run(args, state, io) {
      const path = args[0];
      if (path === undefined) return fail(io, '.: filename argument required', 2);
      let text: string;
      try {
        text = new TextDecoder().decode(await shell.services.files.readFile(resolvePosixPath(path, state.cwd)));
      } catch {
        return fail(io, `.: ${path}: No such file or directory`);
      }
      const positional = state.positional;
      if (args.length > 1) state.positional = args.slice(1);
      try {
        return await run(text, state, io, path);
      } finally {
        state.positional = positional;
      }
    }
  };
  const colon: ShellBuiltin = { special: true, run: async () => 0 };
  const test = (bracket: boolean): ShellBuiltin => ({
    special: false,
    async run(args, state, io) {
      const name = bracket ? '[' : 'test';
      let operands = args;
      if (bracket) {
        if (args.at(-1) !== ']') return fail(io, "[: missing ']'", 2);
        operands = args.slice(0, -1);
      }
      try {
        return (await evaluateTest(operands, shell.services.files, state.cwd)) ? 0 : 1;
      } catch (error) {
        if (!(error instanceof ShellTestError)) throw error;
        return fail(io, `${name}: ${error.message}`, 2);
      }
    }
  });

  return new Map<string, ShellBuiltin>([
    [':', colon],
    ['true', { special: false, run: async () => 0 }],
    ['false', { special: false, run: async () => 1 }],
    ['.', source],
    ['source', source],
    ['test', test(false)],
    ['[', test(true)],
    [
      'echo',
      {
        special: false,
        async run(args, _state, io) {
          await print(io, formatEcho(args));
          return 0;
        }
      }
    ],
    [
      'printf',
      {
        special: false,
        async run(args, _state, io) {
          if (args.length === 0) return fail(io, 'printf: usage: printf format [arguments]', 2);
          await print(io, formatPrintf(args[0]!, args.slice(1)));
          return 0;
        }
      }
    ],
    [
      'pwd',
      {
        special: false,
        async run(_args, state, io) {
          await print(io, `${state.cwd}\n`);
          return 0;
        }
      }
    ],
    [
      'cd',
      {
        special: false,
        async run(args, state, io) {
          const operands = args.filter((argument) => argument !== '-L' && argument !== '-P' && argument !== '--');
          if (operands.length > 1) return fail(io, 'cd: too many arguments');
          const requested = operands[0] ?? state.variables.get('HOME');
          if (requested === undefined) return fail(io, 'cd: HOME not set');
          const previous = requested === '-';
          const target = previous ? state.variables.get('OLDPWD') : requested;
          if (target === undefined) return fail(io, 'cd: OLDPWD not set');
          const path = resolvePosixPath(target, state.cwd);
          let kind: string | undefined;
          try {
            kind = (await shell.services.files.stat(path))?.kind;
          } catch {
            kind = undefined;
          }
          if (kind !== 'directory') {
            return fail(io, `cd: ${target}: ${kind === undefined ? 'No such file or directory' : 'Not a directory'}`);
          }
          for (const [name, value] of [
            ['OLDPWD', state.cwd],
            ['PWD', path]
          ] as const) {
            state.variables.set(name, value);
            state.exported.add(name);
          }
          state.cwd = path;
          if (previous) await print(io, `${path}\n`);
          return 0;
        }
      }
    ],
    [
      'export',
      {
        special: true,
        async run(args, state, io) {
          const operands = args.filter((argument) => argument !== '-p' && argument !== '--');
          if (operands.length === 0) {
            const lines = [...state.exported]
              .sort()
              .filter((name) => state.variables.has(name))
              .map((name) => `export ${name}=${quote(state.variables.get(name)!)}\n`);
            await print(io, lines.join(''));
            return 0;
          }
          let status = 0;
          for (const operand of operands) {
            const separator = operand.indexOf('=');
            const name = separator === -1 ? operand : operand.slice(0, separator);
            if (!NAME_PATTERN.test(name)) {
              status = await fail(io, `export: ${operand}: bad variable name`, 2);
              continue;
            }
            if (separator !== -1) state.variables.set(name, operand.slice(separator + 1));
            state.exported.add(name);
          }
          return status;
        }
      }
    ],
    [
      'unset',
      {
        special: true,
        async run(args, state) {
          for (const name of args) {
            if (name === '-v' || name === '-f' || name === '--') continue;
            state.variables.delete(name);
            state.exported.delete(name);
          }
          return 0;
        }
      }
    ],
    [
      'set',
      {
        special: true,
        async run(args, state, io) {
          if (args.length === 0) {
            const lines = [...state.variables].sort().map(([name, value]) => `${name}=${quote(value)}\n`);
            await print(io, lines.join(''));
            return 0;
          }
          let index = 0;
          for (; index < args.length; index += 1) {
            const argument = args[index]!;
            if (argument === '--') {
              index += 1;
              state.positional = args.slice(index);
              return 0;
            }
            if (!/^[-+][A-Za-z]+$/.test(argument)) break;
            const enable = argument[0] === '-';
            for (const flag of argument.slice(1)) {
              if (flag === 'o') {
                const name = args[(index += 1)];
                if (name === undefined || !setNamedShellOption(state.options, name, enable)) {
                  return fail(io, `set: -o ${name ?? '(missing name)'}: unsupported option`, 2);
                }
              } else if (!setShellOptionFlag(state.options, flag, enable)) {
                return fail(io, `set: ${argument[0]}${flag}: unsupported option`, 2);
              }
            }
          }
          if (index < args.length) state.positional = args.slice(index);
          return 0;
        }
      }
    ],
    [
      'shift',
      {
        special: true,
        async run(args, state, io) {
          const amount = await count('shift', args[0], io);
          if (amount === undefined) return 2;
          if (amount > state.positional.length) return fail(io, "shift: can't shift that many");
          state.positional = state.positional.slice(amount);
          return 0;
        }
      }
    ],
    [
      'exit',
      {
        special: true,
        async run(args, state, io) {
          let status = state.lastStatus;
          if (args[0] !== undefined) {
            if (!/^\d+$/.test(args[0])) {
              status = await fail(io, `exit: ${args[0]}: numeric argument required`, 2);
            } else {
              status = Number(args[0]) % 256;
            }
          }
          state.exiting = true;
          state.exitStatus = status;
          return status;
        }
      }
    ],
    ...(['break', 'continue'] as const).map(
      (name): [string, ShellBuiltin] => [
        name,
        {
          special: true,
          async run(args, state, io) {
            const levels = await count(name, args[0], io);
            if (levels === undefined) return 2;
            if (state.loopDepth === 0) return 0;
            const depth = Math.min(Math.max(levels, 1), state.loopDepth);
            if (name === 'break') state.breaking = depth;
            else state.continuing = depth;
            return 0;
          }
        }
      ]
    ),
    [
      'eval',
      {
        special: true,
        run: (args, state, io) => run(args.join(' '), state, io, 'eval')
      }
    ],
    [
      'exec',
      {
        special: true,
        async run(args, state, io) {
          const argv = args[0] === '--' ? args.slice(1) : args;
          if (argv.length === 0) return 0;
          const status = await shell.runExternal(argv, shell.environment(state), state, io, true);
          state.exiting = true;
          state.exitStatus = status;
          return status;
        }
      }
    ],
    [
      'command',
      {
        special: false,
        async run(args, state, io) {
          const describe = args[0] === '-v' || args[0] === '-V';
          const operands = (describe || args[0] === '-p' ? args.slice(1) : args).filter(
            (argument, index) => !(index === 0 && argument === '--')
          );
          if (operands.length === 0) return describe ? 1 : 0;
          if (!describe) return shell.dispatch(operands, state, io);
          if (shell.builtins.has(operands[0]!)) {
            await print(io, `${operands[0]}\n`);
            return 0;
          }
          return shell.runExternal(['which', operands[0]!], shell.environment(state), state, io, false);
        }
      }
    ],
    [
      'read',
      {
        special: false,
        async run(args, state, io) {
          const raw = args.includes('-r');
          const names = args.filter((argument) => argument !== '-r' && argument !== '--');
          if (names.length === 0) names.push('REPLY');
          const invalid = names.find((name) => !NAME_PATTERN.test(name));
          if (invalid !== undefined) return fail(io, `read: ${invalid}: bad variable name`, 2);
          const bytes: number[] = [];
          let complete = false;
          while (!complete) {
            const chunk = await io.stdin.read();
            if (!chunk) break;
            const newline = chunk.indexOf(10);
            if (newline === -1) {
              bytes.push(...chunk);
            } else {
              bytes.push(...chunk.subarray(0, newline));
              io.stdin.unread(chunk.subarray(newline + 1));
              complete = true;
            }
          }
          let line = new TextDecoder().decode(new Uint8Array(bytes));
          if (!raw) line = line.replace(/\\([\s\S])/g, '$1');
          let rest = line.replace(/^[ \t]+/, '');
          names.forEach((name, index) => {
            if (index === names.length - 1) {
              state.variables.set(name, rest.replace(/[ \t]+$/, ''));
              return;
            }
            const field = /^[^ \t]*/.exec(rest)![0];
            state.variables.set(name, field);
            rest = rest.slice(field.length).replace(/^[ \t]+/, '');
          });
          return complete ? 0 : 1;
        }
      }
    ],
    [
      'wait',
      {
        special: false,
        async run(args, state) {
          const operands = args.filter((argument) => argument !== '');
          if (operands.length === 0) {
            await shell.waitForJobs(state);
            return 0;
          }
          let status = 0;
          for (const operand of operands) {
            const job = [...state.jobs].find((candidate) => String(candidate.pid) === operand);
            if (!job) {
              status = 127;
              continue;
            }
            status = await job.done;
            state.jobs.delete(job);
          }
          return status;
        }
      }
    ],
    [
      'kill',
      {
        special: false,
        async run(args, _state, io) {
          let signal: ProcessExecutionSignal = 'SIGTERM';
          let operands = [...args];
          const named = operands[0] === '-s' ? operands[1] : /^-[A-Za-z0-9]+$/.test(operands[0] ?? '') ? operands[0]!.slice(1) : undefined;
          if (named !== undefined) {
            operands = operands.slice(operands[0] === '-s' ? 2 : 1);
            const normalized = named.toUpperCase().replace(/^SIG/, '');
            if (normalized === 'KILL' || normalized === '9') signal = 'SIGKILL';
            else if (normalized === 'INT' || normalized === '2') signal = 'SIGINT';
            else if (!['TERM', '15', 'HUP', '1', 'QUIT', '3'].includes(normalized)) {
              return fail(io, `kill: ${named}: unsupported signal`, 2);
            }
          }
          if (operands.length === 0) return fail(io, 'kill: usage: kill [-s signal] pid ...', 2);
          let status = 0;
          for (const operand of operands) {
            const child = [...shell.activeChildren].find((candidate) => String(candidate.pid) === operand);
            if (!child) {
              status = await fail(io, `kill: (${operand}) - No such process`);
              continue;
            }
            child.kill(signal);
          }
          return status;
        }
      }
    ]
  ]);
}

class ShellTestError extends Error {}

const TEST_BINARY_OPERATORS = new Set([
  '=',
  '==',
  '!=',
  '<',
  '>',
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
  '-nt',
  '-ot',
  '-ef'
]);
const TEST_UNARY_OPERATORS = new Set([
  '-e',
  '-f',
  '-d',
  '-s',
  '-r',
  '-w',
  '-x',
  '-L',
  '-h',
  '-n',
  '-z',
  '-p',
  '-S',
  '-b',
  '-c',
  '-t'
]);

async function evaluateTest(args: readonly string[], files: ShellFileSystemPort, cwd: string): Promise<boolean> {
  let index = 0;
  const status = async (operand: string, followSymlinks = true) => {
    const path = resolvePosixPath(operand, cwd);
    try {
      return await files.stat(path, { followSymlinks });
    } catch {
      return undefined;
    }
  };
  const integer = (value: string): number => {
    if (!/^\s*[-+]?\d+\s*$/.test(value)) throw new ShellTestError(`${value}: integer expression expected`);
    return Number(value);
  };
  const parseOr = async (): Promise<boolean> => {
    let result = await parseAnd();
    while (args[index] === '-o') {
      index += 1;
      const right = await parseAnd();
      result = result || right;
    }
    return result;
  };
  const parseAnd = async (): Promise<boolean> => {
    let result = await parseNot();
    while (args[index] === '-a') {
      index += 1;
      const right = await parseNot();
      result = result && right;
    }
    return result;
  };
  const parseNot = async (): Promise<boolean> => {
    if (args[index] === '!' && index + 1 < args.length) {
      index += 1;
      return !(await parseNot());
    }
    return parsePrimary();
  };
  const parsePrimary = async (): Promise<boolean> => {
    const token = args[index];
    if (token === undefined) throw new ShellTestError('argument expected');
    const operator = args[index + 1];
    if (operator !== undefined && TEST_BINARY_OPERATORS.has(operator) && index + 2 < args.length) {
      const right = args[index + 2]!;
      index += 3;
      switch (operator) {
        case '=':
        case '==':
          return token === right;
        case '!=':
          return token !== right;
        case '<':
          return token < right;
        case '>':
          return token > right;
        case '-eq':
          return integer(token) === integer(right);
        case '-ne':
          return integer(token) !== integer(right);
        case '-lt':
          return integer(token) < integer(right);
        case '-le':
          return integer(token) <= integer(right);
        case '-gt':
          return integer(token) > integer(right);
        case '-ge':
          return integer(token) >= integer(right);
        case '-ef':
          return resolvePosixPath(token, cwd) === resolvePosixPath(right, cwd) && (await status(token)) !== undefined;
        default: {
          const [left, other] = [await status(token), await status(right)];
          if (!left || !other) return operator === '-nt' ? left !== undefined : other !== undefined;
          return operator === '-nt' ? left.mtimeMs > other.mtimeMs : left.mtimeMs < other.mtimeMs;
        }
      }
    }
    if (token === '(' && index + 1 < args.length) {
      index += 1;
      const result = await parseOr();
      if (args[index] !== ')') throw new ShellTestError("missing ')'");
      index += 1;
      return result;
    }
    if (TEST_UNARY_OPERATORS.has(token) && index + 1 < args.length) {
      const operand = args[index + 1]!;
      index += 2;
      switch (token) {
        case '-n':
          return operand !== '';
        case '-z':
          return operand === '';
        case '-t':
        case '-p':
        case '-S':
        case '-b':
          return false;
        case '-c':
          return resolvePosixPath(operand, cwd) === '/dev/null';
        case '-L':
        case '-h':
          return (await status(operand, false))?.kind === 'symlink';
        case '-f':
          return (await status(operand))?.kind === 'file';
        case '-d':
          return (await status(operand))?.kind === 'directory';
        case '-s':
          return ((await status(operand))?.size ?? 0) > 0;
        default:
          // -e, -r, -w and -x: the virtual filesystem has no access control to refuse them.
          return resolvePosixPath(operand, cwd) === '/dev/null' || (await status(operand)) !== undefined;
      }
    }
    index += 1;
    return token !== '';
  };
  if (args.length === 0) return false;
  const result = await parseOr();
  if (index !== args.length) throw new ShellTestError('too many arguments');
  return result;
}

function formatPrintf(format: string, values: readonly string[]): string {
  const template = expandBackslashEscapes(format, false).text;
  let next = 0;
  let output = '';
  const directive = /%(%|([-0 +#]*)(\d+)?(?:\.(\d+))?([sdiuxXocbfeEgG]))/g;
  do {
    const consumedBefore = next;
    let stopped = false;
    output += template.replace(directive, (_match, percent: string, flags = '', width?: string, precision?: string, kind?: string) => {
      if (percent === '%' || stopped) return stopped ? '' : '%';
      const value = values[next] ?? '';
      next += 1;
      let text: string;
      switch (kind) {
        case 's':
          text = precision === undefined ? value : value.slice(0, Number(precision));
          break;
        case 'b': {
          const expanded = expandBackslashEscapes(value, true);
          text = expanded.text;
          stopped = expanded.stop;
          break;
        }
        case 'c':
          text = value.slice(0, 1);
          break;
        case 'd':
        case 'i':
        case 'u':
          text = String(Math.trunc(Number(value) || 0));
          break;
        case 'x':
          text = Math.trunc(Number(value) || 0).toString(16);
          break;
        case 'X':
          text = Math.trunc(Number(value) || 0).toString(16).toUpperCase();
          break;
        case 'o':
          text = Math.trunc(Number(value) || 0).toString(8);
          break;
        case 'e':
        case 'E': {
          const exponent = (Number(value) || 0).toExponential(precision === undefined ? 6 : Number(precision));
          text = kind === 'E' ? exponent.toUpperCase() : exponent;
          break;
        }
        default:
          text = (Number(value) || 0).toFixed(precision === undefined ? 6 : Number(precision));
      }
      if (flags.includes('+') && 'dif'.includes(kind!) && !text.startsWith('-')) text = `+${text}`;
      const size = width === undefined ? 0 : Number(width);
      if (flags.includes('-')) return text.padEnd(size);
      if (flags.includes('0') && kind !== 's' && kind !== 'b' && kind !== 'c') {
        const sign = /^[-+]/.test(text) ? text[0]! : '';
        return `${sign}${text.slice(sign.length).padStart(size - sign.length, '0')}`;
      }
      return text.padStart(size);
    });
    // The format is reused while it keeps consuming arguments.
    if (stopped || next === consumedBefore) break;
  } while (next < values.length);
  return output;
}

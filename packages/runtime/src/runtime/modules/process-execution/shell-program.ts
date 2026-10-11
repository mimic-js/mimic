import type {
  ShellAndOr,
  ShellCommand,
  ShellList,
  ShellPipeline,
  ShellRedirection,
  ShellSimpleCommand
} from './shell-ast';
import type { CoreUtilityFileSystem } from './core-utilities';
import { posixDirname, resolvePosixPath } from './posix-path';
import {
  createShellBuiltins,
  setNamedShellOption,
  setShellOptionFlag,
  type ShellBuiltin
} from './shell-builtins';
import {
  expandShellPattern,
  expandShellWord,
  expandShellWords,
  ShellExpansionError,
  type ShellExpansionContext
} from './shell-expansion';
import { parseShellScript, ShellSyntaxError } from './shell-parser';
import { exitCodeForSignal, type ProcessExecutionSignal } from './process-execution';
import type { ProcessInput, ProcessWriter } from './virtual-process';

export const SHELL_PROGRAM_COMMANDS = [
  'sh',
  '/bin/sh',
  '/usr/bin/sh',
  'bash',
  '/bin/bash',
  '/usr/bin/bash'
] as const;

/** Interpreter basenames whose shebang scripts run through the Shell Program. */
export const SHELL_INTERPRETER_NAMES = ['sh', 'bash', 'dash', 'ash'] as const;

export type ShellChild = Readonly<{
  readonly pid: number;
  readonly stdin: WritableStream<Uint8Array>;
  readonly stdout: ReadableStream<Uint8Array>;
  readonly stderr: ReadableStream<Uint8Array>;
  readonly exit: Promise<number>;
  kill(signal: ProcessExecutionSignal): void;
}>;

export type ShellChildSpawnRequest = Readonly<{
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly parentPid: number;
  readonly stdin: ReadableStream<Uint8Array>;
}>;

export interface ShellChildSpawner {
  spawn(request: ShellChildSpawnRequest): Promise<ShellChild>;
}

/** The files behind globbing, `cd`, `test`, script files and redirections; paths are absolute. */
export type ShellFileSystemPort = Pick<
  CoreUtilityFileSystem,
  'stat' | 'readFile' | 'readDirectory' | 'writeFile' | 'makeDirectory'
>;

export interface ShellProgramServices {
  readonly children: ShellChildSpawner;
  readonly files: ShellFileSystemPort;
  readonly replace?: (request: ShellChildSpawnRequest) => Promise<number>;
}

export interface ShellInvocation {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly pid: number;
  readonly parentPid: number;
  readonly stdin: ProcessInput;
  readonly stdout: ProcessWriter;
  readonly stderr: ProcessWriter;
  readonly signal: Promise<ProcessExecutionSignal>;
}

export interface ShellProgram {
  readonly id: 'sh';
  readonly commands: typeof SHELL_PROGRAM_COMMANDS;
  run(invocation: ShellInvocation, services: ShellProgramServices): Promise<number>;
}

export interface ShellSink {
  write(chunk: string | Uint8Array): Promise<void>;
}

export type ShellIo = Readonly<{
  readonly stdin: ShellInput;
  readonly outputs: ReadonlyMap<number, ShellSink>;
}>;

export type ShellJob = {
  pid: number | undefined;
  finished: boolean;
  done: Promise<number>;
  started(): void;
};

export type ShellOptions = {
  errexit: boolean;
  nounset: boolean;
  xtrace: boolean;
  pipefail: boolean;
};

export type ShellState = {
  readonly variables: Map<string, string>;
  readonly exported: Set<string>;
  cwd: string;
  positional: string[];
  scriptName: string;
  lastStatus: number;
  lastBackgroundPid: number | undefined;
  readonly options: ShellOptions;
  exiting: boolean;
  exitStatus: number;
  breaking: number;
  continuing: number;
  loopDepth: number;
  /** Positive while evaluating a condition, where a failure must not trigger `set -e`. */
  conditionDepth: number;
  readonly jobs: Set<ShellJob>;
  /** False in subshells, pipeline stages and substitutions, which must never replace the process. */
  readonly isRoot: boolean;
  readonly job: ShellJob | undefined;
};

/** A failure that fails one command and lets the script continue. */
export class ShellCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ShellCommandError';
  }
}

const encoder = new TextEncoder();
const NOT_FOUND_CODES = new Set(['EXECUTABLE_NOT_FOUND', 'ENOENT']);
const NOT_EXECUTABLE_CODES = new Set(['UNSUPPORTED_INTERPRETER', 'ENOEXEC', 'EACCES']);
const NULL_DEVICE = '/dev/null';
const nullSink: ShellSink = { write: async () => undefined };

/**
 * Standard input shared by the commands of a script. Each command reads
 * through its own view; a chunk that arrives after its view was released is
 * kept for the next reader instead of being lost with the finished command.
 */
export class ShellInput {
  readonly #buffer: Uint8Array[] = [];
  #ended = false;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly pull: () => Promise<Uint8Array | undefined>) {}

  static empty(): ShellInput {
    return new ShellInput(async () => undefined);
  }

  read(isActive: () => boolean = () => true): Promise<Uint8Array | undefined> {
    const result = this.#tail.then(async () => {
      if (!isActive()) return undefined;
      const buffered = this.#buffer.shift();
      if (buffered) return buffered;
      if (this.#ended) return undefined;
      const chunk = await this.pull().catch(() => undefined);
      if (chunk === undefined) {
        this.#ended = true;
        return undefined;
      }
      if (!isActive()) {
        this.#buffer.unshift(chunk);
        return undefined;
      }
      return chunk;
    });
    this.#tail = result;
    return result;
  }

  unread(chunk: Uint8Array): void {
    if (chunk.byteLength > 0) this.#buffer.unshift(chunk);
  }

  view(): { readonly stream: ReadableStream<Uint8Array>; release(): void } {
    let active = true;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const chunk = await this.read(() => active);
          if (!active) return;
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel: () => {
          active = false;
        }
      },
      // Nothing is read from the shared input until the command asks for it.
      { highWaterMark: 0 }
    );
    return {
      stream,
      release: () => {
        active = false;
      }
    };
  }
}

export function createShellProgram(): ShellProgram {
  return {
    id: 'sh',
    commands: SHELL_PROGRAM_COMMANDS,
    async run(invocation, services) {
      const stderr = writerSink(invocation.stderr);
      const parsed = parseInvocation(invocation.argv);
      if (!parsed.ok) {
        await stderr.write(`sh: ${parsed.message}\n`);
        return 2;
      }
      const stdin = new ShellInput(() => invocation.stdin.read());
      let source: string;
      if (parsed.script.kind === 'inline') {
        source = parsed.script.source;
      } else if (parsed.script.kind === 'file') {
        try {
          const bytes = await services.files.readFile(resolvePosixPath(parsed.script.path, invocation.cwd));
          source = new TextDecoder().decode(bytes);
        } catch {
          await stderr.write(`sh: ${parsed.script.path}: No such file or directory\n`);
          return 127;
        }
      } else {
        const decoder = new TextDecoder();
        source = '';
        for (let chunk = await stdin.read(); chunk; chunk = await stdin.read()) {
          source += decoder.decode(chunk, { stream: true });
        }
      }
      const interpreter = new ShellInterpreter(invocation, services, {
        stdin,
        outputs: new Map([
          [1, writerSink(invocation.stdout)],
          [2, stderr]
        ])
      });
      return interpreter.runScript(source, parsed);
    }
  };
}

type ParsedInvocation = {
  readonly ok: true;
  readonly script:
    | { readonly kind: 'inline'; readonly source: string }
    | { readonly kind: 'file'; readonly path: string }
    | { readonly kind: 'stdin' };
  readonly scriptName: string;
  readonly positional: readonly string[];
  readonly options: ShellOptions;
};

function parseInvocation(
  argv: readonly string[]
): ParsedInvocation | { readonly ok: false; readonly message: string } {
  const options: ShellOptions = { errexit: false, nounset: false, xtrace: false, pipefail: false };
  let command = false;
  let readStdin = false;
  let index = 0;
  for (; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--' || argument === '-') {
      index += 1;
      break;
    }
    if (!/^[-+][A-Za-z]+$/.test(argument)) break;
    const enable = argument[0] === '-';
    for (const flag of argument.slice(1)) {
      if (flag === 'c') command = true;
      else if (flag === 's') readStdin = true;
      else if (flag === 'i' || flag === 'l') continue;
      else if (flag === 'o') {
        const name = argv[(index += 1)];
        if (name === undefined || !setNamedShellOption(options, name, enable)) {
          return { ok: false, message: `illegal option -o ${name ?? ''}`.trimEnd() };
        }
      } else if (!setShellOptionFlag(options, flag, enable)) {
        return { ok: false, message: `illegal option -${flag}` };
      }
    }
  }
  if (command) {
    const source = argv[index];
    if (source === undefined) return { ok: false, message: '-c requires an argument' };
    return {
      ok: true,
      script: { kind: 'inline', source },
      scriptName: argv[index + 1] ?? 'sh',
      positional: argv.slice(index + 2),
      options
    };
  }
  const path = argv[index];
  if (path !== undefined && !readStdin) {
    return {
      ok: true,
      script: { kind: 'file', path },
      scriptName: path,
      positional: argv.slice(index + 1),
      options
    };
  }
  return { ok: true, script: { kind: 'stdin' }, scriptName: 'sh', positional: argv.slice(index), options };
}

export class ShellInterpreter {
  readonly activeChildren = new Set<ShellChild>();
  readonly builtins: ReadonlyMap<string, ShellBuiltin>;
  signal: ProcessExecutionSignal | undefined;
  /** Set once `exec` replaced the shell: its signals and status are that program's. */
  replaced = false;
  #substitutionStatus: number | undefined;

  constructor(
    readonly invocation: ShellInvocation,
    readonly services: ShellProgramServices,
    private readonly rootIo: ShellIo
  ) {
    this.builtins = createShellBuiltins(this);
  }

  async runScript(source: string, parsed: ParsedInvocation): Promise<number> {
    const { invocation } = this;
    const state: ShellState = {
      variables: new Map([...Object.entries(invocation.env), ['PWD', invocation.cwd]]),
      exported: new Set([...Object.keys(invocation.env), 'PWD']),
      cwd: invocation.cwd,
      positional: [...parsed.positional],
      scriptName: parsed.scriptName,
      lastStatus: 0,
      lastBackgroundPid: undefined,
      options: parsed.options,
      exiting: false,
      exitStatus: 0,
      breaking: 0,
      continuing: 0,
      loopDepth: 0,
      conditionDepth: 0,
      jobs: new Set(),
      isRoot: true,
      job: undefined
    };
    void invocation.signal.then((signal) => {
      // After `exec` the process is the program that replaced the shell.
      if (this.signal || this.replaced) return;
      this.signal = signal;
      for (const child of this.activeChildren) child.kill(signal);
    });
    try {
      const status = await this.evaluateList(parseShellScript(source), state, this.rootIo, true);
      // Background children belong to this Runtime Process and end with it, so
      // the script's jobs are awaited instead of being orphaned at exit.
      await this.waitForJobs(state);
      if (this.signal) return exitCodeForSignal(this.signal);
      return state.exiting ? state.exitStatus : status;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await output(this.rootIo, 2).write(`sh: ${message}\n`);
      return error instanceof ShellSyntaxError ? 2 : 1;
    }
  }

  interrupted(state: ShellState): boolean {
    return state.exiting || state.breaking > 0 || state.continuing > 0 || this.signal !== undefined;
  }

  async waitForJobs(state: ShellState): Promise<void> {
    await Promise.all([...state.jobs].map((job) => job.done));
    state.jobs.clear();
  }

  async evaluateList(list: ShellList, state: ShellState, io: ShellIo, tail = false): Promise<number> {
    let status = 0;
    for (const [index, item] of list.items.entries()) {
      if (this.interrupted(state)) break;
      if (item.background) {
        await this.startBackground(item.andOr, state, io);
        status = 0;
        state.lastStatus = 0;
        continue;
      }
      status = await this.evaluateAndOr(item.andOr, state, io, tail && index === list.items.length - 1);
    }
    return status;
  }

  private async startBackground(andOr: ShellAndOr, state: ShellState, io: ShellIo): Promise<void> {
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const job: ShellJob = { pid: undefined, finished: false, done: Promise.resolve(0), started: markStarted };
    const jobState = this.fork(state, job);
    job.done = (async () => {
      try {
        // POSIX: a background command of a non-interactive shell reads from /dev/null.
        return await this.evaluateAndOr(andOr, jobState, { stdin: ShellInput.empty(), outputs: io.outputs }, false);
      } catch (error) {
        await output(io, 2).write(`sh: ${error instanceof Error ? error.message : String(error)}\n`);
        return 1;
      } finally {
        job.finished = true;
        markStarted();
      }
    })();
    state.jobs.add(job);
    // `$!` names the job's first child, so wait until it is admitted (or the job is over).
    await started;
    state.lastBackgroundPid = job.pid;
  }

  private async evaluateAndOr(andOr: ShellAndOr, state: ShellState, io: ShellIo, tail: boolean): Promise<number> {
    let status = 0;
    let lastRun = -1;
    for (const [index, pipeline] of andOr.pipelines.entries()) {
      if (index > 0 && (andOr.operators[index - 1] === '&&') !== (status === 0)) continue;
      if (this.interrupted(state)) break;
      const isLast = index === andOr.pipelines.length - 1;
      if (!isLast) state.conditionDepth += 1;
      try {
        status = await this.evaluatePipeline(pipeline, state, io, tail && isLast);
      } finally {
        if (!isLast) state.conditionDepth -= 1;
      }
      state.lastStatus = status;
      lastRun = index;
    }
    if (
      status !== 0 &&
      state.options.errexit &&
      state.conditionDepth === 0 &&
      lastRun === andOr.pipelines.length - 1 &&
      !andOr.pipelines[lastRun]!.negated &&
      !this.interrupted(state)
    ) {
      state.exiting = true;
      state.exitStatus = status;
    }
    return status;
  }

  private async evaluatePipeline(
    pipeline: ShellPipeline,
    state: ShellState,
    io: ShellIo,
    tail: boolean
  ): Promise<number> {
    if (pipeline.negated) state.conditionDepth += 1;
    try {
      const status =
        pipeline.commands.length === 1
          ? await this.evaluateCommand(pipeline.commands[0]!, state, io, tail && !pipeline.negated)
          : await this.evaluateStages(pipeline.commands, state, io);
      return pipeline.negated ? (status === 0 ? 1 : 0) : status;
    } finally {
      if (pipeline.negated) state.conditionDepth -= 1;
    }
  }

  private async evaluateStages(commands: readonly ShellCommand[], state: ShellState, io: ShellIo): Promise<number> {
    const pipes = commands.slice(1).map(() => createPipe());
    const statuses = await Promise.all(
      commands.map(async (command, index) => {
        const stageState = this.fork(state, state.job);
        const outputs = new Map(io.outputs);
        const downstream = pipes[index];
        if (downstream) outputs.set(1, downstream.sink);
        try {
          const status = await this.evaluateCommand(
            command,
            stageState,
            { stdin: index === 0 ? io.stdin : pipes[index - 1]!.input, outputs },
            false
          );
          await this.waitForJobs(stageState);
          return stageState.exiting ? stageState.exitStatus : status;
        } finally {
          await downstream?.close();
          pipes[index - 1]?.abandon();
        }
      })
    );
    if (state.options.pipefail) return [...statuses].reverse().find((status) => status !== 0) ?? 0;
    return statuses.at(-1) ?? 0;
  }

  private async evaluateCommand(
    command: ShellCommand,
    state: ShellState,
    io: ShellIo,
    tail: boolean
  ): Promise<number> {
    let scoped: { readonly io: ShellIo; release(): Promise<void> } | undefined;
    try {
      // Prefix assignments are visible to the command's own words and
      // redirection targets (`OUT=log tool > "$OUT"`), as this Shell Program
      // has always expanded them; POSIX shells expand the words first.
      const assignments = new Map<string, string>();
      if (command.kind === 'simple') {
        this.#substitutionStatus = undefined;
        const context = this.expansionContext(state, io, assignments);
        for (const assignment of command.assignments) {
          assignments.set(assignment.name, await expandShellWord(assignment.value, context));
        }
      }
      scoped =
        command.redirections.length === 0
          ? { io, release: async () => undefined }
          : await this.applyRedirections(command.redirections, state, io, assignments);
      return await this.evaluateBody(
        command,
        state,
        scoped.io,
        tail && command.redirections.length === 0,
        assignments
      );
    } catch (error) {
      if (error instanceof ShellCommandError) {
        await output(io, 2).write(`sh: ${error.message}\n`);
        return 1;
      }
      if (error instanceof ShellExpansionError) {
        // POSIX: an expansion error ends a non-interactive shell.
        await output(io, 2).write(`sh: ${error.message}\n`);
        state.exiting = true;
        state.exitStatus = 2;
        return 2;
      }
      throw error;
    } finally {
      await scoped?.release();
    }
  }

  private async evaluateBody(
    command: ShellCommand,
    state: ShellState,
    io: ShellIo,
    tail: boolean,
    assignments: ReadonlyMap<string, string>
  ): Promise<number> {
    switch (command.kind) {
      case 'simple':
        return this.runSimple(command, [...assignments], state, io, tail);
      case 'group':
        return this.evaluateList(command.body, state, io);
      case 'subshell': {
        // A subshell is its own Runtime Process: Process Execution isolates its
        // variables, working directory and exit from this shell.
        const { errexit, nounset, xtrace, pipefail } = state.options;
        const flags = `${errexit ? 'e' : ''}${nounset ? 'u' : ''}${xtrace ? 'x' : ''}`;
        return this.runExternal(
          [
            'sh',
            ...(flags ? [`-${flags}`] : []),
            ...(pipefail ? ['-o', 'pipefail'] : []),
            '-c',
            command.source,
            state.scriptName,
            ...state.positional
          ],
          Object.fromEntries(state.variables),
          state,
          io,
          false
        );
      }
      case 'if': {
        for (const clause of command.clauses) {
          const condition = await this.evaluateCondition(clause.condition, state, io);
          if (this.interrupted(state)) return condition;
          if (condition === 0) return this.evaluateList(clause.body, state, io);
        }
        return command.otherwise ? this.evaluateList(command.otherwise, state, io) : 0;
      }
      case 'for': {
        const context = this.expansionContext(state, io);
        const values = command.items ? await expandShellWords(command.items, context) : [...state.positional];
        return this.evaluateLoop(state, async (iteration) => {
          const value = values[iteration];
          if (value === undefined) return false;
          state.variables.set(command.variable, value);
          return true;
        }, () => this.evaluateList(command.body, state, io));
      }
      case 'while':
        return this.evaluateLoop(
          state,
          async () => {
            const condition = await this.evaluateCondition(command.condition, state, io);
            return !this.interrupted(state) && (condition === 0) !== command.until;
          },
          () => this.evaluateList(command.body, state, io)
        );
      case 'case': {
        const context = this.expansionContext(state, io);
        const subject = await expandShellWord(command.subject, context);
        for (const clause of command.clauses) {
          for (const pattern of clause.patterns) {
            if ((await expandShellPattern(pattern, context)).test(subject)) {
              return this.evaluateList(clause.body, state, io);
            }
          }
        }
        return 0;
      }
    }
  }

  private async evaluateCondition(list: ShellList, state: ShellState, io: ShellIo): Promise<number> {
    state.conditionDepth += 1;
    try {
      return await this.evaluateList(list, state, io);
    } finally {
      state.conditionDepth -= 1;
    }
  }

  private async evaluateLoop(
    state: ShellState,
    advance: (iteration: number) => Promise<boolean>,
    body: () => Promise<number>
  ): Promise<number> {
    let status = 0;
    state.loopDepth += 1;
    try {
      for (let iteration = 0; !this.interrupted(state) && (await advance(iteration)); iteration += 1) {
        status = await body();
        if (state.breaking > 0) {
          state.breaking -= 1;
          break;
        }
        if (state.continuing > 0) {
          state.continuing -= 1;
          if (state.continuing > 0) break;
        }
        // A loop of builtins never leaves the microtask queue; yield so signals are delivered.
        if (iteration % 256 === 255) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    } finally {
      state.loopDepth -= 1;
    }
    return status;
  }

  private async runSimple(
    command: ShellSimpleCommand,
    assignments: readonly (readonly [string, string])[],
    state: ShellState,
    io: ShellIo,
    tail: boolean
  ): Promise<number> {
    const argv = await expandShellWords(
      command.words,
      this.expansionContext(state, io, new Map(assignments))
    );
    if (state.options.xtrace && (argv.length > 0 || assignments.length > 0)) {
      const trace = [...assignments.map(([name, value]) => `${name}=${value}`), ...argv].join(' ');
      await output(io, 2).write(`+ ${trace}\n`);
    }
    const name = argv[0];
    if (name === undefined) {
      for (const [variable, value] of assignments) state.variables.set(variable, value);
      return this.#substitutionStatus ?? 0;
    }
    const builtin = this.builtins.get(name);
    if (!builtin) {
      const env = { ...this.environment(state), ...Object.fromEntries(assignments) };
      return this.runExternal(argv, env, state, io, tail);
    }
    if (name === 'exec' && argv.length === 1 && command.redirections.length > 0) {
      throw new ShellCommandError('exec: redirections without a command are not supported');
    }
    if (builtin.special) {
      for (const [variable, value] of assignments) state.variables.set(variable, value);
      return builtin.run(argv.slice(1), state, io);
    }
    const saved = assignments.map(
      ([variable]) => [variable, state.variables.get(variable), state.exported.has(variable)] as const
    );
    for (const [variable, value] of assignments) {
      state.variables.set(variable, value);
      state.exported.add(variable);
    }
    try {
      return await builtin.run(argv.slice(1), state, io);
    } finally {
      for (const [variable, value, exported] of saved) {
        if (value === undefined) state.variables.delete(variable);
        else state.variables.set(variable, value);
        if (!exported) state.exported.delete(variable);
      }
    }
  }

  /** Runs `argv` as a builtin when it names one, otherwise as a child process. */
  dispatch(argv: readonly string[], state: ShellState, io: ShellIo): Promise<number> {
    const builtin = this.builtins.get(argv[0]!);
    return builtin
      ? builtin.run(argv.slice(1), state, io)
      : this.runExternal(argv, this.environment(state), state, io, false);
  }

  environment(state: ShellState): Record<string, string> {
    const env: Record<string, string> = {};
    for (const name of state.exported) {
      const value = state.variables.get(name);
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  canReplace(state: ShellState, io: ShellIo): boolean {
    return (
      this.services.replace !== undefined &&
      state.isRoot &&
      io === this.rootIo &&
      [...state.jobs].every((job) => job.finished)
    );
  }

  async runExternal(
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    state: ShellState,
    io: ShellIo,
    replace: boolean
  ): Promise<number> {
    if (this.signal) return exitCodeForSignal(this.signal);
    const command = argv[0]!;
    const input = io.stdin.view();
    const request: ShellChildSpawnRequest = {
      command,
      args: argv.slice(1),
      cwd: state.cwd,
      env,
      parentPid: this.invocation.pid,
      stdin: input.stream
    };
    let child: ShellChild | undefined;
    try {
      if (replace && this.canReplace(state, io)) {
        this.replaced = true;
        return await this.services.replace!(request);
      }
      child = await this.services.children.spawn(request);
      this.activeChildren.add(child);
      if (state.job && state.job.pid === undefined) {
        state.job.pid = child.pid;
        state.job.started();
      }
      if (this.signal) child.kill(this.signal);
      const [exit] = await Promise.all([
        child.exit.then(
          (code) => ({ code }),
          (error: unknown) => ({ error })
        ),
        pump(child.stdout, output(io, 1)),
        pump(child.stderr, output(io, 2))
      ]);
      if ('error' in exit) throw exit.error;
      return exit.code;
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
      if (NOT_FOUND_CODES.has(code)) {
        await output(io, 2).write(`sh: ${command}: command not found\n`);
        return 127;
      }
      if (NOT_EXECUTABLE_CODES.has(code)) {
        await output(io, 2).write(`sh: ${command}: ${error instanceof Error ? error.message : String(error)}\n`);
        return 126;
      }
      throw error;
    } finally {
      input.release();
      if (child) this.activeChildren.delete(child);
    }
  }

  fork(state: ShellState, job: ShellJob | undefined): ShellState {
    return {
      variables: new Map(state.variables),
      exported: new Set(state.exported),
      cwd: state.cwd,
      positional: [...state.positional],
      scriptName: state.scriptName,
      lastStatus: state.lastStatus,
      lastBackgroundPid: state.lastBackgroundPid,
      options: { ...state.options },
      exiting: false,
      exitStatus: 0,
      breaking: 0,
      continuing: 0,
      loopDepth: 0,
      conditionDepth: state.conditionDepth,
      jobs: new Set(),
      isRoot: false,
      job
    };
  }

  expansionContext(
    state: ShellState,
    io: ShellIo,
    assignments?: ReadonlyMap<string, string>
  ): ShellExpansionContext {
    const { files } = this.services;
    return {
      cwd: state.cwd,
      nounset: state.options.nounset,
      parameter: (name) => {
        switch (name) {
          case '?':
            return String(state.lastStatus);
          case '$':
            return String(this.invocation.pid);
          case '!':
            return state.lastBackgroundPid === undefined ? '' : String(state.lastBackgroundPid);
          case '#':
            return String(state.positional.length);
          case '0':
            return state.scriptName;
          case '-':
            return `${state.options.errexit ? 'e' : ''}${state.options.nounset ? 'u' : ''}${state.options.xtrace ? 'x' : ''}`;
          default:
            if (/^\d+$/.test(name)) return state.positional[Number(name) - 1];
            return assignments?.has(name) ? assignments.get(name) : state.variables.get(name);
        }
      },
      positional: () => state.positional,
      assign: (name, value) => {
        state.variables.set(name, value);
      },
      substitute: async (body) => {
        const chunks: Uint8Array[] = [];
        const capture: ShellSink = {
          write: async (chunk) => {
            chunks.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk.slice());
          }
        };
        const subshell = this.fork(state, state.job);
        const status = await this.evaluateList(body, subshell, {
          stdin: io.stdin,
          outputs: new Map(io.outputs).set(1, capture)
        });
        await this.waitForJobs(subshell);
        this.#substitutionStatus = subshell.exiting ? subshell.exitStatus : status;
        return new TextDecoder().decode(concatenate(chunks));
      },
      readDirectory: async (path) => {
        try {
          return await files.readDirectory(path);
        } catch {
          return undefined;
        }
      },
      fileKind: async (path) => {
        try {
          const kind = (await files.stat(path))?.kind;
          return kind === 'file' || kind === 'directory' ? kind : undefined;
        } catch {
          return undefined;
        }
      }
    };
  }

  private async applyRedirections(
    redirections: readonly ShellRedirection[],
    state: ShellState,
    io: ShellIo,
    assignments: ReadonlyMap<string, string>
  ): Promise<{ readonly io: ShellIo; release(): Promise<void> }> {
    const { files } = this.services;
    const context = this.expansionContext(state, io, assignments);
    const outputs = new Map(io.outputs);
    const releases: (() => Promise<void>)[] = [];
    let stdin = io.stdin;
    const release = async (): Promise<void> => {
      for (const close of releases.splice(0)) await close().catch(() => undefined);
    };
    try {
      for (const redirection of redirections) {
        const target = await expandShellWord(redirection.target, context);
        const isNullDevice = resolvePosixPath(target, state.cwd) === NULL_DEVICE;
        switch (redirection.kind) {
          case 'input': {
            if (redirection.fd !== 0) {
              throw new ShellCommandError(`${redirection.fd}<: input redirection is supported on descriptor 0 only`);
            }
            if (isNullDevice) {
              stdin = ShellInput.empty();
              break;
            }
            let contents: Uint8Array | undefined;
            try {
              contents = await files.readFile(resolvePosixPath(target, state.cwd));
            } catch {
              throw new ShellCommandError(`${target}: No such file or directory`);
            }
            stdin = new ShellInput(async () => {
              const chunk = contents?.byteLength ? contents : undefined;
              contents = undefined;
              return chunk;
            });
            break;
          }
          case 'output':
          case 'append': {
            if (isNullDevice) {
              outputs.set(redirection.fd, nullSink);
              break;
            }
            // The file is written once, when the command finishes with it.
            const path = resolvePosixPath(target, state.cwd);
            const append = redirection.kind === 'append';
            const chunks: Uint8Array[] = [];
            outputs.set(redirection.fd, {
              write: async (chunk) => {
                chunks.push(typeof chunk === 'string' ? encoder.encode(chunk) : chunk.slice());
              }
            });
            releases.push(async () => {
              const prior =
                append && (await files.stat(path)) !== undefined
                  ? await files.readFile(path)
                  : new Uint8Array();
              await files.makeDirectory(posixDirname(path), { recursive: true });
              await files.writeFile(path, concatenate([prior, ...chunks]));
            });
            break;
          }
          case 'duplicate-output': {
            if (target === '-') {
              outputs.delete(redirection.fd);
              break;
            }
            const source = /^\d+$/.test(target) ? outputs.get(Number(target)) : undefined;
            if (!source) throw new ShellCommandError(`${target}: bad file descriptor`);
            outputs.set(redirection.fd, source);
            break;
          }
          case 'duplicate-input': {
            if (target === '-' && redirection.fd === 0) stdin = ShellInput.empty();
            else if (target !== '0' || redirection.fd !== 0) {
              throw new ShellCommandError(`${redirection.fd}<&${target}: bad file descriptor`);
            }
            break;
          }
        }
      }
    } catch (error) {
      await release();
      throw error;
    }
    return { io: { stdin, outputs }, release };
  }
}

export function output(io: ShellIo, fd: number): ShellSink {
  return io.outputs.get(fd) ?? nullSink;
}

function writerSink(writer: ProcessWriter): ShellSink {
  return {
    write: async (chunk) => {
      await writer.write(chunk);
    }
  };
}

function createPipe(): {
  readonly sink: ShellSink;
  readonly input: ShellInput;
  close(): Promise<void>;
  abandon(): void;
} {
  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  const reader = transform.readable.getReader();
  let broken = false;
  return {
    sink: {
      write: async (chunk) => {
        if (broken) return;
        try {
          await writer.write(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        } catch {
          broken = true;
        }
      }
    },
    input: new ShellInput(async () => (await reader.read()).value),
    close: async () => {
      await writer.close().catch(() => undefined);
    },
    // The reading stage is gone: fail writers instead of leaving them blocked on backpressure.
    abandon: () => {
      broken = true;
      void reader.cancel().catch(() => undefined);
    }
  };
}

async function pump(source: ReadableStream<Uint8Array>, sink: ShellSink): Promise<void> {
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      await sink.write(value);
    }
  } catch {
    // A failed stream surfaces through the child's exit.
  } finally {
    reader.releaseLock();
  }
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

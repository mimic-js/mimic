import { parseNodeCommandLine } from './node-command-line';
import type { RuntimeProgramRequest } from './process-execution';

export interface ExecutableFileSystemPort {
  normalizePath(input: string, cwd: string): string;
  isFile(path: string): boolean | Promise<boolean>;
  /** The path with every symbolic link resolved; absent when links are not represented. */
  realpath?(path: string): string | Promise<string>;
  readBytes(path: string): Uint8Array | Promise<Uint8Array>;
  readText(path: string): string | Promise<string>;
}

export type BinaryExecutableInspection =
  | { readonly kind: 'unrecognized' }
  | { readonly kind: 'supported' }
  | {
      readonly kind: 'unsupported';
      readonly code:
        | 'INVALID_WASM_EXECUTABLE'
        | 'WASI_EXECUTABLE_LIBRARY'
        | 'UNSUPPORTED_WASI_ABI'
        | 'UNKNOWN_WASI_IMPORT';
      readonly message: string;
    };

export interface RuntimeProgramDefinition {
  readonly id: string;
  readonly commands: readonly string[];
  readonly inspectsExecutable?: boolean;
  inspect?(
    bytes: Uint8Array
  ): BinaryExecutableInspection | Promise<BinaryExecutableInspection>;
}

export interface JavaScriptProgramDefinition {
  readonly programId: string;
  readonly interpreterNames: readonly string[];
  readonly interpreterPaths: readonly string[];
}

export interface ShellProgramDefinition {
  readonly programId: string;
  readonly interpreterNames: readonly string[];
}

/**
 * A JavaScript entry a Runtime Program runs in its place, wherever the file
 * was installed: a package's copy of a toolchain the runtime provides itself.
 */
export interface ScriptProgramDefinition {
  readonly programId: string;
  /** The end of the entry's path, from a `node_modules` directory on. */
  readonly pathSuffix: string;
}

export interface ExecutableResolutionOptions {
  readonly fileSystem: ExecutableFileSystemPort;
  readonly runtimePrograms: readonly RuntimeProgramDefinition[];
  readonly scriptPrograms?: readonly ScriptProgramDefinition[];
  readonly javaScript: JavaScriptProgramDefinition;
  /** Absent when no Shell Program can interpret `#!/bin/sh` scripts. */
  readonly shell?: ShellProgramDefinition;
}

export type ResolvedExecutable = {
  readonly programId: string;
  readonly argv: readonly string[];
  readonly inlineEntry?: InlineNodeEntry;
  readonly provenance: {
    readonly kind: 'runtime-program' | 'file' | 'path' | 'shebang' | 'shell-wrapper';
    readonly command: string;
    readonly paths: readonly string[];
  };
};

export type InlineNodeEntry = {
  readonly source: string;
  readonly applicationArgs: readonly string[];
  readonly execArgv: readonly string[];
  /** Every option except the inline source, re-read when the projected entry runs. */
  readonly preloadArgv: readonly string[];
  /** `-p`: print the completion value of the source. */
  readonly print?: true;
  readonly inputType?: 'module' | 'commonjs';
};

export type ExecutableResolutionError = {
  readonly code:
    | 'EXECUTABLE_NOT_FOUND'
    | 'UNSUPPORTED_INTERPRETER'
    | 'RESOLUTION_CYCLE'
    | 'INVALID_INLINE_ENTRY'
    | 'INVALID_WASM_EXECUTABLE'
    | 'WASI_EXECUTABLE_LIBRARY'
    | 'UNSUPPORTED_WASI_ABI'
    | 'UNKNOWN_WASI_IMPORT';
  readonly message: string;
  readonly command: string;
  readonly paths: readonly string[];
};

export type ExecutableResolutionResult =
  | { readonly ok: true; readonly value: ResolvedExecutable }
  | { readonly ok: false; readonly error: ExecutableResolutionError };

type ResolutionState = Readonly<{
  cwd: string;
  pathEnvironment: string;
  originalCommand: string;
  options: ExecutableResolutionOptions;
  visited: readonly string[];
}>;

export function resolveExecutable(
  request: RuntimeProgramRequest,
  options: ExecutableResolutionOptions
): Promise<ExecutableResolutionResult> {
  return resolveCommand(request.command, request.args, {
    cwd: request.cwd,
    pathEnvironment: request.env.PATH ?? '',
    originalCommand: request.command,
    options,
    visited: []
  });
}

async function resolveCommand(
  command: string,
  args: readonly string[],
  state: ResolutionState
): Promise<ExecutableResolutionResult> {
  const runtimeProgram = findRuntimeProgram(command, state.options.runtimePrograms);
  if (runtimeProgram) {
    const inlineEntry =
      runtimeProgram.id === state.options.javaScript.programId
        ? resolveInlineNodeEntry(args)
        : undefined;
    if (inlineEntry?.ok === false) {
      return failure(
        'INVALID_INLINE_ENTRY',
        inlineEntry.message,
        state.originalCommand,
        state.visited
      );
    }
    const script = runtimeProgram.id === state.options.javaScript.programId && !inlineEntry
      ? scriptProgramFor(args, state.options)
      : undefined;
    if (script) return resolved(script.programId, script.args, 'runtime-program', state.originalCommand, state.visited);
    return resolved(
      runtimeProgram.id,
      args,
      'runtime-program',
      state.originalCommand,
      state.visited,
      inlineEntry?.value
    );
  }
  if (command.includes('/')) {
    return resolveFile(
      state.options.fileSystem.normalizePath(command, state.cwd),
      args,
      state,
      'file'
    );
  }

  const searched: string[] = [];
  for (const directory of state.pathEnvironment.split(':')) {
    const candidate = state.options.fileSystem.normalizePath(`${directory || '.'}/${command}`, state.cwd);
    searched.push(candidate);
    if (!(await state.options.fileSystem.isFile(candidate))) continue;
    return resolveFile(candidate, args, state, 'path');
  }
  return missing(state.originalCommand, [...state.visited, ...searched]);
}

async function resolveFile(
  path: string,
  args: readonly string[],
  state: ResolutionState,
  fallbackKind: 'file' | 'path'
): Promise<ExecutableResolutionResult> {
  if (state.visited.includes(path) || state.visited.length >= 32) {
    return cycle(state.originalCommand, [...state.visited, path]);
  }
  if (!(await state.options.fileSystem.isFile(path))) {
    return missing(state.originalCommand, [...state.visited, path]);
  }
  // A bin link a package manager made (`node_modules/.bin/tool`) runs the
  // file it points at, under that file's own name and package.
  const real = (await state.options.fileSystem.realpath?.(path)) ?? path;
  if (real !== path) {
    if (state.visited.includes(real)) return cycle(state.originalCommand, [...state.visited, path, real]);
    path = real;
  }

  const paths = [...state.visited, path];
  const nextState = { ...state, visited: paths };
  const bytes = await state.options.fileSystem.readBytes(path);
  for (const program of state.options.runtimePrograms) {
    const inspection = await program.inspect?.(bytes);
    if (inspection?.kind === 'supported') {
      return resolved(
        program.id,
        [path, ...args],
        fallbackKind,
        state.originalCommand,
        paths
      );
    }
    if (inspection?.kind === 'unsupported') {
      return failure(
        inspection.code,
        inspection.message,
        state.originalCommand,
        paths
      );
    }
  }
  const source = await state.options.fileSystem.readText(path);
  const shellWrapper = parseExecutableShellWrapper(source);
  if (shellWrapper) {
    const target = await resolveCommand(shellWrapper.command, [...shellWrapper.args, ...args], nextState);
    return target.ok
      ? withProvenance(target.value, 'shell-wrapper', state.originalCommand, target.value.provenance.paths)
      : target;
  }
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  if (firstLine.startsWith('#!')) {
    const shebang = parseShebang(firstLine);
    const programId = shebang && resolveInterpreterProgram(shebang.interpreter, state.options);
    if (!shebang || !programId) {
      return unsupportedInterpreter(state.originalCommand, firstLine.slice(2).trim(), paths);
    }
    const script = programId === state.options.javaScript.programId
      ? scriptProgramFor([...shebang.args, path, ...args], state.options)
      : undefined;
    if (script) return resolved(script.programId, script.args, 'shebang', state.originalCommand, paths);
    return resolved(programId, [...shebang.args, path, ...args], 'shebang', state.originalCommand, paths);
  }
  const script = scriptProgramFor([path, ...args], state.options);
  if (script) return resolved(script.programId, script.args, fallbackKind, state.originalCommand, paths);
  return resolved(state.options.javaScript.programId, [path, ...args], fallbackKind, state.originalCommand, paths);
}

function findRuntimeProgram(
  command: string,
  programs: readonly RuntimeProgramDefinition[]
): RuntimeProgramDefinition | undefined {
  return programs.find((program) => program.commands.includes(command));
}

/**
 * Splits a `#!` line into its interpreter and the arguments placed before the
 * script path. `env` is looked through, including its `-S` split-string form.
 */
function parseShebang(
  line: string
): { readonly interpreter: string; readonly args: readonly string[] } | undefined {
  if (!line.startsWith('#!')) return undefined;
  const words = parseShellWords(line.slice(2).trim());
  if (!words || words.length === 0) return undefined;
  if (basename(words[0]!) !== 'env') return { interpreter: words[0]!, args: words.slice(1) };
  let index = 1;
  while (index < words.length) {
    const word = words[index]!;
    if (word === '-S' || word === '--split-string') {
      index += 1;
    } else if (word.startsWith('-S') || word.startsWith('--split-string=')) {
      // `-Snode --flag` arrives as one kernel argument; the remainder is the command.
      const remainder = word.startsWith('-S') ? word.slice(2) : word.slice('--split-string='.length);
      return remainder === ''
        ? undefined
        : { interpreter: remainder, args: words.slice(index + 1) };
    } else {
      break;
    }
  }
  const interpreter = words[index];
  // Options that change the environment (`-i`, `-u`, `NAME=value`) cannot be honoured by resolution.
  if (interpreter === undefined || interpreter.startsWith('-') || interpreter.includes('=')) return undefined;
  return { interpreter, args: words.slice(index + 1) };
}

function resolveInterpreterProgram(
  interpreter: string,
  options: ExecutableResolutionOptions
): string | undefined {
  const name = basename(interpreter);
  if (
    options.javaScript.interpreterPaths.includes(interpreter) ||
    options.javaScript.interpreterNames.includes(name)
  ) {
    return options.javaScript.programId;
  }
  return options.shell?.interpreterNames.includes(name) ? options.shell.programId : undefined;
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parseExecutableShellWrapper(
  source: string
): { readonly command: string; readonly args: readonly string[] } | undefined {
  const lines = source.trimEnd().split(/\r?\n/);
  if (lines.length !== 2 || lines[0] !== '#!/bin/sh') return undefined;
  const commandLine = lines[1];
  if (!commandLine?.startsWith('exec ')) return undefined;
  const tokens = parseShellWords(commandLine.slice('exec '.length));
  if (!tokens || tokens.length < 2 || tokens.at(-1) !== '$@') return undefined;
  return { command: tokens[0]!, args: tokens.slice(1, -1) };
}

function parseShellWords(source: string): string[] | undefined {
  const words: string[] = [];
  let word = '';
  let quote: 'single' | 'double' | undefined;
  let escaped = false;
  const pushWord = () => {
    if (word === '') return;
    words.push(word);
    word = '';
  };
  for (const character of source) {
    if (escaped) {
      word += character;
      escaped = false;
      continue;
    }
    if (character === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (character === "'" && quote !== 'double') {
      quote = quote === 'single' ? undefined : 'single';
      continue;
    }
    if (character === '"' && quote !== 'single') {
      quote = quote === 'double' ? undefined : 'double';
      continue;
    }
    if (/\s/.test(character) && !quote) {
      pushWord();
      continue;
    }
    word += character;
  }
  if (quote || escaped) return undefined;
  pushWord();
  return words;
}

/** The script program a JavaScript entry is substituted by, with the arguments after the entry. */
function scriptProgramFor(
  argv: readonly string[],
  options: ExecutableResolutionOptions
): { readonly programId: string; readonly args: readonly string[] } | undefined {
  if (!options.scriptPrograms?.length) return undefined;
  const entryIndex = argv.findIndex((argument) => !argument.startsWith('-'));
  const entry = argv[entryIndex];
  if (entry === undefined) return undefined;
  const program = options.scriptPrograms.find((candidate) => entry.endsWith(candidate.pathSuffix));
  return program && { programId: program.programId, args: argv.slice(entryIndex + 1) };
}

function resolved(
  programId: string,
  argv: readonly string[],
  kind: ResolvedExecutable['provenance']['kind'],
  command: string,
  paths: readonly string[],
  inlineEntry?: InlineNodeEntry
): ExecutableResolutionResult {
  return {
    ok: true,
    value: Object.freeze({
      programId,
      argv: Object.freeze([...argv]),
      ...(inlineEntry ? { inlineEntry } : {}),
      provenance: Object.freeze({
        kind,
        command,
        paths: Object.freeze([...paths])
      })
    })
  };
}

function missing(command: string, paths: readonly string[]): ExecutableResolutionResult {
  return failure('EXECUTABLE_NOT_FOUND', `Executable program was not found: ${command}`, command, paths);
}

function unsupportedInterpreter(
  command: string,
  interpreter: string,
  paths: readonly string[]
): ExecutableResolutionResult {
  return failure(
    'UNSUPPORTED_INTERPRETER',
    `Executable program ${command} requires an unsupported interpreter: ${interpreter}`,
    command,
    paths
  );
}

function cycle(command: string, paths: readonly string[]): ExecutableResolutionResult {
  return failure(
    'RESOLUTION_CYCLE',
    `Executable program resolution encountered a cycle: ${command}`,
    command,
    paths
  );
}

function failure(
  code: ExecutableResolutionError['code'],
  message: string,
  command: string,
  paths: readonly string[]
): ExecutableResolutionResult {
  return {
    ok: false,
    error: Object.freeze({
      code,
      message,
      command,
      paths: Object.freeze([...paths])
    })
  };
}

function withProvenance(
  executable: ResolvedExecutable,
  kind: ResolvedExecutable['provenance']['kind'],
  command: string,
  paths: readonly string[]
): ExecutableResolutionResult {
  return resolved(executable.programId, executable.argv, kind, command, paths, executable.inlineEntry);
}

export function resolveInlineNodeEntry(
  args: readonly string[]
):
  | { readonly ok: true; readonly value: InlineNodeEntry }
  | { readonly ok: false; readonly message: string }
  | undefined {
  const commandLine = parseNodeCommandLine(args);
  if (!commandLine.ok) {
    // Any other malformed command line is reported by the node Runtime Program itself.
    return commandLine.missingInlineSource
      ? { ok: false, message: commandLine.message }
      : undefined;
  }
  const { action, applicationArgs, execArgv, optionArgv, inputType } = commandLine.value;
  if (action.kind !== 'eval') return undefined;

  return {
    ok: true,
    value: Object.freeze({
      source: action.source,
      applicationArgs,
      execArgv,
      preloadArgv: optionArgv,
      ...(action.print ? { print: true as const } : {}),
      ...(inputType ? { inputType } : {})
    })
  };
}

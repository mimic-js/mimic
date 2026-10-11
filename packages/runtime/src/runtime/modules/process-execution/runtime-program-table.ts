import {
  coreUtilityDefinitions,
  createCoreUtilities,
  type CoreUtilityFileSystem
} from './core-utilities';
import type {
  BinaryExecutableInspection,
  RuntimeProgramDefinition
} from './executable-resolution';
import type { ProcessFileSystemClient } from './file-system-ports';
import {
  createPackageManagerCommandProxies,
  packageManagerRuntimeProgramDefinitions,
  type PackageManagerCommandProxyContext
} from './package-manager-command-proxies';
import type { RuntimeProgramRequest } from './process-execution';
import { closedProcessInput, readableProcessInput } from './process-streams';
import type { RuntimeProgramResolution } from './runtime-processes';
import {
  createRuntimeProgramRegistry,
  type RuntimeProgram,
  type RuntimeProgramRegistry
} from './runtime-programs';
import {
  createShellProgram,
  SHELL_INTERPRETER_NAMES,
  SHELL_PROGRAM_COMMANDS,
  type ShellProgramServices
} from './shell-program';
import type { RuntimeProgramProcess } from './virtual-process';

/** The Runtime Programs another module implements, as the composition hands them to Process Execution. */
export interface InjectedRuntimePrograms {
  /**
   * The JavaScript interpreter. Its bare commands are the interpreter names
   * and its absolute commands the interpreter paths a shebang may name.
   */
  readonly javaScript: Pick<RuntimeProgramDefinition, 'id' | 'commands'>;
  /** The WASI program, which owns no command and claims the executables its inspection supports. */
  readonly wasi: {
    readonly id: string;
    inspect(bytes: Uint8Array): BinaryExecutableInspection | Promise<BinaryExecutableInspection>;
  };
}

/** What the shell, the core utilities and the Command Proxies read from the context they run in. */
export type RuntimeProgramTableContext = PackageManagerCommandProxyContext & {
  readonly ppid?: number;
};

export interface RuntimeProgramTableOptions<Context extends RuntimeProgramTableContext> {
  readonly programs: InjectedRuntimePrograms;
  /** One implementation for each injected program, matched by id. */
  readonly implementations: readonly Pick<RuntimeProgram<Context>, 'id' | 'run' | 'handlesSignals'>[];
  /** Replaces the registered Runtime Programs; a test runs its own programs this way. */
  readonly replacement?: readonly RuntimeProgram<Context>[];
  /** The view of a context's files the shell and the core utilities use. */
  files(context: Context): CoreUtilityFileSystem;
  /** The Virtual File System the Command Proxies install into. */
  readonly fileSystem: ProcessFileSystemClient;
  /** Starts a child Runtime Process. */
  spawnChild(request: RuntimeProgramRequest): Promise<RuntimeProgramProcess>;
  /** Replaces the calling Runtime Process with another program, as `exec` does. */
  replaceProgram(
    request: Omit<RuntimeProgramRequest, 'parentPid'>,
    context: Context
  ): Promise<number>;
  /** A package manager changed the packages installed in `cwd`. */
  readonly onPackagesInstalled?: (cwd: string) => void;
}

export interface RuntimeProgramTable<Context> {
  /** Every Runtime Program, bound to its implementation. */
  readonly registry: RuntimeProgramRegistry<RuntimeProgram<Context>>;
  /** How Process Execution resolves a command against {@link registry}. */
  readonly resolution: RuntimeProgramResolution;
}

type RegisteredRuntimeProgram = RuntimeProgramDefinition &
  Pick<RuntimeProgram, 'classificationOnly'>;

/**
 * The one table of Runtime Programs: the injected JavaScript and WASI programs
 * beside Process Execution's own shell, core utilities and Command Proxies.
 */
export function createRuntimeProgramTable<Context extends RuntimeProgramTableContext>(
  options: RuntimeProgramTableOptions<Context>
): RuntimeProgramTable<Context> {
  const runtimeProgramDefinitions = runtimeProgramDefinitionsWith(options.programs);
  const shell = createShellProgram();
  const runShell = (
    argv: readonly string[],
    env: Readonly<Record<string, string>>,
    context: Context
  ): Promise<number> =>
    shell.run(
      {
        argv,
        cwd: context.cwd,
        env,
        pid: context.pid ?? 0,
        parentPid: context.ppid ?? 0,
        stdin: context.input ?? closedProcessInput,
        stdout: context.writer,
        stderr: context.errorWriter ?? context.writer,
        signal:
          context.signal ??
          new Promise<never>(() => undefined)
      },
      shellServices(context)
    );
  const coreUtilities = createCoreUtilities(() =>
    runtimeProgramDefinitions.map((program) => program.commands)
  );
  const registry = options.replacement
    ? createRuntimeProgramRegistry(options.replacement)
    : bindRuntimePrograms<Context>(runtimeProgramDefinitions, [
        {
          id: shell.id,
          handlesSignals: true,
          run: (args, context) => runShell(args, context.env, context)
        },
        ...coreUtilities.map(
          (utility): Pick<RuntimeProgram<Context>, 'id' | 'run'> => ({
            id: utility.id,
            run: (args, context) =>
              utility.run(args, {
                cwd: context.cwd,
                env: context.env,
                stdin: context.input ?? closedProcessInput,
                stdout: context.writer,
                stderr: context.errorWriter ?? context.writer,
                fileSystem: options.files(context),
                // `env command ...` hands the process to the command through the
                // Shell Program's admitted replacement.
                exec: (argv, env) =>
                  runShell(['-c', 'exec "$@"', 'env', ...argv], env, context)
              })
          })
        ),
        ...options.implementations,
        ...createPackageManagerCommandProxies<Context>({
          fileSystem: options.fileSystem,
          spawnProgram: (request) => options.spawnChild(request),
          replaceProgram: (request, context) => options.replaceProgram(request, context),
          onInstalled: options.onPackagesInstalled
        })
      ]);

  function shellServices(context: Context): ShellProgramServices {
    return {
      files: options.files(context),
      children: {
        spawn: async (request) => {
          const child = await options.spawnChild({
            command: request.command,
            args: request.args,
            cwd: request.cwd,
            env: request.env,
            parentPid: request.parentPid
          });
          const inputAbort = new AbortController();
          const inputForwarding = request.stdin
            .pipeTo(child.stdin, { signal: inputAbort.signal })
            .catch(() => undefined);
          return {
            ...child,
            exit: child.exit.finally(async () => {
              inputAbort.abort();
              await inputForwarding;
            })
          };
        }
      },
      replace: (request) =>
        options.replaceProgram(
          { command: request.command, args: request.args, cwd: request.cwd, env: request.env },
          { ...context, input: readableProcessInput(request.stdin) }
        )
    };
  }

  return {
    registry,
    resolution: runtimeProgramResolution(options.programs.javaScript, registry.programs)
  };
}

/**
 * Every Runtime Program Mimic runs, by id with the commands it owns.
 * Process Execution resolves commands against this one table, wherever it runs.
 */
function runtimeProgramDefinitionsWith(
  programs: InjectedRuntimePrograms
): readonly RegisteredRuntimeProgram[] {
  return [
    { id: 'sh', commands: SHELL_PROGRAM_COMMANDS },
    { id: programs.javaScript.id, commands: programs.javaScript.commands },
    ...coreUtilityDefinitions,
    ...packageManagerRuntimeProgramDefinitions(),
    {
      id: programs.wasi.id,
      commands: [],
      classificationOnly: true,
      inspect: programs.wasi.inspect
    }
  ];
}

/** How a resolved command finds its interpreter, given the programs to resolve against. */
function runtimeProgramResolution(
  javaScript: InjectedRuntimePrograms['javaScript'],
  programs: readonly RuntimeProgramDefinition[]
): RuntimeProgramResolution {
  return {
    runtimePrograms: programs,
    // A package's own copy of node-gyp runs the runtime's native build (ADR-0040).
    scriptPrograms: [{ programId: 'node-gyp', pathSuffix: '/node_modules/node-gyp/bin/node-gyp.js' }],
    javaScript: {
      programId: javaScript.id,
      interpreterNames: javaScript.commands.filter((command) => !command.startsWith('/')),
      interpreterPaths: javaScript.commands.filter((command) => command.startsWith('/'))
    },
    shell: { programId: 'sh', interpreterNames: SHELL_INTERPRETER_NAMES }
  };
}

/** Binds one implementation to each registered Runtime Program. */
function bindRuntimePrograms<Context>(
  runtimeProgramDefinitions: readonly RegisteredRuntimeProgram[],
  implementations: readonly Pick<RuntimeProgram<Context>, 'id' | 'run' | 'handlesSignals'>[]
): RuntimeProgramRegistry<RegisteredRuntimeProgram & RuntimeProgram<Context>> {
  const byId = new Map(implementations.map((program) => [program.id, program] as const));
  if (byId.size !== implementations.length) {
    throw new Error('A Runtime Program is implemented more than once.');
  }
  const programs = runtimeProgramDefinitions.map((definition) => {
    const implementation = byId.get(definition.id);
    if (!implementation) {
      throw new Error(`Runtime Program "${definition.id}" has no implementation.`);
    }
    byId.delete(definition.id);
    return {
      ...definition,
      ...(implementation.handlesSignals ? { handlesSignals: true } : {}),
      run: (args: readonly string[], context: Context) => implementation.run(args, context)
    };
  });
  const unregistered = [...byId.keys()];
  if (unregistered.length > 0) {
    throw new Error(`Runtime Programs are not registered: ${unregistered.join(', ')}.`);
  }
  return createRuntimeProgramRegistry(programs);
}

import { createArtifactCache, type ArtifactCache } from './package-manager/artifact-cache';
import {
  applyBrowserPackageReplacements,
  BROWSER_PACKAGE_EXECUTABLE_REPLACEMENTS,
  packageTree,
  resolveReplacementExecutable,
  type BrowserPackageExecutableReplacement
} from './package-manager/browser-package-replacements';
import { extractNpmTarball } from './package-manager/npm-tarball';
import {
  acquirePinnedTarball,
  acquireRegistryTarball,
  type PackageArtifactFetch
} from './package-manager/package-artifacts';
import {
  PACKAGE_MANAGER_CLIS,
  packageManagerInstallState,
  packageManagerPackageName,
  requestedPackageManagerRelease,
  type PackageManagerCli,
  type RequestedPackageManagerRelease
} from './package-manager/package-manager-clis';
import type { TarballEntry } from './package-manager/npm-tarball';
import type { ProcessFileSystemClient } from './file-system-ports';
import type {
  ResolvedExecutable,
  RuntimeProgramDefinition
} from './executable-resolution';
import type { RuntimeProgramRequest } from './process-execution';
import type { RuntimeProgram } from './runtime-programs';
import type {
  ProcessInput,
  ProcessWriter,
  RuntimeProgramProcess
} from './virtual-process';

export type PackageManagerCommandProxyContext = Readonly<{
  cwd: string;
  env: Readonly<Record<string, string>>;
  executable?: ResolvedExecutable;
  pid?: number;
  signal?: Promise<'SIGTERM' | 'SIGKILL' | 'SIGINT'>;
  onSignal?: (listener: (signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT') => void) => () => void;
  fs: ProcessFileSystemClient;
  writer: ProcessWriter;
  errorWriter?: ProcessWriter;
  input?: ProcessInput;
}>;

export type PackageManagerCommandProxyServices<Context> = Readonly<{
  fileSystem: ProcessFileSystemClient;
  /** Starts an ordinary child Runtime Process. */
  spawnProgram(request: RuntimeProgramRequest): Promise<RuntimeProgramProcess>;
  /** Replaces the calling Runtime Process with another program, as `exec` does. */
  replaceProgram(request: Omit<RuntimeProgramRequest, 'parentPid'>, context: Context): Promise<number>;
  cache?: ArtifactCache;
  fetch?: PackageArtifactFetch;
  /** Called once an install changed the packages in `cwd` and their replacements are applied. */
  onInstalled?(cwd: string): void;
}>;

const CLI_ROOT = '/.mimic/toolchains';

/**
 * The npm, pnpm and Yarn Command Proxies, and the launchers of executable
 * Browser Package Replacements. A Command Proxy runs the pinned CLI as a child
 * Runtime Process with the caller's arguments untouched, passes its output and
 * exit code through, and applies the Browser Package Replacements after the
 * CLI has changed the installed packages.
 */
export function createPackageManagerCommandProxies<
  Context extends PackageManagerCommandProxyContext
>(services: PackageManagerCommandProxyServices<Context>): readonly RuntimeProgram<Context>[] {
  const cache = services.cache ?? createArtifactCache();
  const fetchArtifact = services.fetch ?? ((url: string) => fetch(url));
  const replacementServices = { fileSystem: services.fileSystem, cache, fetch: fetchArtifact };
  const npm = PACKAGE_MANAGER_CLIS.find((cli) => cli.manager === 'npm')!;
  const materializedClis = new Map<string, Promise<string>>();
  const materializedReleases = new Map<string, Promise<PackageManagerCli>>();
  let launchers: Promise<void> | undefined;

  const materializeCli = (cli: PackageManagerCli): Promise<string> => {
    let root = materializedClis.get(cli.id);
    if (!root) {
      root = (async () => {
        const files = await extractNpmTarball(await acquirePinnedTarball(cache, cli, fetchArtifact));
        const directory = `${CLI_ROOT}/${cli.manager}/${cli.version}`;
        await services.fileSystem.mount(packageTree(files), directory);
        return directory;
      })();
      materializedClis.set(cli.id, root);
      void root.catch(() => materializedClis.delete(cli.id));
    }
    return root;
  };

  /**
   * The release a project's `packageManager` field asks for, from the npm
   * registry, verified against the integrity the registry states and against
   * the field's own hash when it names one, as Corepack installs it. A
   * release is kept per hash too, so a field that names another hash for a
   * release already installed is checked against its bytes again.
   */
  const materializeRelease = (
    cli: PackageManagerCli,
    release: RequestedPackageManagerRelease
  ): Promise<PackageManagerCli> => {
    const id = `${release.manager}@${release.version}`;
    const key = release.hash ? `${id}+${release.hash.algorithm}.${release.hash.hex}` : id;
    let materialized = materializedReleases.get(key);
    if (!materialized) {
      materialized = (async () => {
        const packageName = packageManagerPackageName(release.manager, release.version);
        const bytes = await acquireRegistryTarball(cache, packageName, release.version, fetchArtifact);
        const files = await extractNpmTarball(bytes);
        const bin = binOf(files, packageName);
        if (release.hash) await verifyReleaseHash(release, bytes, files, bin[release.manager]);
        const directory = `${CLI_ROOT}/${release.manager}/${release.version}`;
        await services.fileSystem.mount(packageTree(files), directory);
        return Object.freeze({
          ...cli,
          id: `toolchain:${id}`,
          version: release.version,
          packageName,
          tarballUrl: '',
          integrity: '',
          bin,
          installState: packageManagerInstallState(release.manager, release.version)
        });
      })();
      materializedReleases.set(key, materialized);
      void materialized.catch(() => materializedReleases.delete(key));
    }
    return materialized;
  };

  /** The CLI an invocation runs, and the directory it is materialized in. */
  const cliFor = async (
    pinned: PackageManagerCli,
    release: RequestedPackageManagerRelease | undefined
  ): Promise<{ readonly cli: PackageManagerCli; readonly root: string }> => {
    if (!release) return { cli: pinned, root: await materializeCli(pinned) };
    const cli = await materializeRelease(pinned, release);
    return { cli, root: `${CLI_ROOT}/${cli.manager}/${cli.version}` };
  };

  // The source package checks that its binary path exists before it uses it.
  const materializeLaunchers = (): Promise<void> => {
    launchers ??= Promise.all(BROWSER_PACKAGE_EXECUTABLE_REPLACEMENTS.map(async (entry) => {
      await services.fileSystem.mkdir(entry.launcher.slice(0, entry.launcher.lastIndexOf('/')), {
        recursive: true
      });
      await services.fileSystem.writeFile(
        entry.launcher,
        `#!/bin/sh\n# Mimic runs ${entry.replacement} for the calling ${entry.source} package.\n`
      );
    })).then(() => undefined);
    void launchers.catch(() => {
      launchers = undefined;
    });
    return launchers;
  };

  const replacementEnvironment = Object.fromEntries(
    BROWSER_PACKAGE_EXECUTABLE_REPLACEMENTS.map((entry) => [entry.environmentVariable, entry.launcher])
  );

  const runCli = async (pinned: PackageManagerCli, args: readonly string[], context: Context): Promise<number> => {
    const stderr = context.errorWriter ?? context.writer;
    const command = context.executable?.provenance.command ?? pinned.manager;
    let release: RequestedPackageManagerRelease | undefined;
    try {
      release = requestedPackageManagerRelease(pinned, await requestedPackageManager(context.fs, context.cwd));
    } catch (error) {
      await stderr.write(`${command}: ${messageOf(error)}\n`);
      return 1;
    }
    let cli: PackageManagerCli;
    let root: string;
    try {
      [{ cli, root }] = await Promise.all([cliFor(pinned, release), materializeLaunchers()]);
    } catch (error) {
      if (!release) throw error;
      await stderr.write(
        `${command}: package.json asks for ${release.manager}@${release.version}, ` +
          `which could not be installed: ${messageOf(error)}\n`
      );
      return 1;
    }
    const stateBefore = await installStamp(context.fs, context.cwd, cli);
    const child = await services.spawnProgram({
      command: `${root}/${cli.bin[command] ?? cli.bin[cli.manager]}`,
      args,
      cwd: context.cwd,
      env: { ...cli.environment, ...replacementEnvironment, ...context.env },
      parentPid: context.pid ?? 0
    });
    const output = createOutputTail();
    const exitCode = await runChild(child, context, output);
    if ((await installStamp(context.fs, context.cwd, cli)) === stateBefore) return exitCode;
    // A manager that changed the installed packages and then failed may have
    // failed in the project's own install scripts, which it runs before the
    // replacements are in place (`nuxt prepare` loading a WASI binding). Only
    // that failure, as the manager reports it, is worth running them again
    // for, and only when the scripts were to run at all.
    if (
      exitCode !== 0 &&
      ((await scriptsIgnored(args, { ...cli.environment, ...context.env }, context)) ||
        !(await reportsFailedProjectScript(output.text(), context)))
    ) {
      return exitCode;
    }
    try {
      let companions = 0;
      const applied = await applyBrowserPackageReplacements(
        {
          ...replacementServices,
          installCompanion: async (directory, spec) => {
            companions += 1;
            await installCompanion(directory, spec, context);
          }
        },
        context.cwd
      );
      for (const statement of applied.statements) await stderr.write(`${command}: ${statement}\n`);
      const environment = { ...cli.environment, ...replacementEnvironment, ...context.env };
      for (const directory of applied.swapped) {
        const failure = await runScripts(directory, DEPENDENCY_INSTALL_SCRIPTS, environment, context);
        if (failure) {
          await stderr.write(
            `${command}: the ${failure.script} script of ${failure.packageId}, which replaced the installed version, exited with ${failure.exitCode}.\n`
          );
          return 1;
        }
      }
      if (exitCode !== 0) {
        if (applied.swapped.length === 0 && companions === 0) return exitCode;
        await stderr.write(
          `${command}: the Browser Package Replacements are now in place; the project's install scripts run again.\n`
        );
        const failure = await runScripts(context.cwd, PROJECT_INSTALL_SCRIPTS, environment, context);
        if (failure) {
          await stderr.write(`${command}: the ${failure.script} script of ${failure.packageId} exited with ${failure.exitCode}.\n`);
          return exitCode;
        }
      }
      services.onInstalled?.(context.cwd);
      return 0;
    } catch (error) {
      await stderr.write(
        `${command}: the Browser Package Replacements could not be applied: ${messageOf(error)}\n`
      );
      return 1;
    }
  };

  /**
   * Runs the named scripts of the package in `directory` in order, as its
   * manager would: with the `.bin` directories above it on `PATH` and npm's
   * lifecycle variables. Returns the first that failed.
   */
  const runScripts = async (
    directory: string,
    names: readonly string[],
    env: Record<string, string>,
    context: Context
  ): Promise<{ readonly script: string; readonly packageId: string; readonly exitCode: number } | undefined> => {
    const manifest = await readManifest(directory, context);
    const packageId = `${manifest?.name ?? directory}${manifest?.version ? `@${manifest.version}` : ''}`;
    for (const name of names) {
      const script = manifest?.scripts?.[name];
      if (typeof script !== 'string') continue;
      const child = await services.spawnProgram({
        command: 'sh',
        args: ['-c', script],
        cwd: directory,
        env: {
          ...env,
          PATH: [...binDirectories(directory), env.PATH].filter(Boolean).join(':'),
          npm_lifecycle_event: name,
          npm_lifecycle_script: script,
          npm_package_json: `${directory}/package.json`,
          ...(manifest?.name ? { npm_package_name: manifest.name } : {}),
          ...(manifest?.version ? { npm_package_version: manifest.version } : {}),
          INIT_CWD: context.cwd
        },
        parentPid: context.pid ?? 0
      });
      const exitCode = await runChild(child, context);
      if (exitCode !== 0) return { script: name, packageId, exitCode };
    }
    return undefined;
  };

  /**
   * Whether the manager's output names one of the project's install scripts
   * as one it ran and saw fail: npm reports `command sh -c <script>`, pnpm
   * `<directory> <event>$ <script>` and Yarn 1 `$ <script>`.
   */
  const reportsFailedProjectScript = async (output: string, context: Context): Promise<boolean> => {
    const scripts = (await readManifest(context.cwd, context))?.scripts;
    const text = output.replace(ANSI_ESCAPE, '');
    return PROJECT_INSTALL_SCRIPTS.some((name) => {
      const script = scripts?.[name];
      return typeof script === 'string' && (text.includes(`sh -c ${script}`) || text.includes(`$ ${script}`));
    });
  };

  /**
   * Installs a companion package with its dependencies under `directory`
   * through the pinned npm, whatever manager the project uses: npm is the
   * manager proven to fetch here. The caller's stdio receives npm's output.
   */
  const installCompanion = async (directory: string, spec: string, context: Context): Promise<void> => {
    const root = await materializeCli(npm);
    await services.fileSystem.mkdir(directory, { recursive: true });
    await services.fileSystem.writeFile(
      `${directory}/package.json`,
      JSON.stringify({ name: 'mimic-companions', private: true })
    );
    const child = await services.spawnProgram({
      command: `${root}/${npm.bin.npm}`,
      args: ['install', '--no-save', '--no-package-lock', '--ignore-scripts', '--loglevel=error', spec],
      cwd: directory,
      env: { ...npm.environment, ...context.env },
      parentPid: context.pid ?? 0
    });
    const exitCode = await runChild(child, context);
    if (exitCode !== 0) throw new Error(`npm install ${spec} exited with ${exitCode}.`);
  };

  const runLauncher = async (
    entry: BrowserPackageExecutableReplacement,
    args: readonly string[],
    context: Context,
    materialized: Map<string, Promise<string>>
  ): Promise<number> => {
    const resolution = await resolveReplacementExecutable(
      replacementServices,
      entry,
      args,
      context.cwd,
      materialized
    );
    if (resolution.kind === 'version') {
      await context.writer.write(`${resolution.version}\n`);
      return 0;
    }
    if (resolution.kind === 'unsupported') {
      await (context.errorWriter ?? context.writer).write(`${resolution.message}\n`);
      return 1;
    }
    return services.replaceProgram(
      {
        command: resolution.path,
        args,
        cwd: context.cwd,
        env: context.env
      },
      context
    );
  };

  return [
    ...PACKAGE_MANAGER_CLIS.map((cli): RuntimeProgram<Context> => ({
      id: cli.id,
      commands: Object.keys(cli.bin),
      handlesSignals: true,
      run: (args, context) => withSignalsFromStart(context, (relayed) => runCli(cli, args, relayed))
    })),
    ...BROWSER_PACKAGE_EXECUTABLE_REPLACEMENTS.map((entry): RuntimeProgram<Context> => {
      const materialized = new Map<string, Promise<string>>();
      return {
        id: launcherProgramId(entry),
        commands: [entry.launcher],
        handlesSignals: true,
        run: (args, context) => runLauncher(entry, args, context, materialized)
      };
    })
  ];
}

/**
 * Runs `body` with a context whose signals are those the invocation receives
 * from its start: one sent before a child subscribed (while the CLI is being
 * materialized, say) is delivered, once, to the first that does. The context's
 * own signal promise is not, since a shell that ran an earlier command may
 * have resolved it already.
 */
async function withSignalsFromStart<Context extends PackageManagerCommandProxyContext>(
  context: Context,
  body: (context: Context) => Promise<number>
): Promise<number> {
  if (!context.onSignal) return body(context);
  type Signal = 'SIGTERM' | 'SIGKILL' | 'SIGINT';
  const pending: Signal[] = [];
  const listeners = new Set<(signal: Signal) => void>();
  const unsubscribe = context.onSignal((signal) => {
    if (listeners.size === 0) pending.push(signal);
    for (const listener of [...listeners]) listener(signal);
  });
  try {
    return await body({
      ...context,
      onSignal(listener: (signal: Signal) => void) {
        listeners.add(listener);
        for (const signal of pending.splice(0)) listener(signal);
        return () => listeners.delete(listener);
      }
    });
  } finally {
    unsubscribe();
  }
}

/** The commands each Command Proxy and replacement launcher owns, for the Runtime Program registry. */
export function packageManagerRuntimeProgramDefinitions(): readonly RuntimeProgramDefinition[] {
  return [
    ...PACKAGE_MANAGER_CLIS.map((cli) => ({ id: cli.id, commands: Object.keys(cli.bin) })),
    ...BROWSER_PACKAGE_EXECUTABLE_REPLACEMENTS.map((entry) => ({
      id: launcherProgramId(entry),
      commands: [entry.launcher]
    }))
  ];
}

function launcherProgramId(entry: BrowserPackageExecutableReplacement): string {
  return `browser-package-replacement:${entry.source}`;
}

/**
 * The commands a manager package names in its `bin`, each to its script. A
 * single `bin` string is the command named after the package.
 */
function binOf(files: readonly TarballEntry[], packageName: string): Readonly<Record<string, string>> {
  const manifestFile = files.find((file) => file.path === 'package.json');
  if (!manifestFile) throw new Error(`${packageName} has no package.json.`);
  const manifest = JSON.parse(new TextDecoder().decode(manifestFile.data)) as { bin?: unknown };
  const entries =
    typeof manifest.bin === 'string'
      ? [[packageName.slice(packageName.lastIndexOf('/') + 1), manifest.bin]]
      : Object.entries((manifest.bin ?? {}) as Record<string, unknown>);
  const bin: Record<string, string> = {};
  for (const [name, script] of entries) {
    if (typeof script === 'string') bin[name as string] = script.replace(/^\.\//u, '');
  }
  if (Object.keys(bin).length === 0) throw new Error(`${packageName} names no bin.`);
  return Object.freeze(bin);
}

/**
 * Checks a Corepack hash. It names the downloaded archive, or, for a Yarn
 * release Corepack fetched as its single file, that file: either matches.
 */
async function verifyReleaseHash(
  release: RequestedPackageManagerRelease,
  tarball: Uint8Array,
  files: readonly TarballEntry[],
  binScript: string | undefined
): Promise<void> {
  const { algorithm, hex } = release.hash!;
  const candidates = [tarball, files.find((file) => file.path === binScript)?.data];
  for (const bytes of candidates) {
    if (bytes && (await digestHex(bytes, algorithm)) === hex) return;
  }
  throw new Error(`its ${algorithm} hash does not match ${hex}.`);
}

/**
 * Whether the invocation asked the manager not to run scripts: the
 * `--ignore-scripts` flag, the `npm_config_ignore_scripts` variable, or
 * `ignore-scripts=true` in the project's `.npmrc`, as npm and pnpm read them.
 */
async function scriptsIgnored(
  args: readonly string[],
  env: Readonly<Record<string, string>>,
  context: PackageManagerCommandProxyContext
): Promise<boolean> {
  const enabled = (value: string): boolean => !/^(?:false|0|)$/iu.test(value.trim());
  for (const argument of args) {
    if (argument === '--') break;
    if (argument === '--ignore-scripts') return true;
    if (argument.startsWith('--ignore-scripts=')) return enabled(argument.slice('--ignore-scripts='.length));
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.toLowerCase() === 'npm_config_ignore_scripts' && enabled(value)) return true;
  }
  const npmrc = await context.fs.readFile(`${context.cwd}/.npmrc`, 'utf8').catch(() => '');
  return /^\s*ignore-scripts\s*=\s*true\s*$/mu.test(npmrc);
}

/** The bytes of a manager's output kept to read which script it saw fail. */
const OUTPUT_TAIL_LENGTH = 64 * 1024;
/** The colour codes pnpm and Yarn put around a script line. */
const ANSI_ESCAPE = /\u001b\[[0-9;]*m/gu;

type OutputTail = Readonly<{ append(text: string): void; text(): string }>;

/** The last {@link OUTPUT_TAIL_LENGTH} characters a child wrote to stdout and stderr together. */
function createOutputTail(): OutputTail {
  let tail = '';
  return {
    append(text) {
      tail = (tail + text).slice(-OUTPUT_TAIL_LENGTH);
    },
    text: () => tail
  };
}

/** The scripts a manager runs for an installed dependency, in order. */
const DEPENDENCY_INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall'] as const;
/** The project's own scripts a manager runs after it installed the dependencies, in order. */
const PROJECT_INSTALL_SCRIPTS = ['install', 'postinstall', 'preprepare', 'prepare', 'postprepare'] as const;

type PackageManifest = {
  readonly name?: string;
  readonly version?: string;
  readonly scripts?: Readonly<Record<string, unknown>>;
};

async function readManifest(
  directory: string,
  context: PackageManagerCommandProxyContext
): Promise<PackageManifest | undefined> {
  try {
    return JSON.parse(await context.fs.readFile(`${directory}/package.json`, 'utf8')) as PackageManifest;
  } catch {
    return undefined;
  }
}

/** `node_modules/.bin` of `directory` and of each directory above it, nearest first. */
function binDirectories(directory: string): string[] {
  const directories: string[] = [];
  for (let current = directory; ; current = current.slice(0, current.lastIndexOf('/')) || '/') {
    directories.push(`${current === '/' ? '' : current}/node_modules/.bin`);
    if (current === '/') return directories;
  }
}

/**
 * The `package.json` whose `packageManager` field governs `cwd`: the nearest
 * one naming the field, from `cwd` upward, as Corepack finds it.
 */
async function requestedPackageManager(
  fileSystem: ProcessFileSystemClient,
  cwd: string
): Promise<string | undefined> {
  for (let directory = cwd; ; directory = directory.slice(0, directory.lastIndexOf('/')) || '/') {
    const source = await fileSystem
      .readFile(`${directory === '/' ? '' : directory}/package.json`, 'utf8')
      .catch(() => undefined);
    if (source !== undefined && /"packageManager"\s*:/u.test(source)) return source;
    if (directory === '/') return undefined;
  }
}

/**
 * The manager's install-state file, by content: what an invocation changed
 * when it changed the installed packages. Content, not size and time, so a
 * rewrite within the same millisecond is seen too.
 */
async function installStamp(
  fileSystem: ProcessFileSystemClient,
  cwd: string,
  cli: PackageManagerCli
): Promise<string> {
  const state = await fileSystem.readFile(`${cwd}/${cli.installState}`).catch(() => undefined);
  return state ? digestHex(state) : 'absent';
}

async function digestHex(bytes: Uint8Array, algorithm = 'sha256'): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = new Uint8Array(
    await crypto.subtle.digest(algorithm.replace(/^sha/u, 'SHA-'), copy.buffer)
  );
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Runs a child to completion with the caller's stdio and signals; returns its
 * exit code. What it writes is also kept in `output` when one is given.
 */
async function runChild(
  child: RuntimeProgramProcess,
  context: PackageManagerCommandProxyContext,
  output?: OutputTail
): Promise<number> {
  const inputStop = createInputStop();
  const input = forwardProcessInput(context.input, child.stdin, inputStop.stopped);
  const stdout = pipeOutput(child.stdout, context.writer, output);
  const stderr = pipeOutput(child.stderr, context.errorWriter ?? context.writer, output);
  // Every signal reaches the manager, which may handle one and keep running.
  const unsubscribe = context.onSignal?.((signal) => child.kill(signal));
  if (!unsubscribe) void context.signal?.then((signal) => child.kill(signal));
  try {
    const exitCode = await child.exit;
    await Promise.all([stdout, stderr]);
    return exitCode;
  } finally {
    unsubscribe?.();
    inputStop.stop();
    await Promise.allSettled([input, stdout, stderr]);
  }
}

function createInputStop(): { readonly stopped: Promise<void>; stop(): void } {
  let stop = (): void => undefined;
  const stopped = new Promise<void>((resolve) => {
    stop = resolve;
  });
  return { stopped, stop: () => stop() };
}

async function forwardProcessInput(
  input: ProcessInput | undefined,
  destination: WritableStream<Uint8Array>,
  stopped: Promise<void>
): Promise<void> {
  const writer = destination.getWriter();
  try {
    if (input) {
      while (true) {
        const result = await Promise.race([
          input.read().then((chunk) => ({ type: 'chunk' as const, chunk })),
          stopped.then(() => ({ type: 'stopped' as const }))
        ]);
        if (result.type === 'stopped' || !result.chunk) break;
        await writer.write(result.chunk);
      }
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
  } finally {
    writer.releaseLock();
  }
}

async function pipeOutput(
  source: ReadableStream<Uint8Array>,
  destination: ProcessWriter,
  output?: OutputTail
): Promise<void> {
  const reader = source.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      output?.append(decoder.decode(value, { stream: true }));
      await destination.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

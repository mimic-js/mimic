import { Mimic, type MimicProcess } from '../../src/runtime';
import { treeOf } from './application-tree';
import { findForbiddenFallbacks, findNativeRolldownBindings } from './forbidden-fallbacks';
import { installOrRestore, type FrozenInstall, type InstallOutcome } from './install-layer';
import { collectProcessOutput, type CollectedProcessOutput } from './process-output';

/**
 * The in-page half of a stack scenario. `stack-scenario.ts` calls these
 * functions by name through `page.evaluate`; every argument and result is
 * plain JSON.
 */

type StartedProcess = { process: MimicProcess; output: CollectedProcessOutput; ended: boolean };

export type StackPhase = Readonly<{ phase: string; ms: number }>;
export type StackProcessResult = Readonly<{ exitCode: number; output: string }>;
export type StackResponse = Readonly<{ status: number; headers: Record<string, string>; body: string }>;
export type StackRequest = Readonly<{
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}>;
export type StackEndpointEvent = Readonly<{ kind: 'published' | 'unpublished'; url: string }>;
export type StackTeardown = Readonly<{
  phases: readonly StackPhase[];
  /** Everything the scenario's processes and installs wrote. */
  transcript: string;
  /** The forbidden fallbacks named by the transcript or by npm's record of what it installed. */
  forbiddenFallbacks: readonly string[];
  /** The Rolldown bindings installed for a platform other than the virtual one. */
  nativeRolldownBindings: readonly string[];
  /** How often a 50 ms timer of the test page fired while the container lived. */
  responsiveness: Readonly<{ elapsedMs: number; ticks: number }>;
  /** Whether each part of the torn-down container refuses further use. */
  invalidated: Readonly<{ endpoints: boolean; filesystem: boolean; spawn: boolean }>;
  /** Whether a container booted after the teardown started with an empty working directory. */
  cleanReboot: boolean;
  /** The exit codes of the processes the teardown found running. */
  endedByTeardown: readonly number[];
  /** The endpoints of the scenario that still answer 200 after the teardown. */
  endpointsStillServed: readonly string[];
}>;

let container: Mimic | undefined;
const started = new Map<number, StartedProcess>();
const transcript: string[] = [];
const phases: StackPhase[] = [];
const endpointLog: StackEndpointEvent[] = [];
let heartbeat: { startedAt: number; ticks: number; timer: ReturnType<typeof setInterval> } | undefined;
let nextProcessId = 1;

async function timed<T>(phase: string, work: () => Promise<T>): Promise<T> {
  const startedAt = performance.now();
  try {
    return await work();
  } finally {
    phases.push({ phase, ms: Math.round(performance.now() - startedAt) });
  }
}

function runtime(): Mimic {
  if (!container) throw new Error('The stack scenario container is not booted');
  return container;
}

export async function boot(workdir: string, files: Readonly<Record<string, string>>): Promise<void> {
  container = await timed('boot', () => Mimic.boot({ workdir }));
  for (const kind of ['published', 'unpublished'] as const) {
    container.endpoints.on(kind, (endpoint) => endpointLog.push({ kind, url: endpoint.url }));
  }
  const beat = { startedAt: performance.now(), ticks: 0, timer: setInterval(() => (beat.ticks += 1), 50) };
  heartbeat = beat;
  await timed('mount', () => runtime().fs.mount(treeOf(files)));
}

/** Runs the frozen install, or mounts its stored layer. */
export async function install(frozen: FrozenInstall, timeoutMs: number): Promise<InstallOutcome> {
  const outcome = await timed(`install ${frozen.command} ${frozen.args.join(' ')}`.trim(), () =>
    installOrRestore(runtime(), frozen, timeoutMs)
  );
  transcript.push(outcome.output);
  return outcome;
}

/** Starts a process and answers its handle; nothing is awaited. */
export async function spawn(command: string, args: string[], env?: Record<string, string>): Promise<number> {
  const process = await runtime().spawn(command, args, env ? { env } : {});
  const id = nextProcessId++;
  const entry: StartedProcess = {
    process,
    output: collectProcessOutput(process, (chunk) => transcript.push(chunk)),
    ended: false
  };
  void process.exit.then(
    () => (entry.ended = true),
    () => (entry.ended = true)
  );
  started.set(id, entry);
  return id;
}

/** Waits for the process to end, ending it with SIGTERM once `timeoutMs` passes. */
export async function exit(id: number, timeoutMs: number): Promise<StackProcessResult> {
  const { process, output } = processOf(id);
  const timeout = setTimeout(() => process.kill('SIGTERM'), timeoutMs);
  try {
    return { exitCode: await process.exit, output: await output.done };
  } finally {
    clearTimeout(timeout);
  }
}

/** Every endpoint the container published or released, in order. */
export function endpointEvents(): StackEndpointEvent[] {
  return [...endpointLog];
}

/** The endpoints the container serves now. */
export function endpoints(): string[] {
  return runtime().endpoints.current.map((endpoint) => endpoint.url);
}

/** Waits for the process to publish an endpoint it did not have before it started. */
export async function endpoint(id: number, timeoutMs: number): Promise<Readonly<{ url: string; port: number }>> {
  const { process, output } = processOf(id);
  const published = () => runtime().endpoints.current.find((candidate) => !claimedEndpoints.has(candidate.url));
  return within(
    timeoutMs,
    () => `no endpoint was published in ${timeoutMs}ms:\n${output.text()}`,
    process,
    output,
    async () => {
      for (;;) {
        const candidate = published();
        if (candidate) {
          if (new URL(candidate.url).origin !== location.origin) {
            throw new Error(`the endpoint ${candidate.url} is not on the origin of the test page`);
          }
          claimedEndpoints.add(candidate.url);
          return { url: candidate.url, port: candidate.address.port };
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
  );
}

const claimedEndpoints = new Set<string>();

/**
 * Waits until the process has written `count` matches of `pattern`, a regular
 * expression source. ANSI colours are not part of the text matched.
 */
export async function waitForOutput(
  id: number,
  pattern: string,
  flags: string,
  count: number,
  timeoutMs: number
): Promise<string> {
  const { process, output } = processOf(id);
  const expression = new RegExp(pattern, flags.includes('g') ? flags : `${flags}g`);
  const matched = () => (output.text().replace(/\u001b\[[0-9;]*m/g, '').match(expression)?.length ?? 0) >= count;
  const missing = () => `${count} match(es) of ${expression}`;
  return within(
    timeoutMs,
    () => `output did not reach ${missing()} in ${timeoutMs}ms:\n${output.text()}`,
    undefined,
    output,
    async () => {
      for (;;) {
        if (matched()) return output.text();
        if (!(await Promise.race([process.exit.then(() => true), wait(20)]))) continue;
        await output.done;
        if (matched()) return output.text();
        throw new Error(`the process ended before its output reached ${missing()}:\n${output.text()}`);
      }
    }
  );
}

export function output(id: number): string {
  return processOf(id).output.text();
}

export async function write(id: number, text: string, end: boolean): Promise<void> {
  const writer = processOf(id).process.stdin.getWriter();
  try {
    if (text !== '') await writer.write(new TextEncoder().encode(text));
    if (end) await writer.close();
  } finally {
    writer.releaseLock();
  }
}

export async function stop(id: number, signal: 'SIGTERM' | 'SIGINT' | 'SIGKILL'): Promise<number> {
  const { process } = processOf(id);
  process.kill(signal);
  return process.exit;
}

/** A request from the test page; a network failure answers status 0 instead of throwing. */
export async function request(url: string, init: StackRequest = {}): Promise<StackResponse> {
  const { timeoutMs, ...rest } = init;
  try {
    const response = await runtime().endpoints.fetch(url, {
      ...rest,
      cache: 'no-store',
      ...(timeoutMs === undefined ? {} : { signal: AbortSignal.timeout(timeoutMs) })
    });
    return { status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() };
  } catch (error) {
    return { status: 0, headers: {}, body: String(error) };
  }
}

export async function readFile(path: string): Promise<string> {
  return runtime().fs.readFile(path, 'utf8');
}

/** Writes a file, creating the directories above it. */
export async function writeFile(path: string, contents: string): Promise<void> {
  await runtime().fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
  await runtime().fs.writeFile(path, contents);
}

export async function exists(path: string): Promise<boolean> {
  return runtime().fs.exists(path);
}

/** Every file under `path`, relative to it, in sorted order. */
export async function listFiles(path: string, prefix = ''): Promise<string[]> {
  const entries = await runtime().fs.readdir(path, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      if (typeof entry === 'string') return [`${prefix}${entry}`];
      return entry.isDirectory()
        ? listFiles(`${path}/${entry.name}`, `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`];
    })
  );
  return nested.flat().sort();
}

/** The size and SHA-256 of a file. */
export async function digest(path: string): Promise<Readonly<{ byteLength: number; sha256: string }>> {
  const bytes = await runtime().fs.readFile(path);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return { byteLength: bytes.byteLength, sha256: [...hash].map((byte) => byte.toString(16).padStart(2, '0')).join('') };
}

export async function rm(path: string): Promise<void> {
  await runtime().fs.rm(path, { recursive: true });
}

export async function rename(from: string, to: string): Promise<void> {
  await runtime().fs.rename(from, to);
}

export async function readdir(path: string): Promise<string[]> {
  return (await runtime().fs.readdir(path)).map((entry) => (typeof entry === 'string' ? entry : entry.name));
}

export async function teardown(): Promise<StackTeardown> {
  const ended = container;
  const workdir = ended?.workdir;
  const running = [...started.values()].filter((entry) => !entry.ended);
  const endpoints = [...claimedEndpoints];
  // An application left open would report the server it is about to lose.
  document.querySelector('iframe[data-stack-preview]')?.remove();
  const [installState, nativeRolldownBindings] = await timed('install record', async () => [
    ended ? await readIfPresent(ended, `${workdir}/node_modules/.package-lock.json`) : '',
    ended ? await nativeBindings(ended, `${workdir}/node_modules/@rolldown`) : []
  ] as const);
  const beat = heartbeat;
  const responsiveness = { elapsedMs: beat ? performance.now() - beat.startedAt : 0, ticks: beat?.ticks ?? 0 };
  clearInterval(beat?.timer);
  heartbeat = undefined;
  const endedByTeardown = await timed('teardown', async () => {
    await ended?.teardown();
    container = undefined;
    started.clear();
    claimedEndpoints.clear();
    endpointLog.length = 0;
    // A process the teardown did not end answers -1 instead of hanging the scenario.
    return Promise.all(
      running.map(({ process }) => Promise.race([process.exit.catch(() => -1), wait(10_000).then(() => -1)]))
    );
  });
  const invalidated = ended ? await refusesUse(ended) : { endpoints: false, filesystem: false, spawn: false };
  const cleanReboot = workdir === undefined ? false : await timed('clean reboot', () => bootsClean(`${workdir}-reboot`));
  const answers = await timed('released endpoints', () =>
    Promise.all(endpoints.map((url) => request(url, { timeoutMs: 2_000 })))
  );
  const text = transcript.splice(0).join('');
  return {
    phases: phases.splice(0),
    transcript: text,
    forbiddenFallbacks: [...findForbiddenFallbacks(`${text}\n${installState}`)],
    nativeRolldownBindings,
    responsiveness,
    invalidated,
    cleanReboot,
    endedByTeardown,
    endpointsStillServed: endpoints.filter((_url, index) => answers[index].status === 200)
  };
}

async function readIfPresent(runtime: Mimic, path: string): Promise<string> {
  return (await runtime.fs.exists(path)) ? runtime.fs.readFile(path, 'utf8') : '';
}

async function nativeBindings(runtime: Mimic, scope: string): Promise<string[]> {
  if (!(await runtime.fs.exists(scope))) return [];
  const entries = (await runtime.fs.readdir(scope)).map((entry) => (typeof entry === 'string' ? entry : entry.name));
  return [...findNativeRolldownBindings(entries)];
}

async function refusesUse(torn: Mimic): Promise<StackTeardown['invalidated']> {
  const refused = (error: unknown): boolean =>
    error instanceof Error && error.message.includes('Mimic runtime is tearing down');
  let endpoints = false;
  try {
    void torn.endpoints.current;
  } catch (error) {
    endpoints = refused(error);
  }
  return {
    endpoints,
    filesystem: await (async () => torn.fs.exists(torn.workdir))().then(() => false, refused),
    spawn: await torn.spawn('echo').then(() => false, refused)
  };
}

async function bootsClean(workdir: string): Promise<boolean> {
  const rebooted = await Mimic.boot({ workdir });
  try {
    return (await rebooted.fs.readdir(workdir)).length === 0;
  } finally {
    await rebooted.teardown();
  }
}

async function within<T>(
  timeoutMs: number,
  describe: () => string,
  process: MimicProcess | undefined,
  output: CollectedProcessOutput,
  work: () => Promise<T>
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work(),
      ...(process
        ? [
            process.exit.then((exitCode) => {
              throw new Error(`the process exited ${exitCode} first:\n${output.text()}`);
            })
          ]
        : []),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(describe())), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function wait(ms: number): Promise<false> {
  return new Promise((resolve) => setTimeout(() => resolve(false), ms));
}

function processOf(id: number): StartedProcess {
  const entry = started.get(id);
  if (!entry) throw new Error(`No stack scenario process ${id}`);
  return entry;
}

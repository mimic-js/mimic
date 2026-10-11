import type { Frame, FrameLocator, Locator, Page, Request } from '@playwright/test';

import type { PlaywrightTarballCacheEvidence } from '../playwright-tarball-cache';
import type { NpmExactGraphCompatibilityTarget } from './compatibility-claim';
import { expect, test as compatibilityTest } from './compatibility-test';
import { readApplication, type ApplicationFiles } from './fixture-application';
import type { InstallOutcome } from './install-layer';
import { installLayerUrl } from './install-layer-store';
import type {
  StackEndpointEvent,
  StackPhase,
  StackProcessResult,
  StackRequest,
  StackResponse,
  StackTeardown
} from './stack-scenario-page';

/**
 * A stack scenario runs a real application directory from
 * `compatibility/fixtures/<fixture>` (or `compatibility/probes/<fixture>` while
 * the stack has no claim) inside one Mimic and lets the test drive
 * it from Node with ordinary Playwright assertions.
 *
 *   test.use({ fixture: 'hono-4-notes-api' });
 *   test('serves the API', async ({ stack }) => {
 *     await stack.install();
 *     const server = await stack.start('npm start');
 *     expect((await server.fetch('/health')).status).toBe(200);
 *   });
 *
 * Every scenario also proves, without saying so: the install left the tracked
 * lockfile alone and asked only for tarballs, the test page stayed responsive
 * and reported no error and no failed request, no process printed a forbidden
 * fallback and no native Rolldown binding was installed, the teardown ended
 * every process still running, released its endpoints, left no runtime worker
 * and a container that refuses further use, and a container booted after the
 * teardown starts clean.
 */

/** A response or a failed request of the test page, stamped with the time its request started. */
export type BrowserNetworkEvent =
  | Readonly<{ kind: 'response'; url: string; status: number; occurredAtMs: number }>
  | Readonly<{
      kind: 'request-failed';
      url: string;
      error: string;
      occurredAtMs: number;
      /** For an aborted request: whether its document has since navigated or gone. */
      navigatedAway?: () => boolean;
    }>;

type CommandLine = string | readonly string[];
type Signal = 'SIGTERM' | 'SIGINT' | 'SIGKILL';
type FetchInit = StackRequest & Readonly<{ json?: unknown }>;

/** A process started in the scenario's container. */
export class StackProcess {
  constructor(
    protected readonly stack: Stack,
    protected readonly id: number
  ) {}

  output(): Promise<string> {
    return this.stack.call('output', this.id);
  }

  /**
   * Resolves with the output once it contains `expected`, `count` times when
   * given; ANSI colours are ignored.
   */
  waitForOutput(
    expected: string | RegExp,
    options: Readonly<{ count?: number; timeoutMs?: number }> = {}
  ): Promise<string> {
    const pattern = typeof expected === 'string' ? expected.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') : expected.source;
    const flags = typeof expected === 'string' ? '' : expected.flags;
    return this.stack.call('waitForOutput', this.id, pattern, flags, options.count ?? 1, options.timeoutMs ?? 30_000);
  }

  /** Resolves with the output once it has not changed for `quietMs`, as a watcher's does between builds. */
  async settle(quietMs = 500, timeoutMs = 10_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let last = await this.output();
    let changedAt = Date.now();
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const current = await this.output();
      if (current !== last) {
        last = current;
        changedAt = Date.now();
      } else if (Date.now() - changedAt >= quietMs) {
        return current;
      }
    }
    throw new Error(`The output did not settle in ${timeoutMs}ms:\n${last}`);
  }

  /** Writes to standard input, closing it with `end`. */
  write(text: string, options: Readonly<{ end?: boolean }> = {}): Promise<void> {
    return this.stack.call('write', this.id, text, options.end === true);
  }

  /** Waits for the process to end by itself. */
  exit(timeoutMs = 60_000): Promise<StackProcessResult> {
    return this.stack.call('exit', this.id, timeoutMs);
  }

  /** Signals the process and answers its exit code. */
  stop(signal: Signal = 'SIGTERM'): Promise<number> {
    return this.stack.call('stop', this.id, signal);
  }
}

/** A process that published an endpoint. */
export class StackServer extends StackProcess {
  constructor(
    stack: Stack,
    id: number,
    readonly url: string,
    readonly port: number
  ) {
    super(stack, id);
  }

  /** Requests `path` from the test page; a network failure answers status 0. */
  fetch(path: string, init: FetchInit = {}): Promise<StackResponse> {
    const { json, ...rest } = init;
    const request = json === undefined
      ? rest
      : { ...rest, headers: { 'content-type': 'application/json', ...rest.headers }, body: JSON.stringify(json) };
    return this.stack.call('request', this.href(path), request);
  }

  /** Opens the served application in a frame of the test page. */
  async open(path = '/'): Promise<FrameLocator> {
    await this.stack.page.evaluate((src) => {
      document.querySelector('iframe[data-stack-preview]')?.remove();
      const frame = document.createElement('iframe');
      frame.dataset.stackPreview = '';
      frame.src = src;
      frame.style.cssText = 'width:100%;height:600px;border:0';
      document.body.append(frame);
    }, this.href(path));
    return this.stack.page.frameLocator('iframe[data-stack-preview]');
  }

  /**
   * Closes the preview, so the application's client does not report the lost
   * server, signals the server, and proves its endpoint was released.
   * `keepPreview` leaves the application open to watch it lose the server.
   */
  override async stop(signal: Signal = 'SIGTERM', options: Readonly<{ keepPreview?: boolean }> = {}): Promise<number> {
    if (options.keepPreview !== true) {
      await this.stack.page.evaluate(() => document.querySelector('iframe[data-stack-preview]')?.remove());
    }
    const exitCode = await super.stop(signal);
    await expect.poll(() => this.stack.endpoints(), 'the stopped server kept its endpoint').not.toContain(this.url);
    expect(await this.stack.endpointEvents()).toContainEqual({ kind: 'unpublished', url: this.url });
    return exitCode;
  }

  href(path: string): string {
    return new URL(path.replace(/^\//, ''), this.url).href;
  }
}

export class Stack {
  /** The working directory of the container the scenario runs in now. */
  workdir: string;
  /** Whether an install ran its package manager instead of mounting a layer. */
  ranPackageManager = false;
  /** The phases of every container the scenario has ended. */
  readonly phases: StackPhase[] = [];
  private readonly files: ApplicationFiles;
  private readonly pageErrors: string[] = [];
  private consoleErrors: string[] = [];
  private network: BrowserNetworkEvent[] = [];
  private readonly expectedConsoleErrors: RegExp[] = [];
  private readonly writtenAtMs = new Map<string, number>();

  constructor(
    readonly page: Page,
    readonly fixture: string,
    app?: string
  ) {
    this.workdir = `/home/${fixture.replace(/[^a-z0-9-]/giu, '-')}`;
    this.files = readApplication(fixture, app);
    page.on('pageerror', (error) => this.pageErrors.push(error.stack ?? error.message));
    page.on('console', (message) => {
      // A response the scenario asked for and asserted is not an error of the page.
      if (message.type() === 'error' && !message.text().startsWith('Failed to load resource:')) {
        this.consoleErrors.push(message.text());
      }
    });
    const startedAtMs = new WeakMap<Request, number>();
    const occurredAtMs = (request: Request): number => startedAtMs.get(request) ?? request.timing().startTime;
    // A document that navigates, as a development server's reload does,
    // aborts the requests it still had open; those are not failures.
    const navigations = new WeakMap<Frame, number>();
    const navigationAtRequest = new WeakMap<Request, readonly [Frame, number]>();
    const frameOf = (request: Request): Frame | undefined => {
      try {
        return request.frame();
      } catch {
        return undefined;
      }
    };
    page.on('framenavigated', (frame) => navigations.set(frame, (navigations.get(frame) ?? 0) + 1));
    page.on('request', (request) => {
      startedAtMs.set(request, Date.now());
      const frame = frameOf(request);
      if (frame) navigationAtRequest.set(request, [frame, navigations.get(frame) ?? 0]);
    });
    page.on('requestfailed', (request) => {
      const error = request.failure()?.errorText ?? 'failed';
      const origin = navigationAtRequest.get(request);
      this.network.push({
        kind: 'request-failed',
        url: request.url(),
        error,
        occurredAtMs: occurredAtMs(request),
        ...(error === 'net::ERR_ABORTED' && origin
          ? { navigatedAway: () => (navigations.get(origin[0]) ?? 0) > origin[1] || origin[0].isDetached() }
          : {})
      });
    });
    page.on('response', (response) =>
      this.network.push({
        kind: 'response',
        url: response.url(),
        status: response.status(),
        occurredAtMs: occurredAtMs(response.request())
      })
    );
  }

  async boot(): Promise<void> {
    await this.page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
    await expect.poll(() => this.page.evaluate(() => window.crossOriginIsolated)).toBe(true);
    await this.call('boot', this.workdir, this.files);
  }

  /**
   * Installs the fixture's tracked lockfile and proves the install left it
   * alone. With install layers on, a stored layer is mounted instead; a claim
   * about the install itself passes `layer: false`.
   */
  async install(commandLine = 'npm ci', options: Readonly<{ layer?: false }> = {}): Promise<StackProcessResult> {
    const lockfile = this.files['package-lock.json'];
    if (lockfile === undefined) throw new Error(`${this.fixture} has no package-lock.json`);
    const [command, ...args] = words(commandLine);
    const layer =
      options.layer === false ? null : installLayerUrl(this.files['package.json'] ?? '', lockfile, { command, args });
    const result = await this.call<InstallOutcome>('install', { command, args, layer }, 480_000);
    expect(result.exitCode, result.output).toBe(0);
    if (!result.restored) this.ranPackageManager = true;
    await this.expectLockfileUnchanged();
    return result;
  }

  /** Proves the tracked lockfile is still what the fixture ships. */
  async expectLockfileUnchanged(): Promise<void> {
    expect(await this.readFile('package-lock.json'), 'the tracked lockfile changed').toBe(
      this.files['package-lock.json']
    );
  }

  /** Runs a command to its end. */
  async run(
    commandLine: CommandLine,
    options: Readonly<{ timeoutMs?: number; env?: Record<string, string> }> = {}
  ): Promise<StackProcessResult> {
    return (await this.spawn(commandLine, options)).exit(options.timeoutMs ?? 120_000);
  }

  /** Starts a command and returns at once. */
  async spawn(commandLine: CommandLine, options: Readonly<{ env?: Record<string, string> }> = {}): Promise<StackProcess> {
    const [command, ...args] = words(commandLine);
    return new StackProcess(this, await this.call<number>('spawn', command, args, options.env));
  }

  /** Starts a command and waits for the endpoint it publishes. */
  async start(
    commandLine: CommandLine,
    options: Readonly<{ timeoutMs?: number; env?: Record<string, string> }> = {}
  ): Promise<StackServer> {
    const [command, ...args] = words(commandLine);
    const id = await this.call<number>('spawn', command, args, options.env);
    const endpoint = await this.call<{ url: string; port: number }>('endpoint', id, options.timeoutMs ?? 120_000);
    return new StackServer(this, id, endpoint.url, endpoint.port);
  }

  readFile(path: string): Promise<string> {
    return this.call('readFile', this.resolve(path));
  }

  /**
   * Writes a file, leaving at least 100 ms since the scenario last wrote it:
   * chokidar reports one change for two writes of a file less than 50 ms
   * apart, and no editor saves that fast.
   */
  async writeFile(path: string, contents: string): Promise<void> {
    const file = this.resolve(path);
    const wait = (this.writtenAtMs.get(file) ?? 0) + 100 - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    await this.call('writeFile', file, contents);
    this.writtenAtMs.set(file, Date.now());
  }

  exists(path: string): Promise<boolean> {
    return this.call('exists', this.resolve(path));
  }

  readdir(path = '.'): Promise<string[]> {
    return this.call('readdir', this.resolve(path));
  }

  /** The fixture's tracked lockfile, parsed. */
  get lockfile(): Readonly<{ packages: Readonly<Record<string, Readonly<Record<string, unknown>>>> }> {
    return JSON.parse(this.files['package-lock.json'] ?? '{"packages":{}}');
  }

  /** `name@version` of the package installed at `path`, or undefined when nothing is. */
  async installedPackage(path: string): Promise<string | undefined> {
    if (!(await this.exists(`${path}/package.json`))) return undefined;
    const manifest = JSON.parse(await this.readFile(`${path}/package.json`));
    return `${manifest.name}@${manifest.version}`;
  }

  /** Proves each directory of `node_modules` holds the named `name@version`. */
  async expectInstalled(installed: Readonly<Record<string, string>>): Promise<void> {
    for (const [directory, identity] of Object.entries(installed)) {
      expect(await this.installedPackage(`node_modules/${directory}`), `node_modules/${directory}`).toBe(identity);
    }
  }

  /** The size and SHA-256 of a file. */
  digest(path: string): Promise<Readonly<{ byteLength: number; sha256: string }>> {
    return this.call('digest', this.resolve(path));
  }

  /** Every file under `path`, relative to it. */
  listFiles(path: string): Promise<string[]> {
    return this.call('listFiles', this.resolve(path));
  }

  rm(path: string): Promise<void> {
    return this.call('rm', this.resolve(path));
  }

  rename(from: string, to: string): Promise<void> {
    return this.call('rename', this.resolve(from), this.resolve(to));
  }

  /**
   * Resolves with the next message of `type` an application posts to the test
   * page. Call it before opening the application.
   */
  waitForMessage<Message>(type: string, timeoutMs = 30_000): Promise<Message> {
    return this.page.evaluate(
      ({ type, timeoutMs }) =>
        new Promise<unknown>((resolve, reject) => {
          const onMessage = (event: MessageEvent): void => {
            if (event.origin !== location.origin || event.data?.type !== type) return;
            clearTimeout(timeout);
            removeEventListener('message', onMessage);
            resolve(event.data);
          };
          const timeout = setTimeout(() => {
            removeEventListener('message', onMessage);
            reject(new Error(`no ${type} message in ${timeoutMs}ms`));
          }, timeoutMs);
          addEventListener('message', onMessage);
        }),
      { type, timeoutMs }
    ) as Promise<Message>;
  }

  /** Names a console error the scenario provokes on purpose. */
  expectConsoleError(pattern: RegExp): void {
    this.expectedConsoleErrors.push(pattern);
  }

  /**
   * The console errors and network events of the test page since the last
   * call. The scenario answers for what it takes; `finish()` asserts the rest.
   */
  takeDiagnostics(): Readonly<{ consoleErrors: string[]; network: BrowserNetworkEvent[] }> {
    const taken = { consoleErrors: this.consoleErrors, network: this.network };
    this.consoleErrors = [];
    this.network = [];
    return taken;
  }

  /** Every endpoint the container published or released, in order. */
  endpointEvents(): Promise<StackEndpointEvent[]> {
    return this.call('endpointEvents');
  }

  /** The endpoints the container serves now. */
  endpoints(): Promise<string[]> {
    return this.call('endpoints');
  }

  /** The workers the runtime keeps for the test page: one for each process still running. */
  async runtimeWorkers(): Promise<string[]> {
    const session = await this.page.context().newCDPSession(this.page);
    try {
      const { targetInfo } = await session.send('Target.getTargetInfo');
      const { targetInfos } = await session.send('Target.getTargets');
      return targetInfos
        .filter(
          (target) =>
            target.type === 'worker' && target.openerId === targetInfo.targetId && target.url.includes('/src/runtime/')
        )
        .map((target) => target.url);
    } finally {
      await session.detach();
    }
  }

  /** Ends the container as `finish()` does, and boots a fresh one holding the same application. */
  async reboot(): Promise<void> {
    await this.finish();
    this.workdir = `${this.workdir}-reboot`;
    await this.call('boot', this.workdir, this.files);
  }

  /** Ends the container and asserts what every scenario proves. */
  async finish(): Promise<StackTeardown> {
    const teardown = await this.end();
    expect(teardown.forbiddenFallbacks, 'a process or the install named a forbidden fallback').toEqual([]);
    expect(teardown.nativeRolldownBindings, 'a native Rolldown binding was installed').toEqual([]);
    expect(teardown.cleanReboot, 'a container booted after the teardown did not start clean').toBe(true);
    for (const exitCode of teardown.endedByTeardown) {
      expect([137, 143], 'the teardown did not end a running process with a signal').toContain(exitCode);
    }
    expect(teardown.endpointsStillServed, 'an endpoint still answers after the teardown').toEqual([]);
    expect(teardown.invalidated, 'the torn-down container still accepts use').toEqual({
      endpoints: true,
      filesystem: true,
      spawn: true
    });
    await expect.poll(() => this.runtimeWorkers(), 'the teardown left runtime workers').toEqual([]);
    expect(
      teardown.responsiveness.ticks,
      'the test page was unresponsive while the container lived'
    ).toBeGreaterThanOrEqual(teardown.responsiveness.elapsedMs / 200);
    expect(this.pageErrors, 'the test page reported errors').toEqual([]);
    const { consoleErrors, network } = this.takeDiagnostics();
    expect(
      consoleErrors.filter((text) => !this.expectedConsoleErrors.some((pattern) => pattern.test(text))),
      'the test page logged errors'
    ).toEqual([]);
    expect(
      network.filter((event) => event.kind === 'request-failed' && !event.navigatedAway?.()),
      'requests of the test page failed'
    ).toEqual([]);
    return teardown;
  }

  /** Ends the container without asserting anything. */
  async end(): Promise<StackTeardown> {
    const teardown = await this.call<StackTeardown>('teardown');
    this.phases.push(...teardown.phases);
    return teardown;
  }

  call<Result>(name: string, ...args: readonly unknown[]): Promise<Result> {
    return this.page.evaluate(async ({ name, args }: { name: string; args: readonly unknown[] }) => {
      const driver: Record<string, (...values: readonly unknown[]) => unknown> = await import(
        '/tests/e2e/stack-scenario-page.ts'
      );
      return driver[name](...args);
    }, { name, args }) as Promise<Result>;
  }

  private resolve(path: string): string {
    return path.startsWith('/') ? path : path === '.' ? this.workdir : `${this.workdir}/${path}`;
  }
}

export const test = compatibilityTest.extend<{ fixture: string; app: string | undefined; stack: Stack }>({
  fixture: ['', { option: true }],
  // The application under the fixture's `apps/`, when the fixture holds several.
  app: [undefined, { option: true }],
  stack: async ({ page, fixture, app, tarballCacheEvidence }, use, testInfo) => {
    if (fixture === '') throw new Error("Select the application with test.use({ fixture: '<directory>' })");
    const tarballsBefore = tarballCacheEvidence();
    const stack = new Stack(page, fixture, app);
    await stack.boot();
    let failed = true;
    try {
      await use(stack);
      failed = testInfo.status !== testInfo.expectedStatus;
    } finally {
      // A scenario that already failed reports its own failure, not the teardown's, and keeps what its processes wrote.
      if (failed) {
        const teardown = await stack.end().catch(() => undefined);
        if (teardown) await testInfo.attach('stack-transcript', { body: teardown.transcript, contentType: 'text/plain' });
      } else {
        await stack.finish();
        expectOnlyTarballs(tarballsBefore, tarballCacheEvidence(), stack.ranPackageManager);
      }
      await testInfo.attach('stack-phases', {
        body: JSON.stringify(stack.phases, null, 2),
        contentType: 'application/json'
      });
      if (process.env.STACK_PHASES) {
        console.log(`[stack ${fixture}] ${stack.phases.map(({ phase, ms }) => `${phase}: ${ms}ms`).join(' | ')}`);
      }
    }
  }
});

export { expect };

/**
 * `expect.poll` every 50 ms, for what an application shows after a build or a
 * hot update. Playwright's own assertions wait up to a second between two
 * looks, which adds most of that second to every update a scenario waits for.
 */
export function eventually<Value>(read: () => Value | Promise<Value>, message?: string) {
  return expect.poll(read, { intervals: [50], timeout: 120_000, message });
}

/** The trimmed text of an element, or undefined while the frame has none. */
export function textOf(locator: Locator): Promise<string | undefined> {
  return locator.textContent({ timeout: 1_000 }).then(
    (text) => text?.trim(),
    () => undefined
  );
}

/** The computed value of a CSS property of an element, or undefined while the frame has none. */
export function styleOf(locator: Locator, property: string): Promise<string | undefined> {
  return locator
    .evaluate((element, name) => getComputedStyle(element).getPropertyValue(name), property, { timeout: 1_000 })
    .catch(() => undefined);
}

/** Identifies the document a frame shows: it changes when the frame loads a document again. */
export function documentId(app: FrameLocator): Promise<number> {
  return app.locator('html').evaluate(() => performance.timeOrigin);
}

/** The addresses of the resources the document of a frame has loaded. */
export function resourceUrls(app: FrameLocator): Promise<string[]> {
  return app.locator('html').evaluate(() => performance.getEntriesByType('resource').map((entry) => entry.name));
}

/** The Exact Graph target of a fixture directory installed by the pinned npm. */
export function npmExactGraph(
  fixture: string,
  packages: Readonly<Record<string, string>>,
  commandLine: string
): NpmExactGraphCompatibilityTarget {
  const [command, entrypoint = ''] = words(commandLine);
  return {
    kind: 'exact-graph',
    packages,
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: { format: 'npm', version: 3, path: `compatibility/fixtures/${fixture}/package-lock.json` },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {},
    execution: { command, entrypoint }
  };
}

/** Proves a scenario asked the registry for tarballs only, and for some when its package manager ran. */
function expectOnlyTarballs(
  before: PlaywrightTarballCacheEvidence,
  after: PlaywrightTarballCacheEvidence,
  ranPackageManager: boolean
): void {
  const requests = after.requests - before.requests;
  const urls = after.urls.slice(before.urls.length);
  if (ranPackageManager) expect(requests, 'the install asked for no tarball').toBeGreaterThan(0);
  expect(after.hits - before.hits + (after.misses - before.misses)).toBe(requests);
  expect(urls).toHaveLength(requests);
  expect(urls.filter((url) => !/\.tgz(?:[?#].*)?$/u.test(url)), 'the scenario asked the registry for more than tarballs').toEqual([]);
}

function words(commandLine: CommandLine): string[] {
  const parts = typeof commandLine === 'string' ? commandLine.trim().split(/\s+/u) : [...commandLine];
  if (parts.length === 0 || parts[0] === '') throw new Error('A stack scenario command line cannot be empty');
  return parts;
}

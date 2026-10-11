import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';
import type { APIResponse } from '@playwright/test';

import {
  installPlaywrightTarballCache,
  type TarballCacheBrowserContext,
  type TarballCacheRoute,
  type TarballCacheRouteHandler
} from '../playwright-tarball-cache';

const tarballUrl = 'https://registry.npmjs.org/picocolors/-/picocolors-1.1.1.tgz';
const publisherTarballUrl = 'https://cdn.example.test/packages/picocolors-1.1.1.tgz';
const tarball = Buffer.from([1, 2, 3, 4]);
const upstreamHeaders = { 'content-type': 'application/octet-stream', 'x-publisher': 'npm' };
const roots: string[] = [];
const loadWorkerProcesses = new Set<ChildProcess>();

afterEach(async () => {
  await terminateLoadWorkerProcesses();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Playwright tarball cache', () => {
  test('fetches a missing tarball once, then serves the same bytes from disk', async () => {
    const response = new FakeResponse(tarballUrl, 200, tarball);
    const context = new FakeContext(new Map([[tarballUrl, response]]));
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    const miss = await context.dispatch(tarballUrl);
    const hit = await context.dispatch(tarballUrl);

    expect(context.networkRequests).toEqual([tarballUrl]);
    expect(miss.fulfilled).toEqual({ status: 200, body: tarball });
    expect(miss.upstreamResponseDisposedAtFulfill).toBe(false);
    expect(hit.fulfilled).toEqual({ status: 200, body: tarball });
    expect(response.disposed).toBe(true);
    expect(session.evidence()).toEqual({
      requests: 2,
      hits: 1,
      misses: 1,
      urls: [tarballUrl, tarballUrl]
    });
    await session.close();
  });

  test('reuses only content-addressed tarballs whose cached bytes match their integrity', async () => {
    const root = await temporaryRoot();
    const response = new FakeResponse(tarballUrl, 200, tarball);
    const context = new FakeContext(new Map([[tarballUrl, response]]));
    const session = await installPlaywrightTarballCache(context, { directory: root });

    await context.dispatch(tarballUrl);
    const pointerName = (await readdir(root)).find((entry) => entry.endsWith('.integrity'));
    expect(pointerName).toBeDefined();
    const integrity = await readFile(join(root, pointerName ?? ''), 'utf8');
    expect(integrity).toMatch(/^sha512-[A-Za-z0-9+/]+={0,2}$/u);
    const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
    const objectPath = join(root, 'objects', `sha512-${digest}.tgz`);
    await writeFile(objectPath, Buffer.from('corrupt'));

    const repaired = await context.dispatch(tarballUrl);

    expect(context.networkRequests).toEqual([tarballUrl, tarballUrl]);
    expect(repaired.fulfilled).toEqual({ status: 200, body: tarball });
    expect(await readFile(objectPath)).toEqual(tarball);
    await session.close();
  });

  test('leaves registry metadata and unrelated requests on their normal path', async () => {
    const context = new FakeContext(new Map());
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    const metadata = await context.dispatch('https://registry.npmjs.org/vite');
    const local = await context.dispatch('http://127.0.0.1:4179/mimic-test-host.html');

    expect(metadata.fellThrough).toBe(true);
    expect(local.fellThrough).toBe(true);
    expect(context.networkRequests).toEqual([]);
    await session.close();
  });

  test('falls back for a non-GET request that matches the tarball URL pattern', async () => {
    const context = new FakeContext(new Map());
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    const route = await context.dispatch(tarballUrl, 'POST');

    expect(route.fellThrough).toBe(true);
    expect(context.networkRequests).toEqual([]);
    await session.close();
  });

  test('does not cache an unsuccessful upstream response', async () => {
    const unavailable = Buffer.from('registry unavailable');
    const response = new FakeResponse(tarballUrl, 503, unavailable, upstreamHeaders);
    const context = new FakeContext(new Map([[tarballUrl, response]]));
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    const first = await context.dispatch(tarballUrl);
    const second = await context.dispatch(tarballUrl);

    expect(context.networkRequests).toEqual([tarballUrl, tarballUrl]);
    expect(first.fulfilled).toEqual({ status: 503, body: unavailable, headers: upstreamHeaders });
    expect(second.fulfilled).toEqual({ status: 503, body: unavailable, headers: upstreamHeaders });
    expect(response.disposed).toBe(true);
    await session.close();
  });

  test('caches HTTPS publisher tarballs outside registry.npmjs.org', async () => {
    const context = new FakeContext(
      new Map([[publisherTarballUrl, new FakeResponse(publisherTarballUrl, 200, tarball)]])
    );
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    await context.dispatch(publisherTarballUrl);
    const hit = await context.dispatch(publisherTarballUrl);

    expect(context.networkRequests).toEqual([publisherTarballUrl]);
    expect([...(hit.fulfilled?.body ?? [])]).toEqual([...tarball]);
    await session.close();
  });

  test('shares one upstream response across concurrent misses', async () => {
    let releaseBody: (() => void) | undefined;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const response = new FakeResponse(tarballUrl, 200, tarball, {}, bodyGate);
    const context = new FakeContext(new Map([[tarballUrl, response]]));
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    const first = context.dispatch(tarballUrl);
    const second = context.dispatch(tarballUrl);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseBody?.();

    const routes = await Promise.all([first, second]);
    expect(routes.map((route) => route.fulfilled)).toEqual([
      { status: 200, body: tarball },
      { status: 200, body: tarball }
    ]);
    expect(routes.map((route) => route.upstreamResponseDisposedAtFulfill)).toEqual([false, false]);
    expect(context.networkRequests).toEqual([tarballUrl]);
    expect(response.disposed).toBe(true);
    await session.close();
  });

  test('shares one upstream response across cache sessions', async () => {
    let releaseBody: (() => void) | undefined;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBody = resolve;
    });
    const root = await temporaryRoot();
    const firstContext = new FakeContext(
      new Map([[tarballUrl, new FakeResponse(tarballUrl, 200, tarball, {}, bodyGate)]])
    );
    const secondContext = new FakeContext(
      new Map([[tarballUrl, new FakeResponse(tarballUrl, 200, tarball, {}, bodyGate)]])
    );
    const firstSession = await installPlaywrightTarballCache(firstContext, { directory: root });
    const secondSession = await installPlaywrightTarballCache(secondContext, { directory: root });

    const first = firstContext.dispatch(tarballUrl);
    const second = secondContext.dispatch(tarballUrl);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releaseBody?.();

    expect((await Promise.all([first, second])).map((route) => route.fulfilled)).toEqual([
      { status: 200, body: tarball },
      { status: 200, body: tarball }
    ]);
    expect(firstContext.networkRequests.length + secondContext.networkRequests.length).toBe(1);
    await Promise.all([firstSession.close(), secondSession.close()]);
  });

  test('bounds concurrent upstream loads across distinct tarballs', async () => {
    let releaseBodies: (() => void) | undefined;
    const bodyGate = new Promise<void>((resolve) => {
      releaseBodies = resolve;
    });
    const urls = Array.from(
      { length: 5 },
      (_, index) => `https://registry.npmjs.org/package-${index}/-/package-${index}-1.0.0.tgz`
    );
    const context = new FakeContext(
      new Map(urls.map((url) => [url, new FakeResponse(url, 200, tarball, {}, bodyGate)]))
    );
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });
    const dispatches = urls.map((url) => context.dispatch(url));

    await expect.poll(() => context.networkRequests.length).toBeGreaterThanOrEqual(4);
    try {
      expect(context.networkRequests).toHaveLength(4);
    } finally {
      releaseBodies?.();
      await Promise.all(dispatches);
      await session.close();
    }
  });

  test('recovers an abandoned load ticket without admitting two processes', async () => {
    const path = join(await temporaryRoot(), 'publisher.tgz');
    const abandoned = startLoadWorker(path, 'abandon');
    await abandoned.acquired;
    await abandoned.exited;

    const first = startLoadWorker(path);
    const second = startLoadWorker(path);
    await Promise.all([first.contending, second.contending]);
    const winner = await Promise.race([
      first.acquired.then(() => first),
      second.acquired.then(() => second)
    ]);
    const waiter = winner === first ? second : first;

    winner.release();
    await winner.exited;
    await waiter.acquired;
    waiter.release();
    await waiter.exited;
  });

  test('shares a bounded load capacity across processes', async () => {
    const path = join(await temporaryRoot(), 'publisher-pool');
    const occupants = Array.from({ length: 8 }, () => startLoadWorker(path, 'hold', 8));
    await Promise.all(occupants.map((worker) => worker.acquired));
    const waiter = startLoadWorker(path, 'hold', 8);
    await waiter.contending;

    await expect(loadWorkerHasAcquired(waiter, 100)).resolves.toBe(false);
    occupants[0].release();
    await occupants[0].exited;
    await waiter.acquired;

    waiter.release();
    for (const occupant of occupants.slice(1)) occupant.release();
    await Promise.all([waiter.exited, ...occupants.slice(1).map((occupant) => occupant.exited)]);
  });

  test('rejects a stale generation when its numeric pid has been reused', async () => {
    const path = join(await temporaryRoot(), 'publisher.tgz');
    const directory = `${path}.loads`;
    const staleParticipant = `${process.pid}-stale-generation`;
    const heartbeatPath = join(directory, `${staleParticipant}.heartbeat`);
    await mkdir(directory, { recursive: true });
    await writeFile(heartbeatPath, '');
    await writeFile(join(directory, `${staleParticipant}.ticket`), '1');
    await utimes(heartbeatPath, new Date(0), new Date(0));

    const worker = startLoadWorker(path);
    await worker.acquired;
    worker.release();
    await worker.exited;
  });

  test('reports a rejected upstream request and permits a later attempt', async () => {
    const network = new Map<string, FakeResponse | Error>([[tarballUrl, new Error('publisher unavailable')]]);
    const context = new FakeContext(network);
    const session = await installPlaywrightTarballCache(context, { directory: await temporaryRoot() });

    await expect(context.dispatch(tarballUrl)).rejects.toThrow('publisher unavailable');
    network.set(tarballUrl, new FakeResponse(tarballUrl, 200, tarball));
    await expect(context.dispatch(tarballUrl)).resolves.toMatchObject({
      fulfilled: { status: 200, body: tarball }
    });

    expect(context.networkRequests).toEqual([tarballUrl, tarballUrl]);
    await session.close();
  });
});

class FakeResponse implements APIResponse {
  disposed = false;

  constructor(
    private readonly responseUrl: string,
    private readonly responseStatus: number,
    private readonly bytes: Buffer,
    private readonly responseHeaders: Record<string, string> = {},
    private readonly bodyGate?: Promise<void>
  ) {}

  status(): number {
    return this.responseStatus;
  }

  async body(): Promise<Buffer> {
    await this.bodyGate;
    return this.bytes;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }

  headers(): Record<string, string> {
    return this.responseHeaders;
  }

  headersArray(): Array<{ name: string; value: string }> {
    return Object.entries(this.responseHeaders).map(([name, value]) => ({ name, value }));
  }

  async json(): Promise<unknown> {
    return JSON.parse(this.bytes.toString()) as unknown;
  }

  ok(): boolean {
    return this.responseStatus >= 200 && this.responseStatus < 300;
  }

  async securityDetails(): Promise<null> {
    return null;
  }

  async serverAddr(): Promise<null> {
    return null;
  }

  statusText(): string {
    return String(this.responseStatus);
  }

  async text(): Promise<string> {
    return this.bytes.toString();
  }

  url(): string {
    return this.responseUrl;
  }

  async [Symbol.asyncDispose](): Promise<void> {}
}

class FakeContext implements TarballCacheBrowserContext {
  private handler: TarballCacheRouteHandler | undefined;
  private matcher: RegExp | undefined;
  readonly networkRequests: string[] = [];

  constructor(private readonly network: ReadonlyMap<string, FakeResponse | Error>) {}

  async route(url: RegExp, handler: TarballCacheRouteHandler): Promise<void> {
    this.matcher = url;
    this.handler = handler;
  }

  async unroute(_url: RegExp, _handler?: TarballCacheRouteHandler): Promise<void> {
    this.matcher = undefined;
    this.handler = undefined;
  }

  async dispatch(url: string, method = 'GET'): Promise<FakeRoute> {
    if (!this.handler || !this.matcher) throw new Error('No route installed');
    const route = new FakeRoute(url, method, this.network, this.networkRequests);
    if (this.matcher.test(url)) await this.handler(route);
    else await route.fallback();
    return route;
  }
}

class FakeRoute implements TarballCacheRoute {
  fulfilled:
    | { body: Buffer; headers?: Record<string, string>; response?: APIResponse; status?: number }
    | undefined;
  fellThrough = false;
  upstreamResponseDisposedAtFulfill: boolean | undefined;

  constructor(
    private readonly url: string,
    private readonly method: string,
    private readonly network: ReadonlyMap<string, FakeResponse | Error>,
    private readonly networkRequests: string[]
  ) {}

  request() {
    return { url: () => this.url, method: () => this.method };
  }

  async fetch(): Promise<FakeResponse> {
    this.networkRequests.push(this.url);
    const response = this.network.get(this.url);
    if (!response) throw new Error(`No fake network response for ${this.url}`);
    if (response instanceof Error) throw response;
    return response;
  }

  async fulfill(options: {
    body: Buffer;
    headers?: Record<string, string>;
    response?: APIResponse;
    status?: number;
  }): Promise<void> {
    const upstreamResponse = this.network.get(this.url);
    this.upstreamResponseDisposedAtFulfill =
      upstreamResponse instanceof FakeResponse ? upstreamResponse.disposed : undefined;
    this.fulfilled = options;
  }

  async fallback(): Promise<void> {
    this.fellThrough = true;
  }
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'playwright-tarball-cache-'));
  roots.push(root);
  return root;
}

type LoadWorker = Readonly<{
  contending: Promise<void>;
  acquired: Promise<void>;
  exited: Promise<void>;
  release(): void;
}>;

function startLoadWorker(path: string, mode: 'abandon' | 'hold' = 'hold', capacity = 1): LoadWorker {
  const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/playwright-tarball-cache-load-worker.ts');
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath], {
    env: {
      ...process.env,
      PLAYWRIGHT_TARBALL_CACHE_LOAD_CAPACITY: String(capacity),
      PLAYWRIGHT_TARBALL_CACHE_LOAD_MODE: mode,
      PLAYWRIGHT_TARBALL_CACHE_LOAD_PATH: path
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  loadWorkerProcesses.add(child);
  child.once('exit', () => loadWorkerProcesses.delete(child));
  const contending = waitForWorkerMessage(child, 'contending');
  const acquired = waitForWorkerMessage(child, 'acquired');
  const exited = waitForWorkerExit(child);
  void contending.catch(() => undefined);
  void acquired.catch(() => undefined);
  void exited.catch(() => undefined);
  return {
    contending,
    acquired,
    exited,
    release: () => child.send('release')
  };
}

async function loadWorkerHasAcquired(worker: LoadWorker, timeoutMs: number): Promise<boolean> {
  return Promise.race([
    worker.acquired.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs))
  ]);
}

async function terminateLoadWorkerProcesses(): Promise<void> {
  const processes = [...loadWorkerProcesses];
  await Promise.all(
    processes.map(
      (child) =>
        new Promise<void>((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          child.once('exit', () => resolve());
          child.kill();
        })
    )
  );
  loadWorkerProcesses.clear();
}

function waitForWorkerMessage(child: ChildProcess, type: 'acquired' | 'contending'): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onMessage = (message: unknown) => {
      if (!isWorkerMessage(message, type)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Tarball cache load worker exited before ${type} with code ${String(code)} and signal ${String(signal)}`
        )
      );
    };
    const cleanup = () => {
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    };
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForWorkerExit(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`Tarball cache load worker exited with code ${String(code)} and signal ${String(signal)}`));
    });
    child.once('error', reject);
  });
}

function isWorkerMessage(
  message: unknown,
  type: 'acquired' | 'contending'
): message is Readonly<{ type: 'acquired' | 'contending' }> {
  return message !== null && typeof message === 'object' && 'type' in message && message.type === type;
}

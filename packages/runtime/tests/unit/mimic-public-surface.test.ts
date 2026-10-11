import { describe, expect, test, vi } from 'vitest';

const listeners = vi.hoisted(() => new Map<string, (endpoint: unknown) => void>());
const internalEndpoint = vi.hoisted(() => ({
  routeId: 'epoch-a:route-1',
  protocol: 'http',
  address: { host: '127.0.0.1', port: 3000 },
  url: 'http://127.0.0.1:5173/__mimic__/epoch-a/route-1/3000/'
}));

vi.mock('../../src/runtime/modules/runtime-host', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/runtime/modules/runtime-host')>();
  const stream = () => new ReadableStream<Uint8Array>();
  return {
    ...original,
    bootRuntimeHost: async () => ({
      fs: { revision: 7 },
      endpoints: {
        current: [internalEndpoint],
        on(type: string, listener: (endpoint: unknown) => void) {
          listeners.set(type, listener);
          return () => listeners.delete(type);
        },
        fetch: async () => new Response('ok')
      },
      spawn: async () => {
        const stdin = new WritableStream<Uint8Array>();
        return {
          pid: 4,
          stdin,
          stdout: stream(),
          stderr: stream(),
          input: stdin,
          output: stream(),
          exit: Promise.resolve(0),
          termination: Promise.resolve(undefined),
          kill: vi.fn(),
          crash: vi.fn()
        };
      },
      teardown: async () => undefined
    })
  };
});

const { Mimic, MimicProcessCrashError } = await import('../../src/runtime/index');

describe('the public Mimic surface', () => {
  test('a spawned process exposes its streams, exit and kill only', async () => {
    const container = await Mimic.boot();
    const process = await container.spawn('node', ['index.js']);

    expect(Object.keys(process).sort()).toEqual(['exit', 'kill', 'pid', 'stderr', 'stdin', 'stdout']);
    expect(process.pid).toBe(4);
    expect(await process.exit).toBe(0);
  });

  test('an endpoint is its port and URL, the same object in current and in listeners', async () => {
    const container = await Mimic.boot();
    const [endpoint] = container.endpoints.current;

    expect(endpoint).toEqual({ port: 3000, url: internalEndpoint.url });
    const published: unknown[] = [];
    container.endpoints.on('published', (value) => published.push(value));
    listeners.get('published')?.(internalEndpoint);
    expect(published).toEqual([endpoint]);
    expect(published[0]).toBe(endpoint);
  });

  test('the file system offers no access, link, utimes or chmod', async () => {
    const container = await Mimic.boot();

    for (const method of ['access', 'link', 'utimes', 'chmod']) {
      expect(method in container.fs).toBe(false);
    }
    expect(container.fs.revision).toBe(7);
  });

  test('a crash error narrows by its class and its code', () => {
    const error: unknown = new MimicProcessCrashError(4, 'the worker stopped');

    expect(error instanceof MimicProcessCrashError && error.code === 'PROCESS_CRASH' && error.pid).toBe(4);
  });
});

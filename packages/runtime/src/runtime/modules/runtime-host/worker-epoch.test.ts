import { describe, expect, test, vi } from 'vitest';

import {
  createRuntimeHostEpoch,
  startRuntimeHostWorker,
  type RuntimeHostEpoch
} from './worker-epoch';
import {
  createAsyncVirtualFileSystemClient
} from '../virtual-file-system';
import type { RuntimeHostTerminalResult } from './runtime-host-protocol';
import {
  bootRuntimeHostTestPeer,
  connectRuntimeHostTestPeer,
  connectRuntimeHostTestPort
} from './test-peer';

function connectObservingTermination(epoch: Pick<RuntimeHostEpoch, 'connect'>) {
  let resolveTerminated!: (result: RuntimeHostTerminalResult) => void;
  const terminated = new Promise<RuntimeHostTerminalResult>((resolve) => {
    resolveTerminated = resolve;
  });
  const peer = connectRuntimeHostTestPeer(epoch, {
    runtimeHost: { terminated: resolveTerminated }
  });
  return { peer, terminated };
}

describe('Runtime Host epoch', () => {
  test('serves teardown over its connection and closes the epoch after the connection closes', async () => {
    const closeWorker = vi.fn();
    const epoch = createRuntimeHostEpoch({ closeWorker });
    const peer = connectRuntimeHostTestPeer(epoch);
    await expect(peer.remote.runtimeHost.teardown()).resolves.toEqual({
      type: 'teardown-complete'
    });
    peer.close();
    await epoch.closed;
    expect(closeWorker).toHaveBeenCalledOnce();
  });

  test('acknowledges teardown only after Runtime Host-owned program cleanup', async () => {
    let resolveProgramStarted!: () => void;
    const programStarted = new Promise<void>((resolve) => {
      resolveProgramStarted = resolve;
    });
    let programSettled = false;
    const epoch = createRuntimeHostEpoch({
      closeWorker: () => undefined,
      runtimePrograms: [
        {
          id: 'pending-cleanup',
          commands: ['pending-cleanup'],
          handlesSignals: true,
          async run(_args, context) {
            resolveProgramStarted();
            await context.signal;
            await new Promise((resolve) => setTimeout(resolve, 10));
            programSettled = true;
            return 0;
          }
        }
      ]
    });
    const { peer, processes } = await bootRuntimeHostTestPeer(
      epoch,
      '/home/runtime-host-cleanup'
    );
    const process = await processes.spawn({
      command: 'pending-cleanup',
      args: [],
      cwd: '/home/runtime-host-cleanup',
      env: {},
      parentPid: 0
    });
    await programStarted;
    await expect(peer.remote.runtimeHost.teardown()).resolves.toEqual({
      type: 'teardown-complete'
    });
    expect(programSettled).toBe(true);
    await expect(process.exit).resolves.toBe(137);
    await expect(process.termination).resolves.toEqual({
      code: 137,
      signal: 'SIGKILL'
    });
    processes.close();
    peer.close();
    await epoch.closed;
  });

  test('owns the terminal decision for browser-hosted background invariant failures', async () => {
    const cleanupFailure = new Error('Runtime Host cleanup marker');
    const closeWorker = vi.fn(() => {
      throw cleanupFailure;
    });
    const epoch = createRuntimeHostEpoch({ closeWorker });
    const { peer, terminated } = connectObservingTermination(epoch);

    peer.notify.runtimeHost.adapterFault({
      kind: 'invariant-violation',
      adapter: 'runtime-program',
      error: {
        name: 'Error',
        message: 'background invariant marker'
      }
    });

    await expect(terminated).resolves.toMatchObject({
      type: 'terminal-failure',
      failure: {
        kind: 'adapter-invariant',
        fault: {
          kind: 'invariant-violation',
          adapter: 'runtime-program',
          error: {
            name: 'Error',
            message: 'background invariant marker'
          }
        }
      },
      cleanupFailures: [
        expect.objectContaining({
          name: 'Error',
          message: 'Runtime Host cleanup marker'
        })
      ]
    });
    await peer.closed;
    await epoch.closed;
    expect(closeWorker).toHaveBeenCalledOnce();
  });

  test('owns authoritative VFS state and revisions behind its connection', async () => {
    const epoch = createRuntimeHostEpoch({ closeWorker: () => undefined });
    const peer = connectRuntimeHostTestPeer(epoch);
    await peer.remote.fs.initialize('/home/runtime-host');
    const fs = await createAsyncVirtualFileSystemClient(peer.remote.fs);

    await fs.writeFile('/home/runtime-host/authority.txt', 'owned by runtime host');

    expect(await fs.readFile('/home/runtime-host/authority.txt', 'utf8')).toBe('owned by runtime host');
    expect(fs.revision).toBe(1);
    await expect(fs.readFile('/home/runtime-host/missing.txt')).rejects.toMatchObject({
      name: 'VirtualFileSystemError',
      code: 'NOT_FOUND'
    });
    expect(await fs.readFile('/home/runtime-host/authority.txt', 'utf8')).toBe('owned by runtime host');
    fs.close();
    peer.close();
    await epoch.closed;
  });

  test('assembles Shell, JavaScript, and package-manager Runtime Programs into the default Runtime Host registry', async () => {
    const epoch = createRuntimeHostEpoch({ closeWorker: () => undefined });
    const { peer, processes } = await bootRuntimeHostTestPeer(
      epoch,
      '/home/runtime-host-programs'
    );
    const process = await processes.spawn({
      command: 'sh',
      args: ['-c', 'echo "registered $(which npm)"'],
      cwd: '/home/runtime-host-programs',
      env: {},
      parentPid: 0
    });
    const [output, code] = await Promise.all([
      new Response(process.output).text(),
      process.exit
    ]);
    expect({ code, output }).toEqual({ code: 0, output: 'registered npm\n' });

    await peer.remote.runtimeHost.teardown();
    processes.close();
    peer.close();
    await epoch.closed;
  });

  test('serves exactly one connection', () => {
    const epoch = createRuntimeHostEpoch({ closeWorker: () => undefined });
    const peer = connectRuntimeHostTestPeer(epoch);
    expect(() => connectRuntimeHostTestPeer(epoch)).toThrow(
      'The Runtime Host epoch already serves a connection.'
    );
    peer.close();
  });

  test('terminally fails the active session when the worker has an unhandled error', async () => {
    const closeWorker = vi.fn();
    const channel = new MessageChannel();
    let reportUnhandledError: (event: { readonly error: unknown; preventDefault(): void }) => void = () => {};
    const epoch = startRuntimeHostWorker({
      page: channel.port1,
      closeWorker,
      onUnhandledError: (listener) => {
        reportUnhandledError = listener;
      },
      onUnhandledRejection: () => {}
    });
    let resolveTerminated!: (result: RuntimeHostTerminalResult) => void;
    const terminated = new Promise<RuntimeHostTerminalResult>((resolve) => {
      resolveTerminated = resolve;
    });
    const peer = connectRuntimeHostTestPort(channel.port2, {
      runtimeHost: { terminated: resolveTerminated }
    });
    const preventDefault = vi.fn();

    reportUnhandledError({ error: new Error('worker crashed'), preventDefault });

    await expect(terminated).resolves.toMatchObject({
      type: 'terminal-failure',
      failure: { kind: 'internal-failure', error: { message: 'worker crashed' } }
    });
    await peer.closed;
    await epoch.closed;
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(closeWorker).toHaveBeenCalledOnce();
  });

  test('terminally fails the active session when the worker has an unhandled rejection', async () => {
    const closeWorker = vi.fn();
    const channel = new MessageChannel();
    let reportUnhandledRejection: (event: { readonly reason: unknown; preventDefault(): void }) => void = () => {};
    const epoch = startRuntimeHostWorker({
      page: channel.port1,
      closeWorker,
      onUnhandledError: () => {},
      onUnhandledRejection: (listener) => {
        reportUnhandledRejection = listener;
      }
    });
    const peer = connectRuntimeHostTestPort(channel.port2);
    const preventDefault = vi.fn();

    reportUnhandledRejection({ reason: new Error('promise rejected'), preventDefault });

    await peer.closed;
    await epoch.closed;
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(closeWorker).toHaveBeenCalledOnce();
  });
});

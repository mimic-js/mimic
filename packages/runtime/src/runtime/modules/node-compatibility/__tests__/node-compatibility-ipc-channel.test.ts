import { describe, expect, test } from 'vitest';

import { createChildProcessBuiltin, type ChildProcessExecutionPort } from '../child-process';
import {
  createClusterBuiltin,
  type ClusterAddress,
  type ClusterChildProcess,
  type ClusterListeningServer,
  type ClusterProcess
} from '../cluster';
import { EventEmitter } from '../events';
import { attachIpcChannel, exposeIpcChannel, splitIpcStdio } from '../ipc-channel';
import type { WorkerThreadMessage, WorkerThreadPortLink, WorkerThreadPortSink, WorkerThreadPorts } from '../worker-threads';
import type { ProcessExecutionChildRequest } from '../../process-execution';

/**
 * The relay of one process tree, reduced to what an IPC channel uses: a
 * hosted pair whose ends keep what was posted to them until their holder
 * listens, and learn of the other end's close.
 */
class FakeRelay {
  readonly #ends = new Map<string, { peer: string; queue: WorkerThreadMessage[]; sink?: WorkerThreadPortSink; listening: boolean }>();
  #nextId = 0;

  ports(): WorkerThreadPorts {
    return {
      createId: () => `fake.${++this.#nextId}`,
      host: (staying, moving, pending) => {
        this.#ends.set(staying, { peer: moving, queue: [], listening: false });
        this.#ends.set(moving, { peer: staying, queue: [...pending], listening: false });
      },
      link: (id, sink) => this.#link(id, sink)
    };
  }

  #link(id: string, sink: WorkerThreadPortSink): WorkerThreadPortLink {
    const end = this.#ends.get(id)!;
    end.sink = sink;
    const forward = (): void => {
      if (!end.listening) return;
      for (const message of end.queue.splice(0)) queueMicrotask(() => sink.message(structuredClone(message)));
    };
    return {
      post: (message) => {
        const peer = this.#ends.get(end.peer);
        if (!peer) return;
        peer.queue.push(structuredClone(message));
        if (peer.listening && peer.sink) {
          for (const queued of peer.queue.splice(0)) queueMicrotask(() => peer.sink!.message(queued));
        }
      },
      receive: () => end.queue.shift(),
      listen: () => {
        end.listening = true;
        forward();
      },
      unlisten: () => {
        end.listening = false;
      },
      release: () => undefined,
      close: () => {
        this.#ends.delete(id);
        const peer = this.#ends.get(end.peer);
        if (peer?.sink) queueMicrotask(() => peer.sink!.close());
      }
    };
  }
}

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function trackedActivity() {
  let held = 0;
  return {
    get held() {
      return held;
    },
    acquire() {
      held += 1;
      let released = false;
      return () => {
        if (!released) held -= 1;
        released = true;
      };
    }
  };
}

class ForkPort implements ChildProcessExecutionPort {
  readonly requests: ProcessExecutionChildRequest[] = [];
  #exit!: (outcome: { code: number; signal: null }) => void;

  async spawn(request: ProcessExecutionChildRequest) {
    this.requests.push(request);
    return {
      pid: 81,
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exit: new Promise<{ code: number; signal: null }>((resolve) => {
        this.#exit = resolve;
      })
    };
  }

  async signal() {
    return true;
  }

  exit(code: number): void {
    this.#exit({ code, signal: null });
  }
}

describe('child_process IPC channels', () => {
  test('fork runs the module with the parent execArgv, the parent stdio and an IPC channel', async () => {
    const relay = new FakeRelay();
    const port = new ForkPort();
    const parentActivity = trackedActivity();
    const childProcess = createChildProcessBuiltin({
      cwd: '/workspace',
      env: { NX_WORKSPACE_ROOT: '/workspace' },
      parentPid: 7,
      port,
      execPath: '/usr/bin/node',
      execArgv: ['--conditions=development'],
      ipc: { ports: relay.ports(), activity: parentActivity, nextTick: queueMicrotask }
    });

    const child = childProcess.fork('/workspace/node_modules/nx/bin/run-executor.js', ['--flag'], {
      stdio: ['inherit', 'pipe', 'pipe', 'ipc']
    }) as EventEmitter & { send(message: unknown): boolean; connected: boolean; disconnect(): void };
    // Sent before the child exists, as nx sends the task to run.
    expect(child.send({ targetDescription: { project: 'api', target: 'build' }, at: new Date(0) })).toBe(true);
    await settle();

    const request = port.requests[0]!;
    expect(request).toMatchObject({
      command: '/usr/bin/node',
      args: ['--conditions=development', '/workspace/node_modules/nx/bin/run-executor.js', '--flag'],
      stdio: { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' },
      ipc: { serialization: 'json' }
    });

    // The child links its end when its process starts, after the parent sent.
    const childProcessObject = new EventEmitter();
    const childActivity = trackedActivity();
    const childChannel = attachIpcChannel(childProcessObject, {
      ports: relay.ports(),
      port: request.ipc!.port,
      serialization: request.ipc!.serialization,
      activity: childActivity,
      nextTick: queueMicrotask
    });
    exposeIpcChannel(childProcessObject, childChannel);
    await settle();
    expect(childActivity.held).toBe(0);

    const received: unknown[] = [];
    childProcessObject.on('message', (message: unknown) => received.push(message));
    await settle();
    // JSON serialization, as Node's default: a Date arrives as its string.
    expect(received).toEqual([{ targetDescription: { project: 'api', target: 'build' }, at: '1970-01-01T00:00:00.000Z' }]);
    // A listener keeps the child alive while the channel is open.
    expect(childActivity.held).toBe(1);

    const answers: unknown[] = [];
    child.on('message', (message: unknown) => answers.push(message));
    expect((childProcessObject as unknown as { send(message: unknown): boolean }).send({ type: 'done', code: 0 })).toBe(true);
    await settle();
    expect(answers).toEqual([{ type: 'done', code: 0 }]);
    expect(parentActivity.held).toBe(1);

    const events: string[] = [];
    child.on('disconnect', () => events.push('disconnect'));
    child.on('exit', (code: number) => events.push(`exit ${code}`));
    child.on('close', () => events.push('close'));
    port.exit(0);
    await settle();
    expect(events).toEqual(['exit 0', 'disconnect', 'close']);
    expect(child.connected).toBe(false);
    expect(parentActivity.held).toBe(0);

    // The parent's end closed with the child: the child's side hears it too.
    expect((childProcessObject as unknown as { connected: boolean }).connected).toBe(false);
    expect(childActivity.held).toBe(0);

    const sendErrors: unknown[] = [];
    expect((child as unknown as { send(message: unknown, callback: (error: Error | null) => void): boolean })
      .send({ late: true }, (error) => sendErrors.push(error))).toBe(false);
    await settle();
    expect(sendErrors).toEqual([expect.objectContaining({ code: 'ERR_IPC_CHANNEL_CLOSED' })]);
  });

  test('disconnect closes both sides, and fork requires an IPC entry in stdio', async () => {
    const relay = new FakeRelay();
    const port = new ForkPort();
    const childProcess = createChildProcessBuiltin({
      cwd: '/workspace',
      env: {},
      parentPid: 7,
      port,
      ipc: { ports: relay.ports(), nextTick: queueMicrotask }
    });
    expect(() => childProcess.fork('/workspace/a.js', [], { stdio: ['pipe', 'pipe', 'pipe'] })).toThrowError(
      expect.objectContaining({ code: 'ERR_CHILD_PROCESS_IPC_REQUIRED' })
    );

    const child = childProcess.fork('/workspace/a.js', { silent: true }) as EventEmitter & {
      connected: boolean;
      disconnect(): void;
    };
    await settle();
    expect(port.requests.at(-1)).toMatchObject({ command: 'node', args: ['/workspace/a.js'], stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' } });
    const childSide = new EventEmitter();
    const childEvents: string[] = [];
    childSide.on('disconnect', () => childEvents.push('disconnect'));
    const channel = attachIpcChannel(childSide, { ports: relay.ports(), port: port.requests.at(-1)!.ipc!.port, serialization: 'json', nextTick: queueMicrotask });

    const parentEvents: string[] = [];
    child.on('disconnect', () => parentEvents.push('disconnect'));
    child.disconnect();
    expect(child.connected).toBe(false);
    await settle();
    expect(parentEvents).toEqual(['disconnect']);
    expect(childEvents).toEqual(['disconnect']);
    expect(channel.connected).toBe(false);
  });

  test('takes the IPC entry out of the standard streams', () => {
    expect(splitIpcStdio(['inherit', 'pipe', 'pipe', 'ipc'])).toEqual({ stdio: ['inherit', 'pipe', 'pipe'], ipc: true });
    expect(splitIpcStdio(['pipe', 'ipc'])).toEqual({ stdio: ['pipe', 'ignore'], ipc: true });
    expect(splitIpcStdio('pipe')).toEqual({ stdio: 'pipe', ipc: false });
    expect(() => splitIpcStdio(['ipc', 'ipc'])).toThrowError(expect.objectContaining({ code: 'ERR_IPC_ONE_PIPE' }));
  });
});

type ClusterWorkerHandle = EventEmitter & {
  id: number;
  state: string;
  exitedAfterDisconnect: boolean | undefined;
  kill(signal?: string): void;
  disconnect(): unknown;
};

/**
 * A primary that forks one cluster worker over a real IPC channel, and the
 * worker's own side: its `process`, attached to the child's end of that
 * channel, and the `cluster` module it loads.
 */
async function forkClusterWorker() {
  const relay = new FakeRelay();
  const port = new ForkPort();
  const childProcess = createChildProcessBuiltin({
    cwd: '/workspace',
    env: {},
    parentPid: 7,
    port,
    ipc: { ports: relay.ports(), nextTick: queueMicrotask }
  });
  const primary = createClusterBuiltin({
    process: Object.assign(new EventEmitter(), { env: {}, argv: ['node', '/workspace/main.js'] }) as unknown as ClusterProcess,
    fork: (modulePath, args, options) =>
      childProcess.fork(modulePath, [...args], options) as unknown as ClusterChildProcess
  }) as EventEmitter & { fork(): ClusterWorkerHandle };
  const primaryWorker = primary.fork();
  await settle();
  const request = port.requests[0]!;
  const exits: unknown[] = [];
  const workerProcess = Object.assign(new EventEmitter(), {
    env: { ...request.env },
    argv: ['node', '/workspace/main.js'],
    // A worker's `process.kill` takes a pid, as Node's does.
    kill(pid: unknown) {
      if (typeof pid !== 'number') throw Object.assign(new TypeError('The "pid" argument must be of type number'), { code: 'ERR_INVALID_ARG_TYPE' });
      return true;
    },
    exit(code?: number) {
      exits.push(code);
    }
  });
  exposeIpcChannel(workerProcess, attachIpcChannel(workerProcess, {
    ports: relay.ports(),
    port: request.ipc!.port,
    serialization: request.ipc!.serialization,
    nextTick: queueMicrotask
  }));
  let serverListening: ((server: ClusterListeningServer, address: ClusterAddress) => void) | undefined;
  const worker = createClusterBuiltin({
    process: workerProcess as unknown as ClusterProcess,
    fork: () => {
      throw new Error('a worker forks no workers');
    },
    onServerListening: (listener) => {
      serverListening = listener;
    }
  }) as { isWorker: boolean; worker: ClusterWorkerHandle };
  return {
    port,
    primary,
    primaryWorker,
    workerProcess,
    exits,
    worker: worker.worker,
    listen: (server: ClusterListeningServer, address: ClusterAddress) => serverListening!(server, address)
  };
}

describe('cluster over the IPC channel', () => {
  test('worker.kill() in a worker disconnects it and exits it with 0, after its primary learns it was intended', async () => {
    const { port, primary, primaryWorker, workerProcess, exits, worker } = await forkClusterWorker();
    const primaryEvents: unknown[] = [];
    primaryWorker.process.on('message', (message: unknown) => primaryEvents.push(['message', message]));
    primary.on('disconnect', (handle: ClusterWorkerHandle) => primaryEvents.push(['disconnect', handle.id]));
    primary.on('exit', (handle: ClusterWorkerHandle, code: number | null) =>
      primaryEvents.push(['exit', handle.id, code, handle.exitedAfterDisconnect]));

    worker.kill();
    expect(worker).toMatchObject({ state: 'destroying', exitedAfterDisconnect: true });
    await settle();
    await settle();

    expect((workerProcess as unknown as { connected: boolean }).connected).toBe(false);
    expect(exits).toEqual([0]);
    port.exit(0);
    await settle();
    // The cluster's own message is not one of the worker's messages.
    expect(primaryEvents).toEqual([['disconnect', 1], ['exit', 1, 0, true]]);
  });

  test('worker.disconnect() in a worker closes its channel and lets the process end by itself', async () => {
    const { primaryWorker, workerProcess, exits, worker } = await forkClusterWorker();
    const events: string[] = [];
    worker.on('disconnect', () => events.push('worker disconnect'));

    expect(worker.disconnect()).toBe(worker);
    expect(worker).toMatchObject({ state: 'disconnecting', exitedAfterDisconnect: true });
    await settle();
    await settle();

    expect((workerProcess as unknown as { connected: boolean }).connected).toBe(false);
    expect(events).toEqual(['worker disconnect']);
    expect(exits).toEqual([]);
    expect(primaryWorker.exitedAfterDisconnect).toBe(true);
  });

  test("the primary emits 'listening' for each server a worker listens with, and disconnect() closes them first", async () => {
    const { primary, primaryWorker, workerProcess, worker, listen } = await forkClusterWorker();
    const events: unknown[] = [];
    primaryWorker.on('listening', (address: unknown) => events.push(['worker listening', address]));
    primary.on('listening', (handle: ClusterWorkerHandle, address: unknown) =>
      events.push(['cluster listening', handle.id, address, handle.state]));
    const closes: Array<() => void> = [];
    const server = Object.assign(new EventEmitter(), {
      close(callback?: () => void) {
        closes.push(() => {
          callback?.();
          server.emit('close');
        });
      }
    });

    listen(server, { addressType: 4, address: null, port: 3000 });
    await settle();
    await settle();
    expect(worker.state).toBe('listening');
    expect(events).toEqual([
      ['worker listening', { addressType: 4, address: null, port: 3000 }],
      ['cluster listening', 1, { addressType: 4, address: null, port: 3000 }, 'listening']
    ]);

    worker.disconnect();
    await settle();
    // The channel stays open until the worker's servers closed.
    expect(closes).toHaveLength(1);
    expect((workerProcess as unknown as { connected: boolean }).connected).toBe(true);
    closes[0]!();
    await settle();
    await settle();
    expect((workerProcess as unknown as { connected: boolean }).connected).toBe(false);
    expect(primaryWorker.exitedAfterDisconnect).toBe(true);
  });

  test('a worker whose primary goes away exits, and one without a channel exits at once on kill()', async () => {
    const { primaryWorker, exits } = await forkClusterWorker();
    primaryWorker.process.disconnect();
    await settle();
    await settle();
    expect(exits).toEqual([0]);

    const exitCodes: unknown[] = [];
    const lone = createClusterBuiltin({
      process: Object.assign(new EventEmitter(), {
        env: { NODE_UNIQUE_ID: '2' },
        argv: ['node', '/workspace/main.js'],
        exit: (code?: number) => exitCodes.push(code)
      }) as unknown as ClusterProcess,
      fork: () => {
        throw new Error('a worker forks no workers');
      }
    }) as { worker: ClusterWorkerHandle };
    lone.worker.kill();
    expect(exitCodes).toEqual([0]);
    expect(lone.worker.exitedAfterDisconnect).toBe(true);
  });
});

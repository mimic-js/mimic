import { runInNewContext } from 'node:vm';

import { describe, expect, test, vi } from 'vitest';

import {
  createWorkerThreadSharedArrayBufferConstructor,
  installWorkerThreadRuntimeGlobals
} from '../worker-threads';
import {
  createWorkerThreadSharedMemoryPool,
  type WorkerThreadSharedMemoryPool
} from '../worker-thread-shared-memory';
import { createWorkerThreadsBuiltin } from '../worker-threads';
import type {
  ThreadExecutionLease,
  ThreadStartRequest,
  WorkerThreadMessage,
  WorkerThreadPortSink,
  WorkerThreadsBuiltinOptions
} from '../worker-threads';

type FakeLink = {
  readonly id: string;
  readonly sink: WorkerThreadPortSink;
  readonly posted: Array<{ readonly message: WorkerThreadMessage; readonly transfer: readonly Transferable[] }>;
  readonly pending: WorkerThreadMessage[];
  listening: boolean;
  closed: boolean;
};

/**
 * A thread's transport as the process worker provides it, recorded: what the
 * builtin hosts, posts, receives, and starts.
 */
function createFakeThread(
  identity = { pid: 41, threadId: 0 },
  pool: WorkerThreadSharedMemoryPool = createWorkerThreadSharedMemoryPool(),
  overrides: Partial<WorkerThreadsBuiltinOptions> = {}
) {
  const links = new Map<string, FakeLink>();
  const hosted: Array<{ staying: string; moving: string; pending: readonly WorkerThreadMessage[] }> = [];
  const started: ThreadStartRequest[] = [];
  const leases: Array<ThreadExecutionLease & { readonly terminate: ReturnType<typeof vi.fn> }> = [];
  let nextId = 0;
  const builtin = createWorkerThreadsBuiltin({
    current: { identity },
    cwd: '/home/project',
    env: { INHERITED: 'parent-value' },
    sharedMemoryPool: pool,
    ports: {
      createId: () => `${identity.threadId}.${++nextId}`,
      host: (staying, moving, pending) => hosted.push({ staying, moving, pending }),
      link(id, sink) {
        const link: FakeLink = { id, sink, posted: [], pending: [], listening: false, closed: false };
        links.set(id, link);
        return {
          post: (message, transfer) => link.posted.push({ message, transfer }),
          receive: () => link.pending.shift(),
          listen: () => {
            link.listening = true;
          },
          unlisten: () => {
            link.listening = false;
          },
          release: () => links.delete(id),
          close: () => {
            link.closed = true;
          }
        };
      }
    },
    threads: {
      start(request) {
        started.push(request);
        let referenced = true;
        const lease = {
          terminate: vi.fn(async () => 1),
          ref: () => {
            referenced = true;
          },
          unref: () => {
            referenced = false;
          },
          hasRef: () => referenced
        };
        leases.push(lease);
        return lease;
      }
    },
    ...overrides
  });
  return { builtin, links, hosted, started, leases, pool };
}

/** What a message looks like after the structured clone of the channel that carries it. */
function carried(message: WorkerThreadMessage): WorkerThreadMessage {
  return structuredClone(message);
}

describe('worker_threads Node Compatibility adapter', () => {
  test('owns queued worker-thread runtime globals', () => {
    const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
    installWorkerThreadRuntimeGlobals(runtimeGlobal);
    const event = new MessageEvent('message', { data: 'ready' });
    Reflect.apply(runtimeGlobal.onmessage as (event: MessageEvent) => void, runtimeGlobal, [event]);
    const handler = vi.fn();

    runtimeGlobal.onmessage = handler;

    expect(handler).toHaveBeenCalledWith(event);
    expect(runtimeGlobal.self).toBe(runtimeGlobal);
  });

  test('leaves WebAssembly values to the structured clone of the channel', () => {
    const { builtin, links } = createFakeThread();
    const wasmModule = new WebAssembly.Module(new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]));
    const wasmMemory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const worker = new builtin.Worker('/home/project/thread.mjs');

    worker.postMessage({ wasmModule, wasmMemory });

    const [workerEnd] = [...links.values()];
    const { value } = carried(workerEnd!.posted[0]!.message) as {
      value: { wasmModule: WebAssembly.Module; wasmMemory: WebAssembly.Memory };
    };
    expect(() => new WebAssembly.Instance(value.wasmModule)).not.toThrow();
    expect(value.wasmMemory.buffer).toBeInstanceOf(SharedArrayBuffer);
  });

  test('copies cross-realm Maps and proxies into plain data', () => {
    const { builtin, links } = createFakeThread();
    const worker = new builtin.Worker('/home/project/thread.mjs');
    const filesMap = runInNewContext("new Map([['package.json', '/store/package.json']])") as Map<string, string>;
    function Map() {}

    worker.postMessage({
      filesMap,
      spoofedMap: { [Symbol.toStringTag]: 'Map', entry: 'plain-object' },
      craftedMap: Object.assign(Object.create(Map.prototype), { [Symbol.toStringTag]: 'Map', entry: 'plain-object' }),
      realm: new Proxy({ task: { id: 1 } }, {})
    });

    const [workerEnd] = [...links.values()];
    const { value } = carried(workerEnd!.posted[0]!.message) as {
      value: Record<string, unknown> & { filesMap: globalThis.Map<string, string> };
    };
    expect([...value.filesMap.keys()]).toEqual(['package.json']);
    expect(value.spoofedMap).toEqual({ entry: 'plain-object' });
    expect(value.craftedMap).toEqual({ entry: 'plain-object' });
    expect(value.realm).toEqual({ task: { id: 1 } });
  });

  test('starts a worker as a thread of the same process with a hosted parent port', async () => {
    const { builtin, links, hosted, started, leases } = createFakeThread();

    expect(builtin.isMainThread).toBe(true);
    expect(builtin.threadId).toBe(0);
    expect(builtin.parentPort).toBeNull();
    expect(builtin.workerData).toBeNull();
    expect(builtin.BroadcastChannel).not.toBe(globalThis.BroadcastChannel);

    const worker = new builtin.Worker('/home/project/thread.mjs', {
      workerData: { fixture: true },
      argv: ['thread-arg'],
      env: { WORKER_ONLY: 'worker-value' },
      execArgv: ['--unhandled-rejections=strict', '--experimental-wasi-unstable-preview1'],
      name: 'pino-transport'
    });
    const second = new builtin.Worker('/home/project/thread.mjs');
    const received: unknown[] = [];
    const errors: Error[] = [];
    const exits: number[] = [];
    worker.on('message', (value: unknown) => received.push(value));
    worker.on('error', (error: Error) => errors.push(error));
    worker.on('exit', (code: number) => exits.push(code));

    expect([worker.threadId, second.threadId]).toEqual([1, 2]);
    expect(started[0]).toMatchObject({
      entry: { kind: 'module', specifier: '/home/project/thread.mjs' },
      identity: { pid: 41, threadId: 1 },
      parent: { pid: 41, threadId: 0 },
      workerData: { value: { fixture: true }, references: [] },
      cwd: '/home/project',
      env: { WORKER_ONLY: 'worker-value' },
      argv: ['thread-arg'],
      execArgv: ['--unhandled-rejections=strict', '--experimental-wasi-unstable-preview1']
    });
    // The pair is hosted before the thread starts; this end listens, the thread's waits.
    expect(hosted[0]).toEqual({ staying: expect.any(String), moving: started[0]!.parentPort, pending: [] });
    const workerEnd = links.get(hosted[0]!.staying)!;
    expect(workerEnd.listening).toBe(true);

    worker.postMessage('to-thread');
    expect(workerEnd.posted.map((post) => post.message.value)).toEqual(['to-thread']);
    worker.unref();
    expect(leases[0]!.hasRef()).toBe(false);
    worker.ref();
    expect(leases[0]!.hasRef()).toBe(true);

    workerEnd.sink.message(carried({ value: 'from-thread', references: [] }));
    started[0]!.reportFailure(new Error('thread failure'));
    await Promise.resolve();
    await Promise.resolve();
    workerEnd.sink.message(carried({ value: 'late-message', references: [] }));
    worker.postMessage('late-to-thread');

    expect(received).toEqual(['from-thread']);
    expect(errors.map((error) => error.message)).toEqual(['thread failure']);
    expect(exits).toEqual([1]);
    expect(workerEnd.closed).toBe(true);
    expect(workerEnd.posted).toHaveLength(1);
    await expect(worker.terminate()).resolves.toBe(1);
    expect(leases[0]!.terminate).toHaveBeenCalledOnce();
  });

  test('carries eval source as a typed inline-source thread entry', () => {
    const { builtin, started } = createFakeThread();
    const source = "const { parentPort } = require('node:worker_threads'); parentPort.postMessage('ready');";

    new builtin.Worker(source, { eval: true, workerData: 'fixture' });

    expect(started[0]).toMatchObject({
      entry: { kind: 'inline-source', source },
      workerData: { value: 'fixture', references: [] },
      env: { INHERITED: 'parent-value' },
      argv: []
    });
  });

  test('hosts a local channel whose end leaves with workerData, with the messages queued for it', async () => {
    const parent = createFakeThread();
    const channel = new parent.builtin.MessageChannel();
    channel.port1.postMessage('queued-before-transfer');
    await Promise.resolve();

    new parent.builtin.Worker('/home/project/thread.mjs', {
      workerData: { port: channel.port2 },
      transferList: [channel.port2]
    });

    const workerData = parent.started[0]!.workerData;
    expect(workerData.references).toEqual([{ port: channel.port2.id }]);
    expect(parent.hosted[0]).toEqual({
      staying: channel.port1.id,
      moving: channel.port2.id,
      pending: [{ value: 'queued-before-transfer', references: [] }]
    });
    // The end that stays now goes through the host too.
    channel.port1.postMessage('after-transfer');
    expect(parent.links.get(channel.port1.id)!.posted.map((post) => post.message.value)).toEqual([
      'after-transfer'
    ]);

    const child = createFakeThread(
      { pid: 41, threadId: 1 },
      parent.pool,
      { current: { identity: { pid: 41, threadId: 1 }, workerData: carried(workerData), parentPort: 'parent' } }
    );
    const { port } = child.builtin.workerData as { port: InstanceType<typeof child.builtin.MessagePort> };
    expect(port).toBeInstanceOf(child.builtin.MessagePort);
    expect(port.id).toBe(channel.port2.id);
    expect(child.builtin.isMainThread).toBe(false);
    expect(child.builtin.threadId).toBe(1);
    expect(child.builtin.parentPort).toBeInstanceOf(child.builtin.MessagePort);
  });

  test('receives synchronously over the hosted end, restoring ports and pooled signals', () => {
    const pool = createWorkerThreadSharedMemoryPool();
    const parent = createFakeThread({ pid: 41, threadId: 0 }, pool);
    const SharedArrayBufferInThread = createWorkerThreadSharedArrayBufferConstructor(pool);
    const signal = new Int32Array(new SharedArrayBufferInThread(4));
    const nested = new parent.builtin.MessageChannel();
    const worker = new parent.builtin.Worker('/home/project/thread.mjs');
    worker.postMessage({ port: nested.port2, signal }, [nested.port2]);

    const [workerEnd] = [...parent.links.values()];
    const posted = workerEnd!.posted[0]!.message;
    expect(posted.references).toEqual([
      { port: nested.port2.id },
      { signal: 0, view: { kind: 'Int32Array', byteOffset: 0, length: 1 } }
    ]);

    const child = createFakeThread({ pid: 41, threadId: 1 }, pool, {
      current: { identity: { pid: 41, threadId: 1 }, parentPort: 'parent-port' }
    });
    child.links.get('parent-port')!.pending.push(carried(posted));
    const received = child.builtin.receiveMessageOnPort(child.builtin.parentPort!) as {
      message: { port: InstanceType<typeof child.builtin.MessagePort>; signal: Int32Array };
    };

    Atomics.store(received.message.signal, 0, 7);
    expect(Atomics.load(signal, 0)).toBe(7);
    expect(received.message.port.id).toBe(nested.port2.id);
    expect(child.builtin.receiveMessageOnPort(child.builtin.parentPort!)).toBeUndefined();
  });

  test('delivers local MessagePort payloads asynchronously without losing undefined', async () => {
    const { builtin } = createFakeThread();
    const channel = new builtin.MessageChannel();
    const messages: unknown[] = [];
    const ordering = ['before-post'];
    channel.port2.on('message', (value: unknown) => messages.push(value));
    channel.port2.on('message', () => ordering.push('message'));

    channel.port1.postMessage(undefined);
    channel.port1.postMessage('first');
    channel.port1.postMessage('second');
    ordering.push('after-post');

    expect(messages).toEqual([]);
    await vi.waitFor(() => {
      expect(messages).toEqual([undefined, 'first', 'second']);
    });
    expect(ordering).toEqual(['before-post', 'after-post', 'message', 'message', 'message']);
    channel.port1.postMessage('queued');
    await Promise.resolve();
    await Promise.resolve();
    channel.port2.removeAllListeners('message');
    channel.port1.postMessage('pulled');
    await Promise.resolve();
    expect(builtin.receiveMessageOnPort(channel.port2)).toEqual({ message: 'pulled' });
    expect(builtin.receiveMessageOnPort(channel.port2)).toBeUndefined();
  });

  test('starts and references a port for a listener added by any of the listener methods', () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const child = createFakeThread({ pid: 41, threadId: 1 }, undefined, {
      activity: { acquire },
      current: { identity: { pid: 41, threadId: 1 }, parentPort: 'parent-port' }
    });
    const parentPort = child.builtin.parentPort!;
    const link = child.links.get('parent-port')!;
    const listener = (): void => undefined;

    parentPort.addListener('message', listener);
    expect(link.listening).toBe(true);
    expect(parentPort.hasRef()).toBe(true);

    parentPort.off('message', listener);
    expect(link.listening).toBe(false);
    expect(parentPort.hasRef()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  test('keeps what was posted before the other end closed receivable synchronously', async () => {
    const { builtin } = createFakeThread();
    const channel = new builtin.MessageChannel();
    const closed: string[] = [];
    channel.port2.on('close', () => closed.push('port2'));

    channel.port1.postMessage('first');
    channel.port1.postMessage('second');
    channel.port1.close();
    await Promise.resolve();
    await Promise.resolve();

    expect(closed).toEqual(['port2']);
    expect(builtin.receiveMessageOnPort(channel.port2)).toEqual({ message: 'first' });
    expect(builtin.receiveMessageOnPort(channel.port2)).toEqual({ message: 'second' });
    expect(builtin.receiveMessageOnPort(channel.port2)).toBeUndefined();
  });

  test('hands out ordinary shared buffers once the pooled signals are spent', () => {
    const pool = createWorkerThreadSharedMemoryPool();
    const { builtin, links } = createFakeThread({ pid: 41, threadId: 0 }, pool);
    const SharedArrayBufferInThread = createWorkerThreadSharedArrayBufferConstructor(pool);
    for (let index = 0; index < pool.signals.length; index += 1) new SharedArrayBufferInThread(4);

    const beyond = new Int32Array(new SharedArrayBufferInThread(4));
    expect(beyond.buffer.byteLength).toBe(4);
    expect(pool.signals).not.toContain(beyond.buffer);
    expect(new SharedArrayBufferInThread(4)).not.toBe(beyond.buffer);

    // It crosses to a listening thread by the structured clone of the channel, not as a pool index.
    const worker = new builtin.Worker('/home/project/thread.mjs');
    worker.postMessage({ beyond });
    const [workerEnd] = [...links.values()];
    expect(workerEnd!.posted[0]!.message).toEqual({ value: { beyond }, references: [] });
  });

  test('gives a Worker the output of its thread when the stdout or stderr option asks for it', async () => {
    const { builtin, started } = createFakeThread();
    const piped = new builtin.Worker('/home/project/thread.mjs');
    expect(piped.stdout).toBeNull();
    expect(piped.stderr).toBeNull();
    expect(started[0]!.output).toEqual({});

    const worker = new builtin.Worker('/home/project/thread.mjs', { stdout: true });
    expect(worker.stderr).toBeNull();
    expect(Object.keys(started[1]!.output)).toEqual(['stdout']);
    const chunks: string[] = [];
    let ended = false;
    worker.stdout!.on('data', (chunk: Uint8Array) => chunks.push(new TextDecoder().decode(chunk)));
    worker.stdout!.on('end', () => {
      ended = true;
    });

    started[1]!.output.stdout!(new TextEncoder().encode('from the thread\n'));
    started[1]!.reportExit(0);

    await vi.waitFor(() => expect(ended).toBe(true));
    expect(chunks).toEqual(['from the thread\n']);
  });

  test('keeps the runtime referenced while a MessagePort is explicitly referenced', () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const { builtin } = createFakeThread(undefined, undefined, { activity: { acquire } });
    const messagePort = new builtin.MessageChannel().port1;

    expect(messagePort.hasRef()).toBe(false);
    messagePort.ref().ref();
    expect(messagePort.hasRef()).toBe(true);
    expect(acquire).toHaveBeenCalledOnce();

    messagePort.unref().unref();
    expect(messagePort.hasRef()).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  test('carries a BroadcastChannel between the threads of one process and no other, referenced until closed', async () => {
    const release = vi.fn();
    const acquire = vi.fn(() => release);
    const pool = createWorkerThreadSharedMemoryPool();
    const main = createFakeThread({ pid: 41, threadId: 0 }, pool, { activity: { acquire } }).builtin;
    const thread = createFakeThread({ pid: 41, threadId: 1 }, pool).builtin;
    const otherProcess = createFakeThread({ pid: 42, threadId: 0 }).builtin;
    const host = new globalThis.BroadcastChannel('nuxt:dev:log');

    const receiver = new main.BroadcastChannel('nuxt:dev:log');
    expect(receiver).toBeInstanceOf(EventTarget);
    expect(acquire).toHaveBeenCalledOnce();
    const received: unknown[] = [];
    receiver.onmessage = (event) => received.push(['onmessage', event.data]);
    receiver.addEventListener('message', (event) => received.push(['listener', (event as MessageEvent).data]));
    const strangers: unknown[] = [];
    const stranger = new otherProcess.BroadcastChannel('nuxt:dev:log');
    stranger.onmessage = (event) => strangers.push(event.data);
    host.onmessage = (event) => strangers.push(event.data);

    const sender = new thread.BroadcastChannel('nuxt:dev:log');
    sender.postMessage({ level: 'info', args: ['ready'] });

    await vi.waitFor(() => expect(received).toHaveLength(2));
    expect(received).toEqual([
      ['onmessage', { level: 'info', args: ['ready'] }],
      ['listener', { level: 'info', args: ['ready'] }]
    ]);
    expect(strangers).toEqual([]);
    expect(() => new (main.BroadcastChannel as unknown as new () => unknown)()).toThrowError(
      expect.objectContaining({ code: 'ERR_MISSING_ARGS' })
    );

    receiver.close();
    expect(release).toHaveBeenCalledOnce();
    expect(() => receiver.postMessage('late')).toThrowError(expect.objectContaining({ name: 'InvalidStateError' }));
    for (const channel of [sender, stranger, host]) channel.close();
  });

  test('drops queued messages after their receiver closes and closes the other end', async () => {
    const { builtin } = createFakeThread();
    const channel = new builtin.MessageChannel();
    const messages: unknown[] = [];
    const closed: string[] = [];
    channel.port2.on('message', (value: unknown) => messages.push(value));
    channel.port1.on('close', () => closed.push('port1'));
    channel.port2.on('close', () => closed.push('port2'));

    channel.port1.postMessage('already-queued');
    channel.port2.close();
    channel.port1.postMessage('after-close');
    await Promise.resolve();
    await Promise.resolve();

    expect(messages).toEqual([]);
    expect(closed.sort()).toEqual(['port1', 'port2']);
  });

  test('delivers admission failures after worker listeners attach', async () => {
    const { builtin } = createFakeThread(undefined, undefined, {
      threads: {
        start(request) {
          request.reportFailure(new Error('during-start failure'));
          return { terminate: async () => 1, ref: () => undefined, unref: () => undefined, hasRef: () => true };
        }
      }
    });
    const worker = new builtin.Worker('/home/project/thread.mjs');
    const errors: string[] = [];
    const exits: number[] = [];
    worker.on('error', (error: Error) => errors.push(error.message));
    worker.on('exit', (code: number) => exits.push(code));

    expect(errors).toEqual([]);
    await Promise.resolve();
    await Promise.resolve();
    expect(errors).toEqual(['during-start failure']);
    expect(exits).toEqual([1]);
  });

  test('rejects invalid worker entries, transfers, and unsupported options with Node-shaped errors', () => {
    const { builtin } = createFakeThread();
    const channel = new builtin.MessageChannel();

    expect(() => new builtin.Worker('bare-package')).toThrowError(expect.objectContaining({ code: 'ERR_WORKER_PATH' }));
    expect(() => new builtin.Worker('/home/project/thread.mjs', { execArgv: ['--inspect'] })).toThrowError(
      expect.objectContaining({ code: 'ERR_WORKER_INVALID_EXEC_ARGV' })
    );
    expect(() => new builtin.Worker('/home/project/thread.mjs', { stdin: true })).toThrowError(
      expect.objectContaining({ code: 'ERR_WORKER_UNSUPPORTED_OPTION' })
    );
    // thread-stream, under pino, names its threads.
    expect(() => new builtin.Worker('/home/project/thread.mjs', { name: 42 } as never)).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
    expect(() => channel.port1.postMessage({ port: channel.port2 })).toThrowError(
      expect.objectContaining({ code: 'ERR_MISSING_MESSAGE_PORT_IN_TRANSFER_LIST' })
    );
    expect(() => builtin.markAsUntransferable({})).toThrowError(
      expect.objectContaining({ code: 'ERR_WORKER_UNSUPPORTED_OPERATION' })
    );
    expect(() => builtin.moveMessagePortToContext(channel.port1)).toThrowError(
      expect.objectContaining({ code: 'ERR_WORKER_UNSUPPORTED_OPERATION' })
    );
  });
});

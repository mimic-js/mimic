import { EventEmitter } from './events';
import { BrowserBuffer } from './buffer';
import type { ProcessExecutionActivityLifecycle } from './child-process';
import { nodeStream, type NodeReadableStream } from './streams';
import { nodeErrorCodeFromDomain } from './domain-errors';
import type { ThreadIdentity } from '../process-execution';
import {
  WORKER_THREAD_POOL_NEXT_SIGNAL,
  WORKER_THREAD_POOL_NEXT_THREAD_ID,
  WORKER_THREAD_SHARED_SIGNAL_BYTES,
  type WorkerThreadSharedMemoryPool
} from './worker-thread-shared-memory';
import { isNodeExitSignal } from './process-exit';

export type ThreadEntry =
  | Readonly<{ readonly kind: 'inline-source'; readonly source: string }>
  | Readonly<{ readonly kind: 'module'; readonly specifier: string }>;

/**
 * A reference inside a {@link WorkerThreadMessage}: a MessagePort end by id,
 * or a pooled signal (with the typed array viewing it) by index.
 */
export type WorkerThreadReference =
  | Readonly<{ port: string }>
  | Readonly<{
      signal: number;
      view?: Readonly<{ kind: string; byteOffset: number; length: number }>;
    }>;

/**
 * A message as it leaves a thread: `value` holds the reference objects listed
 * in `references` wherever the sender's value held a MessagePort or a pooled
 * signal. Every channel that carries a message keeps object identity within
 * it, so the receiver finds them again.
 */
export interface WorkerThreadMessage {
  readonly value: unknown;
  readonly references: readonly WorkerThreadReference[];
}

/** Receives what arrives for one hosted port end in this thread. */
export interface WorkerThreadPortSink {
  message(message: WorkerThreadMessage): void;
  /** The other end closed. */
  close(): void;
}

/** One MessagePort end the Runtime Host relays, as this thread holds it. */
export interface WorkerThreadPortLink {
  post(message: WorkerThreadMessage, transfer: readonly Transferable[]): void;
  /** Takes the next message for this end synchronously, or undefined when none was posted. */
  receive(): WorkerThreadMessage | undefined;
  /** Asks for messages to be delivered to the sink as they arrive. */
  listen(): void;
  /** Leaves later messages with the host for `receive` or a later `listen`. */
  unlisten(): void;
  /** This end moves to another thread; nothing more is delivered here. */
  release(): void;
  close(): void;
}

/**
 * MessagePorts that cross threads. Ports stay local while both ends are in
 * this thread; once an end leaves, the Runtime Host relays the pair.
 */
export interface WorkerThreadPorts {
  /** A process-unique id for a port end created in this thread. */
  createId(): string;
  /**
   * The Runtime Host relays this pair from now on. `staying` remains in this
   * thread; `pending` are the messages already queued for `moving`.
   */
  host(staying: string, moving: string, pending: readonly WorkerThreadMessage[]): void;
  link(id: string, sink: WorkerThreadPortSink): WorkerThreadPortLink;
}

export interface ThreadStartRequest {
  readonly entry: ThreadEntry;
  readonly identity: ThreadIdentity;
  readonly parent: ThreadIdentity;
  readonly workerData: WorkerThreadMessage;
  readonly transfer: readonly Transferable[];
  /** The id of the new thread's `parentPort`, whose other end this Worker holds. */
  readonly parentPort: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
  readonly execArgv: readonly string[];
  /**
   * Receives a stream of the thread that its Worker reads itself. A stream
   * without a receiver is written to the process's own.
   */
  readonly output: ThreadOutputReceivers;
  reportFailure(reason: unknown): void;
  reportExit(code: number): void;
}

export type ThreadOutputStream = 'stdout' | 'stderr';
export type ThreadOutputReceivers = Readonly<
  Partial<Record<ThreadOutputStream, (chunk: Uint8Array) => void>>
>;

export interface ThreadExecutionLease {
  terminate(): Promise<number>;
  ref(): void;
  unref(): void;
  hasRef(): boolean;
}

export interface ThreadExecutionPort {
  start(request: ThreadStartRequest): ThreadExecutionLease;
}

export interface CurrentThreadExecution {
  readonly identity: ThreadIdentity;
  readonly workerData?: WorkerThreadMessage;
  /** The id of this thread's `parentPort`; absent on the main thread. */
  readonly parentPort?: string;
}

/** What `node:worker_threads` needs from its context, apart from the thread execution port. */
export interface WorkerThreadsBuiltinContext {
  readonly current: CurrentThreadExecution;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly activity?: ProcessExecutionActivityLifecycle;
  readonly ports: WorkerThreadPorts;
  readonly sharedMemoryPool: WorkerThreadSharedMemoryPool;
}

export interface WorkerThreadsBuiltinOptions extends WorkerThreadsBuiltinContext {
  readonly threads: ThreadExecutionPort;
}

export interface WorkerThreadsBuiltin {
  readonly Worker: new (entry: string | URL, options?: WorkerOptions) => WorkerThread;
  readonly BroadcastChannel: typeof globalThis.BroadcastChannel;
  readonly MessageChannel: new () => MessageChannel;
  readonly MessagePort: typeof MessagePort;
  readonly isMainThread: boolean;
  readonly parentPort: MessagePort | null;
  readonly workerData: unknown;
  readonly threadId: number;
  readonly SHARE_ENV: symbol;
  receiveMessageOnPort(port: MessagePort): { readonly message: unknown } | undefined;
  markAsUntransferable(value: unknown): void;
  moveMessagePortToContext(port: MessagePort): MessagePort;
}

const RESOURCE_LIMITS = ['maxYoungGenerationSizeMb', 'maxOldGenerationSizeMb', 'codeRangeSizeMb', 'stackSizeMb'] as const;

export type WorkerOptions = {
  readonly eval?: boolean;
  readonly workerData?: unknown;
  readonly argv?: readonly string[];
  readonly env?: Readonly<Record<string, unknown>> | symbol;
  readonly execArgv?: readonly string[];
  readonly stdin?: boolean;
  readonly stdout?: boolean;
  readonly stderr?: boolean;
  readonly transferList?: readonly unknown[];
  readonly resourceLimits?: unknown;
  readonly name?: string;
  readonly type?: string;
};


export function installWorkerThreadRuntimeGlobals(runtimeGlobal: typeof globalThis): void {
  const pendingWorkerThreadMessageEvents: MessageEvent<unknown>[] = [];
  let messageHandler: unknown = (event: MessageEvent<unknown>) => {
    pendingWorkerThreadMessageEvents.push(event);
  };
  Object.defineProperty(runtimeGlobal, 'onmessage', {
    configurable: true,
    enumerable: true,
    get: () => messageHandler,
    set: (handler: unknown) => {
      messageHandler = handler;
      if (typeof handler !== 'function') return;
      for (const event of pendingWorkerThreadMessageEvents.splice(0)) {
        Reflect.apply(handler, runtimeGlobal, [event]);
      }
    }
  });
  Object.defineProperty(runtimeGlobal, 'self', {
    configurable: true,
    enumerable: true,
    value: runtimeGlobal,
    writable: true
  });
}

/** The next thread id of the process; every thread of it draws from the same pool. */
export function reserveWorkerThreadId(pool: WorkerThreadSharedMemoryPool): number {
  return Atomics.add(new Int32Array(pool.state), WORKER_THREAD_POOL_NEXT_THREAD_ID, 1) + 1;
}

export function createWorkerThreadSharedArrayBufferConstructor(
  pool: WorkerThreadSharedMemoryPool,
  NativeSharedArrayBuffer = SharedArrayBuffer
): SharedArrayBufferConstructor {
  const RuntimeSharedArrayBuffer = function (
    this: unknown,
    byteLength: number,
    options?: { readonly maxByteLength?: number }
  ): SharedArrayBuffer {
    if (!new.target) {
      throw new TypeError("Constructor SharedArrayBuffer requires 'new'");
    }
    if (byteLength !== WORKER_THREAD_SHARED_SIGNAL_BYTES || options?.maxByteLength !== undefined) {
      return options === undefined
        ? new NativeSharedArrayBuffer(byteLength)
        : Reflect.construct(NativeSharedArrayBuffer, [byteLength, options]);
    }
    const state = new Int32Array(pool.state);
    // Once the pool is spent the signal is an ordinary buffer: it still reaches
    // a thread that listens, by structured clone, but not one that receives
    // synchronously.
    if (Atomics.load(state, WORKER_THREAD_POOL_NEXT_SIGNAL) >= pool.signals.length) {
      return new NativeSharedArrayBuffer(byteLength);
    }
    const index = Atomics.add(state, WORKER_THREAD_POOL_NEXT_SIGNAL, 1);
    return pool.signals[index] ?? new NativeSharedArrayBuffer(byteLength);
  } as unknown as SharedArrayBufferConstructor;
  Object.setPrototypeOf(RuntimeSharedArrayBuffer, NativeSharedArrayBuffer);
  Object.defineProperty(RuntimeSharedArrayBuffer, 'prototype', {
    value: NativeSharedArrayBuffer.prototype
  });
  return RuntimeSharedArrayBuffer;
}

export class WorkerThreadsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'WorkerThreadsError';
    this.code = code;
  }
}

/** What the MessagePorts and Workers of one thread share. */
export type WorkerThreadRealm = {
  readonly ports: WorkerThreadPorts;
  readonly pool: WorkerThreadSharedMemoryPool;
  readonly activity: ProcessExecutionActivityLifecycle | undefined;
  /** The port ends this thread holds, by id. */
  readonly live: Map<string, MessagePort>;
};

type QueuedMessage = { readonly value: unknown; readonly message: WorkerThreadMessage };

export class MessagePort extends EventEmitter {
  readonly #realm: WorkerThreadRealm;
  readonly #id: string;
  #peer: MessagePort | undefined;
  #link: WorkerThreadPortLink | undefined;
  #listening = false;
  #queue: QueuedMessage[] = [];
  #closed = false;
  #deliveryScheduled = false;
  #releaseReference: (() => void) | undefined;

  constructor(realm: WorkerThreadRealm, id: string) {
    super();
    this.#realm = realm;
    this.#id = id;
    realm.live.set(id, this);
  }

  /** @internal Joins two new local ends. */
  static pair(realm: WorkerThreadRealm): [MessagePort, MessagePort] {
    const left = new MessagePort(realm, realm.ports.createId());
    const right = new MessagePort(realm, realm.ports.createId());
    left.#peer = right;
    right.#peer = left;
    return [left, right];
  }

  /** @internal An end the Runtime Host relays. */
  static hosted(realm: WorkerThreadRealm, id: string): MessagePort {
    const port = new MessagePort(realm, id);
    port.#attach();
    return port;
  }

  postMessage(value: unknown, transferList?: readonly unknown[]): void {
    if (this.#closed) return;
    if (transferList?.includes(this)) {
      throw new WorkerThreadsError('ERR_INVALID_ARG_VALUE', 'A MessagePort cannot transfer itself.');
    }
    const peer = this.#peer;
    const projected = projectMessage(this.#realm, value, transferList, !peer);
    if (peer) {
      // Queued at once, so the message moves with the other end if it leaves next; listeners hear it later.
      peer.#accept(structuredClone(projected.message, { transfer: [...projected.transfer] }));
      return;
    }
    this.#link!.post(projected.message, projected.transfer);
  }

  start(): void {
    this.#listen();
    this.#flush();
  }

  close(): void {
    if (this.#closed) return;
    const peer = this.#peer;
    this.#finish(true);
    if (peer) queueMicrotask(() => peer.#peerClosed());
    else this.#link?.close();
  }

  ref(): this {
    if (!this.#closed) this.#releaseReference ??= this.#realm.activity?.acquire();
    return this;
  }

  unref(): this {
    this.#releaseReference?.();
    this.#releaseReference = undefined;
    return this;
  }

  hasRef(): boolean {
    return this.#releaseReference !== undefined;
  }

  /** @internal Takes the next message without dispatching it, as `receiveMessageOnPort` does. */
  receiveMessage(): { readonly message: unknown } | undefined {
    const queued = this.#queue.shift();
    if (queued) return { message: queued.value };
    if (this.#closed || !this.#link) return undefined;
    const message = this.#link.receive();
    return message ? { message: restoreMessage(this.#realm, message) } : undefined;
  }

  /**
   * @internal This end leaves the thread inside a message that does. Its
   * pair is hosted first if both ends were local, and what was queued for it
   * goes along.
   */
  moveAcrossThreads(): void {
    if (this.#closed) {
      throw new WorkerThreadsError('ERR_INVALID_STATE', 'A closed MessagePort cannot be transferred.');
    }
    const peer = this.#peer;
    if (peer) {
      const pending = this.#queue.map((queued) => crossingMessage(this.#realm, queued.message));
      this.#realm.ports.host(peer.#id, this.#id, pending);
      peer.#peer = undefined;
      peer.#attach();
    } else {
      this.#link!.release();
    }
    this.#peer = undefined;
    this.#link = undefined;
    // The end lives on where the message arrives; this object is merely spent.
    this.#finish(false);
  }

  override on(event: string | symbol, listener: (this: unknown, ...args: unknown[]) => void): this {
    super.on(event, listener);
    return this.#listenerAdded(event);
  }

  // `EventEmitter` defines this as the same function as `on`, not as a call to it.
  override addListener(event: string | symbol, listener: (this: unknown, ...args: unknown[]) => void): this {
    super.addListener(event, listener);
    return this.#listenerAdded(event);
  }

  override removeListener(event: string | symbol, listener: (this: unknown, ...args: unknown[]) => void): this {
    super.removeListener(event, listener);
    if (event === 'message') this.#releaseIfIdle();
    return this;
  }

  override off(event: string | symbol, listener: (this: unknown, ...args: unknown[]) => void): this {
    return this.removeListener(event, listener);
  }

  override removeAllListeners(event?: string | symbol): this {
    super.removeAllListeners(event);
    if (event === undefined || event === 'message') this.#releaseIfIdle();
    return this;
  }

  /** A `message` listener starts the port and keeps its thread alive. */
  #listenerAdded(event: string | symbol): this {
    if (event === 'message') {
      this.#listen();
      this.ref();
      this.#flush();
    }
    return this;
  }

  /** Relays this end through the Runtime Host from now on. */
  #attach(): void {
    this.#link = this.#realm.ports.link(this.#id, {
      message: (message) => this.#accept(message),
      close: () => this.#peerClosed()
    });
    if (this.#listening) this.#link.listen();
  }

  #listen(): void {
    if (this.#listening || this.#closed) return;
    this.#listening = true;
    this.#link?.listen();
  }

  #accept(message: WorkerThreadMessage): void {
    if (this.#closed) return;
    this.#queue.push({ value: restoreMessage(this.#realm, message), message });
    this.#flush();
  }

  #flush(): void {
    if (this.#deliveryScheduled || this.#closed || this.listenerCount('message') === 0 || this.#queue.length === 0) {
      return;
    }
    this.#deliveryScheduled = true;
    queueMicrotask(() => {
      this.#deliveryScheduled = false;
      while (!this.#closed && this.listenerCount('message') > 0) {
        const queued = this.#queue.shift();
        if (!queued) break;
        try {
          this.emit('message', queued.value);
        } catch (error) {
          if (!isNodeExitSignal(error)) throw error;
        }
      }
      this.#releaseIfIdle();
    });
  }

  #releaseIfIdle(): void {
    if (this.listenerCount('message') > 0) return;
    if (this.#listening) {
      this.#listening = false;
      this.#link?.unlisten();
    }
    this.unref();
  }

  /** What the other end posted before it closed can still be received synchronously. */
  #peerClosed(): void {
    if (this.#closed) return;
    this.#link?.release();
    const queued = this.#queue;
    this.#finish(true);
    this.#queue = queued;
  }

  #finish(emitClose: boolean): void {
    this.#closed = true;
    this.#listening = false;
    this.#queue = [];
    if (this.#realm.live.get(this.#id) === this) this.#realm.live.delete(this.#id);
    this.unref();
    if (emitClose) queueMicrotask(() => this.emit('close'));
  }

  /** @internal */
  get id(): string {
    return this.#id;
  }
}

export class MessageChannel {
  readonly port1: MessagePort;
  readonly port2: MessagePort;

  constructor(realm: WorkerThreadRealm) {
    [this.port1, this.port2] = MessagePort.pair(realm);
  }
}

export class WorkerThread extends EventEmitter {
  readonly stdin = null;
  /** The thread's output when the `stdout` option asked for it; otherwise it goes to the process's own. */
  readonly stdout: NodeReadableStream | null;
  readonly stderr: NodeReadableStream | null;
  readonly threadId: number;
  /**
   * The limits the thread was started with. A browser worker's heap and stack
   * cannot be bounded, so they are reported as asked and not enforced; Metro's
   * transform workers (through jest-worker) ask for them.
   */
  readonly resourceLimits: Readonly<Partial<Record<(typeof RESOURCE_LIMITS)[number], number>>>;
  #exited = false;
  #lease: ThreadExecutionLease;
  #link: WorkerThreadPortLink;
  readonly #realm: WorkerThreadRealm;
  #messageQueue: unknown[] = [];
  #messageDeliveryScheduled = false;

  constructor(
    entry: string | URL,
    options: WorkerOptions | undefined,
    builtin: WorkerThreadsBuiltinOptions,
    realm: WorkerThreadRealm
  ) {
    assertSupportedWorkerOptions(options);
    const resolvedEntry = resolveWorkerEntry(entry, options?.eval === true);
    const workerData = projectMessage(realm, options?.workerData, options?.transferList, true);
    super();
    this.#realm = realm;
    this.stdout = options?.stdout ? new nodeStream.Readable({ read() {} }) : null;
    this.stderr = options?.stderr ? new nodeStream.Readable({ read() {} }) : null;
    const { stdout, stderr } = this;
    const identity = {
      pid: builtin.current.identity.pid,
      threadId: reserveWorkerThreadId(builtin.sharedMemoryPool)
    };
    this.threadId = identity.threadId;
    this.resourceLimits = Object.fromEntries(
      RESOURCE_LIMITS.flatMap((name) => {
        const value = (options?.resourceLimits as Record<string, unknown> | undefined)?.[name];
        return typeof value === 'number' ? [[name, value]] : [];
      })
    );
    // The pair is hosted before the thread starts, so messages posted now wait for it.
    const workerEnd = realm.ports.createId();
    const parentPort = realm.ports.createId();
    realm.ports.host(workerEnd, parentPort, []);
    this.#link = realm.ports.link(workerEnd, {
      message: (message) => this.deliver(restoreMessage(realm, message)),
      close: () => undefined
    });
    this.#link.listen();
    this.#lease = builtin.threads.start({
      entry: resolvedEntry,
      identity,
      parent: builtin.current.identity,
      workerData: workerData.message,
      transfer: workerData.transfer,
      parentPort,
      cwd: builtin.cwd,
      env: resolveWorkerEnvironment(builtin.env, options?.env),
      argv: resolveWorkerArgv(options?.argv),
      execArgv: resolveWorkerExecArgv(options?.execArgv),
      output: {
        ...(stdout && { stdout: (chunk: Uint8Array) => void stdout.push(BrowserBuffer.from(chunk)) }),
        ...(stderr && { stderr: (chunk: Uint8Array) => void stderr.push(BrowserBuffer.from(chunk)) })
      },
      reportFailure: (reason) => this.fail(reason),
      reportExit: (code) => this.finish(code)
    });
  }

  postMessage(value: unknown, transferList?: readonly unknown[]): void {
    if (this.#exited) return;
    const projected = projectMessage(this.#realm, value, transferList, true);
    this.#link.post(projected.message, projected.transfer);
  }

  async terminate(): Promise<number> {
    const code = await this.#lease.terminate();
    this.finish(code);
    return code;
  }

  ref(): this {
    this.#lease.ref();
    return this;
  }

  unref(): this {
    this.#lease.unref();
    return this;
  }

  override on(event: string | symbol, listener: (this: unknown, ...args: unknown[]) => void): this {
    super.on(event, listener);
    if (event === 'message') this.flushMessages();
    return this;
  }

  private finish(code: number, error?: Error): void {
    if (this.#exited) return;
    this.#exited = true;
    queueMicrotask(() => {
      this.flushMessages();
      queueMicrotask(() => {
        this.#messageQueue = [];
        this.#link.close();
        this.stdout?.push(null);
        this.stderr?.push(null);
        if (error) this.emit('error', error);
        this.emit('exit', code);
      });
    });
  }

  private deliver(value: unknown): void {
    if (this.#exited) return;
    this.#messageQueue.push(value);
    this.flushMessages();
  }

  private flushMessages(): void {
    if (this.#messageDeliveryScheduled || this.listenerCount('message') === 0 || this.#messageQueue.length === 0) {
      return;
    }
    this.#messageDeliveryScheduled = true;
    queueMicrotask(() => {
      this.#messageDeliveryScheduled = false;
      while (this.listenerCount('message') > 0 && this.#messageQueue.length > 0) {
        this.emit('message', this.#messageQueue.shift());
      }
    });
  }

  private fail(reason: unknown): void {
    this.finish(1, normalizeError(reason));
  }
}

export function createWorkerThreadsBuiltin(options: WorkerThreadsBuiltinOptions): WorkerThreadsBuiltin {
  const realm: WorkerThreadRealm = {
    ports: options.ports,
    pool: options.sharedMemoryPool,
    activity: options.activity,
    live: new Map()
  };
  const current = options.current;
  const parentPort = current.parentPort === undefined ? null : MessagePort.hosted(realm, current.parentPort);
  const Worker = class extends WorkerThread {
    constructor(entry: string | URL, workerOptions?: WorkerOptions) {
      super(entry, workerOptions, options, realm);
    }
  };
  const RealmMessageChannel = class extends MessageChannel {
    constructor() {
      super(realm);
    }
  };
  return {
    Worker,
    BroadcastChannel: createProcessBroadcastChannel(realm),
    MessageChannel: RealmMessageChannel,
    MessagePort,
    isMainThread: current.identity.threadId === 0,
    parentPort,
    workerData: current.workerData ? restoreMessage(realm, current.workerData) : null,
    threadId: current.identity.threadId,
    SHARE_ENV: Symbol.for('nodejs.worker_threads.SHARE_ENV'),
    receiveMessageOnPort: (port) => port.receiveMessage(),
    markAsUntransferable: () => unsupportedWorkerOperation('markAsUntransferable'),
    moveMessagePortToContext: () => unsupportedWorkerOperation('moveMessagePortToContext')
  };
}

/**
 * `worker_threads.BroadcastChannel`, which reaches the channels of the same name
 * in every thread of the process. The threads of a process are workers of the
 * Runtime Host's origin, so the browser's BroadcastChannel carries the messages;
 * the name it is opened under is scoped by the process's shared memory pool, so
 * no other process and no channel of the runtime hears it. As in Node, a channel
 * keeps its thread alive until it is closed or unreferenced.
 */
function createProcessBroadcastChannel(realm: WorkerThreadRealm): typeof globalThis.BroadcastChannel {
  const NativeBroadcastChannel = globalThis.BroadcastChannel;
  if (typeof NativeBroadcastChannel !== 'function') return UnsupportedBroadcastChannel;
  class BroadcastChannel extends EventTarget {
    readonly name: string;
    onmessage: ((this: BroadcastChannel, event: MessageEvent) => unknown) | null = null;
    onmessageerror: ((this: BroadcastChannel, event: MessageEvent) => unknown) | null = null;
    readonly #channel: globalThis.BroadcastChannel;
    #closed = false;
    #releaseReference: (() => void) | undefined;

    constructor(...args: unknown[]) {
      if (args.length === 0) {
        throw new WorkerThreadsError('ERR_MISSING_ARGS', 'The "name" argument must be specified');
      }
      super();
      this.name = String(args[0]);
      this.#channel = new NativeBroadcastChannel(`node:worker_threads:${realm.pool.id}:${this.name}`);
      this.#channel.onmessage = (event) => this.#dispatch('message', event.data);
      this.#channel.onmessageerror = (event) => this.#dispatch('messageerror', event.data);
      this.ref();
    }

    postMessage(message: unknown): void {
      if (this.#closed) throw new DOMException('BroadcastChannel is closed.', 'InvalidStateError');
      this.#channel.postMessage(message);
    }

    close(): void {
      if (this.#closed) return;
      this.#closed = true;
      this.#channel.close();
      this.unref();
    }

    ref(): this {
      if (!this.#closed) this.#releaseReference ??= realm.activity?.acquire() ?? (() => undefined);
      return this;
    }

    unref(): this {
      this.#releaseReference?.();
      this.#releaseReference = undefined;
      return this;
    }

    #dispatch(type: 'message' | 'messageerror', data: unknown): void {
      if (this.#closed) return;
      const event = new MessageEvent(type, { data });
      const handler = type === 'message' ? this.onmessage : this.onmessageerror;
      if (typeof handler === 'function') Reflect.apply(handler, this, [event]);
      this.dispatchEvent(event);
    }
  }
  return BroadcastChannel as unknown as typeof globalThis.BroadcastChannel;
}

/** Where the context has no BroadcastChannel to carry one. */
class UnsupportedBroadcastChannel extends EventTarget implements globalThis.BroadcastChannel {
  readonly name: string;
  onmessage: ((this: globalThis.BroadcastChannel, event: MessageEvent) => unknown) | null = null;
  onmessageerror: ((this: globalThis.BroadcastChannel, event: MessageEvent) => unknown) | null = null;

  constructor(name: string) {
    super();
    this.name = name;
    throw new WorkerThreadsError('ENOTSUP', 'worker_threads.BroadcastChannel is unavailable without a browser BroadcastChannel.');
  }

  close(): void {
    unsupportedWorkerOperation('BroadcastChannel.close');
  }

  postMessage(_message: unknown): void {
    unsupportedWorkerOperation('BroadcastChannel.postMessage');
  }
}

/**
 * Turns a value into a {@link WorkerThreadMessage}. Its containers are copied,
 * so objects of another realm or behind a proxy travel as plain data;
 * transferred MessagePorts and pooled signals become reference objects; when
 * the message leaves the thread (`crossing`), each transferred port moves with
 * it. Everything else, including the transferables, is left to the structured
 * clone of the channel that carries the message.
 */
function projectMessage(
  realm: WorkerThreadRealm,
  value: unknown,
  transferList: readonly unknown[] | undefined,
  crossing: boolean
): { readonly message: WorkerThreadMessage; readonly transfer: readonly Transferable[] } {
  const transferredPorts = new Set<MessagePort>();
  const transfer: Transferable[] = [];
  for (const item of transferList ?? []) {
    if (item instanceof MessagePort) transferredPorts.add(item);
    else transfer.push(item as Transferable);
  }
  const references: WorkerThreadReference[] = [];
  const projected = new Map<object, WorkerThreadReference>();
  const reference = (item: object): WorkerThreadReference | undefined => {
    const existing = projected.get(item);
    if (existing) return existing;
    let created: WorkerThreadReference | undefined;
    if (item instanceof MessagePort) {
      if (!transferredPorts.has(item)) {
        throw new WorkerThreadsError(
          'ERR_MISSING_MESSAGE_PORT_IN_TRANSFER_LIST',
          'MessagePort was found in the message but not listed in transferList.'
        );
      }
      created = { port: item.id };
    } else {
      const buffer = item instanceof SharedArrayBuffer ? item : ArrayBuffer.isView(item) ? item.buffer : undefined;
      const signal = buffer ? realm.pool.signals.indexOf(buffer as SharedArrayBuffer) : -1;
      if (signal < 0) return undefined;
      created = ArrayBuffer.isView(item)
        ? {
            signal,
            view: {
              kind: item.constructor.name,
              byteOffset: item.byteOffset,
              length: item instanceof DataView ? item.byteLength : (item as Int32Array).length
            }
          }
        : { signal };
    }
    projected.set(item, created);
    references.push(created);
    return created;
  };
  const projectedValue = replaceReferences(value, reference);
  for (const port of transferredPorts) {
    if (!projected.has(port)) reference(port);
    if (crossing) port.moveAcrossThreads();
  }
  return { message: { value: projectedValue, references }, transfer };
}

/**
 * Restores a received message: each reference object becomes the port end
 * this thread now holds, or the pooled signal it names. The received value is
 * this thread's own copy, so it is restored in place.
 */
function restoreMessage(realm: WorkerThreadRealm, message: WorkerThreadMessage): unknown {
  if (message.references.length === 0) return message.value;
  const restored = new Map<object, unknown>();
  for (const reference of message.references) {
    if ('port' in reference) {
      restored.set(reference, realm.live.get(reference.port) ?? MessagePort.hosted(realm, reference.port));
      continue;
    }
    const buffer = realm.pool.signals[reference.signal];
    if (!buffer) {
      throw new WorkerThreadsError(
        'ERR_WORKER_MISSING_SHARED_MEMORY',
        `Worker thread shared signal ${reference.signal} is unavailable.`
      );
    }
    restored.set(reference, reference.view ? signalView(buffer, reference.view) : buffer);
  }
  return restoreReferences(message.value, restored);
}

/** A message queued for a port that now leaves the thread, with its own local ports moving along. */
function crossingMessage(realm: WorkerThreadRealm, message: WorkerThreadMessage): WorkerThreadMessage {
  for (const reference of message.references) {
    if ('port' in reference) realm.live.get(reference.port)?.moveAcrossThreads();
  }
  return message;
}

const signalViewKinds: Readonly<Record<string, new (buffer: SharedArrayBuffer, byteOffset: number, length: number) => ArrayBufferView>> = {
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  DataView
};

function signalView(
  buffer: SharedArrayBuffer,
  view: Readonly<{ kind: string; byteOffset: number; length: number }>
): ArrayBufferView {
  const constructor = signalViewKinds[view.kind];
  if (!constructor) {
    throw new WorkerThreadsError('ERR_WORKER_UNSUPPORTED_SHARED_MEMORY', `${view.kind} cannot view a shared signal.`);
  }
  return new constructor(buffer, view.byteOffset, view.length);
}

/** Copies the containers of `value`, replacing each object `reference` names. */
function replaceReferences(
  value: unknown,
  reference: (item: object) => WorkerThreadReference | undefined,
  seen = new Map<object, unknown>()
): unknown {
  if (value === null || typeof value !== 'object') return value;
  const replaced = value instanceof MessagePort || isSharedMemory(value) ? reference(value) : undefined;
  if (replaced) return replaced;
  if (isOpaqueWorkerThreadMessageValue(value)) return value;
  const existing = seen.get(value);
  if (existing !== undefined) return existing;
  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(value, copy);
    for (const entry of value) copy.push(replaceReferences(entry, reference, seen));
    return copy;
  }
  if (isMap(value)) {
    const copy = new Map<unknown, unknown>();
    seen.set(value, copy);
    for (const [key, entry] of value) {
      copy.set(replaceReferences(key, reference, seen), replaceReferences(entry, reference, seen));
    }
    return copy;
  }
  if (isSet(value)) {
    const copy = new Set<unknown>();
    seen.set(value, copy);
    for (const entry of value) copy.add(replaceReferences(entry, reference, seen));
    return copy;
  }
  const copy: Record<string, unknown> = {};
  seen.set(value, copy);
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = replaceReferences(entry, reference, seen);
  }
  return copy;
}

/** Replaces, in place, every reference object of a received value with what it restores to. */
function restoreReferences(
  value: unknown,
  restored: ReadonlyMap<object, unknown>,
  seen = new Set<object>()
): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (restored.has(value)) return restored.get(value);
  if (isOpaqueWorkerThreadMessageValue(value) || seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = restoreReferences(value[index], restored, seen);
    }
    return value;
  }
  if (value instanceof Map) {
    for (const [key, entry] of [...value]) {
      const restoredKey = restoreReferences(key, restored, seen);
      if (restoredKey !== key) value.delete(key);
      value.set(restoredKey, restoreReferences(entry, restored, seen));
    }
    return value;
  }
  if (value instanceof Set) {
    for (const entry of [...value]) {
      const restoredEntry = restoreReferences(entry, restored, seen);
      if (restoredEntry === entry) continue;
      value.delete(entry);
      value.add(restoredEntry);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    const record = value as Record<string, unknown>;
    record[key] = restoreReferences(record[key], restored, seen);
  }
  return value;
}

function isSharedMemory(value: object): boolean {
  return (
    value instanceof SharedArrayBuffer ||
    (ArrayBuffer.isView(value) && value.buffer instanceof SharedArrayBuffer)
  );
}

function isMap(value: unknown): value is Map<unknown, unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    Reflect.apply(Map.prototype.has, value, [value]);
    return true;
  } catch {
    return hasForeignCollectionBrand(value, 'Map');
  }
}

function isSet(value: unknown): value is Set<unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    Reflect.apply(Set.prototype.has, value, [value]);
    return true;
  } catch {
    return hasForeignCollectionBrand(value, 'Set');
  }
}

function hasForeignCollectionBrand(value: object, name: 'Map' | 'Set'): boolean {
  const constructor = Reflect.get(value, 'constructor');
  if (
    Object.prototype.toString.call(value) === `[object ${name}]` &&
    typeof constructor === 'function' &&
    constructor.name === name &&
    Reflect.apply(Function.prototype[Symbol.hasInstance], constructor, [value])
  ) {
    try {
      if (typeof Reflect.get(value, Symbol.iterator) !== 'function') return false;
      const entries = Array.from(value as Iterable<unknown>);
      return name === 'Set' || entries.every((entry) => Array.isArray(entry));
    } catch {
      return false;
    }
  }
  return false;
}

function isOpaqueWorkerThreadMessageValue(value: object): boolean {
  return (
    value instanceof ArrayBuffer ||
    value instanceof SharedArrayBuffer ||
    ArrayBuffer.isView(value) ||
    value instanceof Date ||
    value instanceof RegExp ||
    value instanceof Error ||
    value instanceof WebAssembly.Module ||
    value instanceof WebAssembly.Memory
  );
}

function unsupportedWorkerOperation(operation: string): never {
  throw new WorkerThreadsError(
    'ERR_WORKER_UNSUPPORTED_OPERATION',
    `worker_threads.${operation}() is not supported by Mimic yet.`
  );
}

function resolveWorkerEntry(entry: string | URL, evaluate: boolean): ThreadEntry {
  if (evaluate) {
    if (typeof entry !== 'string') {
      throw new WorkerThreadsError(
        'ERR_INVALID_ARG_VALUE',
        'The property "options.eval" must be false when "filename" is not a string.'
      );
    }
    return Object.freeze({ kind: 'inline-source', source: entry });
  }
  if (typeof entry !== 'string' && !(entry instanceof URL)) {
    throw new WorkerThreadsError(
      'ERR_INVALID_ARG_TYPE',
      'The "filename" argument must be of type string or an instance of URL.'
    );
  }
  const text = typeof entry === 'string' ? entry : entry.href;
  if (text.startsWith('/') || text.startsWith('./') || text.startsWith('../') || text.startsWith('file:')) {
    return Object.freeze({ kind: 'module', specifier: text });
  }
  throw new WorkerThreadsError(
    'ERR_WORKER_PATH',
    `The worker script filename must be an absolute path or a relative path starting with './' or '../'. Received "${text}"`
  );
}

function assertSupportedWorkerOptions(options: WorkerOptions | undefined): void {
  if (!options) return;
  if (options.argv !== undefined && !isStringArray(options.argv)) {
    throw new WorkerThreadsError('ERR_INVALID_ARG_TYPE', 'Worker option "argv" must be an array of strings.');
  }
  resolveWorkerExecArgv(options.execArgv);
  if (
    options.env !== undefined &&
    options.env !== Symbol.for('nodejs.worker_threads.SHARE_ENV') &&
    (options.env === null || typeof options.env !== 'object')
  ) {
    throw new WorkerThreadsError('ERR_INVALID_ARG_TYPE', 'Worker option "env" must be an object or SHARE_ENV.');
  }
  // `name` only labels the thread in diagnostics, which the runtime has none of.
  if (options.name !== undefined && typeof options.name !== 'string') {
    throw new WorkerThreadsError('ERR_INVALID_ARG_TYPE', 'Worker option "name" must be a string.');
  }
  if (options.resourceLimits !== undefined && (options.resourceLimits === null || typeof options.resourceLimits !== 'object')) {
    throw new WorkerThreadsError('ERR_INVALID_ARG_TYPE', 'Worker option "resourceLimits" must be an object.');
  }
  const unsupported = ['stdin', 'type'] as const;
  const name = unsupported.find((candidate) => options[candidate] !== undefined);
  if (name) {
    throw new WorkerThreadsError(
      'ERR_WORKER_UNSUPPORTED_OPTION',
      `Worker option "${name}" is not supported by Mimic yet.`
    );
  }
}

function resolveWorkerEnvironment(
  inherited: Readonly<Record<string, string>>,
  supplied: Readonly<Record<string, unknown>> | symbol | undefined
): Readonly<Record<string, string>> {
  if (typeof supplied === 'symbol') return inherited;
  if (!supplied) return { ...inherited };
  // Each value becomes a string, as an assignment to `process.env` makes it:
  // jest-worker passes `{ ...process.env, FORCE_COLOR: undefined }`.
  return Object.fromEntries(Object.entries(supplied).map(([name, value]) => [name, String(value)]));
}

function resolveWorkerArgv(argv: readonly string[] | undefined): readonly string[] {
  return argv ? [...argv] : [];
}

// Flags Node accepts for a worker that change nothing here: `import.meta.resolve`
// is always present, warnings are not printed, and WASI needs no flag (the
// NAPI-RS WASI loader still passes the one Node 20 required to its workers).
const SUPPORTED_WORKER_EXEC_ARGV: ReadonlySet<string> = new Set([
  '--unhandled-rejections=strict',
  '--experimental-import-meta-resolve',
  '--experimental-wasi-unstable-preview1',
  '--no-warnings',
  '--no-deprecation'
]);

function resolveWorkerExecArgv(execArgv: readonly string[] | undefined): readonly string[] {
  if (execArgv === undefined) return [];
  if (!isStringArray(execArgv)) {
    throw new WorkerThreadsError('ERR_INVALID_ARG_TYPE', 'Worker option "execArgv" must be an array of strings.');
  }
  const unsupported = execArgv.find((argument) => !SUPPORTED_WORKER_EXEC_ARGV.has(argument));
  if (unsupported !== undefined) {
    throw new WorkerThreadsError(
      'ERR_WORKER_INVALID_EXEC_ARGV',
      `Initiated Worker with invalid execArgv flags: ${unsupported}`
    );
  }
  return [...execArgv];
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

// Node Compatibility may not import Worker Transport, so this keeps its own
// copy, which also maps a Process Execution code to a `worker_threads` error.
function normalizeError(reason: unknown): Error {
  const code =
    reason && typeof reason === 'object' && 'code' in reason && typeof reason.code === 'string'
      ? nodeErrorCodeFromDomain('process-execution', reason.code)
      : undefined;
  if (code) {
    return new WorkerThreadsError(code, reason instanceof Error ? reason.message : String(reason));
  }
  return reason instanceof Error ? reason : new Error(String(reason));
}

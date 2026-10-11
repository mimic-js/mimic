/**
 * The synchronous counterpart of `connectRpc`: one way for a worker to block
 * until another context answers. A channel is one SharedArrayBuffer with a
 * fixed control header, a few status words the two sides may publish to each
 * other, and a payload window through which every message is copied in
 * chunks. The caller drives an interface shared with the callee through a
 * proxy whose methods return their result directly; the callee serves it
 * from its event loop with `Atomics.waitAsync`, so it may answer
 * asynchronously. Values cross in the one binary encoding of `value-codec`.
 *
 * The watchdog bounds only how long the callee takes to pick up a chunk;
 * once it holds a complete request, the call lasts as long as its work.
 */
import {
  decodeValue,
  encodeValue,
  type EncodedValue,
  type ValueDecodingOptions,
  type ValueEncodingOptions
} from './value-codec';
import { queueMacrotask } from './macrotask';
import { reviveError, serializeError, type SerializedError } from './rpc';

export interface SynchronousChannel {
  readonly buffer: SharedArrayBuffer;
  /** Bytes copied per chunk. */
  readonly capacity: number;
  /** The largest request the caller may send or successful response the callee may return. */
  readonly maxMessageBytes: number;
  /**
   * How long the caller waits for the callee to pick up a chunk before failing
   * the call; Infinity waits for as long as the callee lives.
   */
  readonly watchdogMs: number;
  /** Status words either side may publish without a call. */
  readonly words: number;
}

export interface SynchronousChannelOptions {
  readonly capacity?: number;
  readonly maxMessageBytes?: number;
  readonly watchdogMs?: number;
  readonly words?: number;
}

/** The caller's view of an interface: every method returns its result directly. */
export type SynchronousRemote<Api> = {
  readonly [Key in keyof Api]: Api[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Awaited<Result>
    : SynchronousRemote<Api[Key]>;
};

export interface SynchronousRpcDiagnostics {
  readonly calls: number;
  readonly requestChunks: number;
  readonly responseChunks: number;
}

export interface SynchronousRpcConnection<Api> {
  readonly remote: SynchronousRemote<Api>;
  readonly diagnostics: SynchronousRpcDiagnostics;
}

export interface SynchronousRpcServer {
  /** Ends the channel; a blocked or later call fails with SYNCHRONOUS_RPC_CLOSED. */
  close(): void;
  /** Ends the channel because its owner failed; calls fail with SYNCHRONOUS_RPC_FAILED. */
  fail(): void;
}

export type SynchronousRpcErrorCode =
  | 'SYNCHRONOUS_RPC_CLOSED'
  | 'SYNCHRONOUS_RPC_FAILED'
  | 'SYNCHRONOUS_RPC_TIMEOUT'
  | 'SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE';

export class SynchronousRpcError extends Error {
  readonly code: SynchronousRpcErrorCode;

  constructor(code: SynchronousRpcErrorCode, message: string) {
    super(message);
    this.name = 'SynchronousRpcError';
    this.code = code;
  }
}

const STATE = 0;
const CHUNK_LENGTH = 1;
const CHUNK_FINAL = 2;
const MESSAGE_LENGTH = 3;
const TERMINAL_REASON = 4;
const HEADER_INTS = 5;

const State = {
  idle: 0,
  /** The caller wrote a request chunk. */
  request: 1,
  /** The callee copied a request chunk that was not the last. */
  requestTaken: 2,
  /** The callee holds the whole request and is working on it. */
  processing: 3,
  /** The callee wrote a response chunk. */
  response: 4,
  /** The caller copied a response chunk that was not the last. */
  responseTaken: 5,
  /** The caller gave up waiting for a pickup; the callee discards the exchange. */
  timedOut: 6,
  terminal: 7
} as const;

const Terminal = { closed: 1, failed: 2 } as const;

const DEFAULT_CAPACITY = 64 * 1024;
const DEFAULT_MAX_MESSAGE_BYTES = 256 * 1024 * 1024;
const DEFAULT_WATCHDOG_MS = 5_000;
/**
 * The callee allocates a request buffer of at most this size (or one payload
 * window) before any byte has arrived, and grows it as chunks come in: the
 * announced length is the caller's word, which may be a lie.
 */
const INITIAL_REQUEST_BYTES = 64 * 1024;
/**
 * How many control-header transitions the callee handles back to back before
 * yielding a task, so a caller that keeps the header busy cannot starve the
 * callee's other work.
 */
const TRANSITIONS_PER_TASK = 64;

export function createSynchronousChannel(options: SynchronousChannelOptions = {}): SynchronousChannel {
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const capacity = options.capacity ?? Math.min(DEFAULT_CAPACITY, maxMessageBytes);
  const watchdogMs = options.watchdogMs ?? DEFAULT_WATCHDOG_MS;
  const words = options.words ?? 0;
  if (!Number.isInteger(capacity) || capacity < 32 || capacity > maxMessageBytes) {
    throw new RangeError('A synchronous channel capacity must be an integer between 32 and its maximum message size.');
  }
  if (Number.isNaN(watchdogMs) || watchdogMs <= 0) {
    throw new RangeError('A synchronous channel watchdog must be a positive duration.');
  }
  if (!Number.isInteger(words) || words < 0) {
    throw new RangeError('A synchronous channel has a non-negative whole number of status words.');
  }
  const buffer = new SharedArrayBuffer((HEADER_INTS + words) * Int32Array.BYTES_PER_ELEMENT + capacity);
  return { buffer, capacity, maxMessageBytes, watchdogMs, words };
}

/** The channel's status words, shared by both sides. */
export function synchronousChannelWords(channel: SynchronousChannel): Int32Array {
  return new Int32Array(channel.buffer, HEADER_INTS * Int32Array.BYTES_PER_ELEMENT, channel.words);
}

/** Ends a channel from a context that does not serve it, waking a blocked caller. */
export function failSynchronousChannel(channel: SynchronousChannel): void {
  terminate(control(channel), Terminal.failed);
}

export function connectSynchronousRpc<Api>(
  channel: SynchronousChannel,
  options: ValueEncodingOptions & ValueDecodingOptions = {}
): SynchronousRpcConnection<Api> {
  const controlWords = control(channel);
  const payload = payloadWindow(channel);
  let calls = 0;
  let requestChunks = 0;
  let responseChunks = 0;

  const failure = (): SynchronousRpcError =>
    Atomics.load(controlWords, TERMINAL_REASON) === Terminal.failed
      ? new SynchronousRpcError('SYNCHRONOUS_RPC_FAILED', 'The synchronous channel failed with its owner.')
      : new SynchronousRpcError('SYNCHRONOUS_RPC_CLOSED', 'The synchronous channel is closed.');
  const timeout = (): SynchronousRpcError =>
    new SynchronousRpcError(
      'SYNCHRONOUS_RPC_TIMEOUT',
      `The synchronous channel was not serviced within ${channel.watchdogMs} ms.`
    );

  /** Waits while the state is `expected`, giving up after the watchdog when `bounded`. */
  const waitWhile = (expected: number, bounded: boolean): number => {
    const deadline = performance.now() + channel.watchdogMs;
    while (true) {
      const actual = Atomics.load(controlWords, STATE);
      if (actual !== expected) {
        if (actual === State.terminal) throw failure();
        return actual;
      }
      if (!bounded) {
        Atomics.wait(controlWords, STATE, expected);
        continue;
      }
      const remaining = deadline - performance.now();
      if (remaining > 0 && Atomics.wait(controlWords, STATE, expected, remaining) !== 'timed-out') continue;
      if (Atomics.compareExchange(controlWords, STATE, expected, State.timedOut) !== expected) continue;
      Atomics.notify(controlWords, STATE);
      throw timeout();
    }
  };

  const publish = (state: number): void => {
    Atomics.store(controlWords, STATE, state);
    Atomics.notify(controlWords, STATE);
  };

  const call = (path: readonly string[], args: readonly unknown[]): unknown => {
    const frame = encodeValue([path, args], options);
    if (frame.byteLength > channel.maxMessageBytes) {
      throw new SynchronousRpcError(
        'SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE',
        `The synchronous request of ${frame.byteLength} bytes exceeds its channel limit of ${channel.maxMessageBytes}.`
      );
    }
    // A call that timed out leaves the channel marked until the callee
    // discards that exchange; this call waits for it to catch up.
    if (waitWhile(State.timedOut, true) !== State.idle) {
      throw new Error('The synchronous channel is already in use.');
    }
    calls += 1;
    const outgoing = new FrameCursor(frame);
    let state: number;
    do {
      const length = outgoing.next(payload);
      Atomics.store(controlWords, CHUNK_LENGTH, length);
      Atomics.store(controlWords, CHUNK_FINAL, outgoing.done ? 1 : 0);
      if (outgoing.isFirst) Atomics.store(controlWords, MESSAGE_LENGTH, frame.byteLength);
      publish(State.request);
      requestChunks += 1;
      state = waitWhile(State.request, true);
      // The callee may answer before the last chunk when it rejects the request outright.
    } while (state === State.requestTaken && !outgoing.done);

    let response: Uint8Array | undefined;
    let received = 0;
    while (true) {
      if (state === State.processing) state = waitWhile(State.processing, false);
      if (state !== State.response) throw new Error(`The synchronous channel is in state ${state}; expected a response.`);
      const length = Atomics.load(controlWords, CHUNK_LENGTH);
      response ??= new Uint8Array(Atomics.load(controlWords, MESSAGE_LENGTH));
      response.set(payload.subarray(0, length), received);
      received += length;
      responseChunks += 1;
      if (Atomics.load(controlWords, CHUNK_FINAL) === 1) {
        publish(State.idle);
        break;
      }
      publish(State.responseTaken);
      state = waitWhile(State.responseTaken, true);
    }
    const [status, value] = decodeValue(response, options) as [number, unknown];
    if (status === 0) return value;
    throw reviveError(value as SerializedError);
  };

  const proxies = new Map<string, unknown>();
  const proxy = (path: readonly string[]): unknown => {
    const key = path.join('\u0000');
    const cached = proxies.get(key);
    if (cached) return cached;
    const created = new Proxy(() => undefined, {
      get: (_target, property) =>
        typeof property === 'symbol' || property === 'then' ? undefined : proxy([...path, property]),
      apply: (_target, _receiver, args: unknown[]) => call(path, args)
    });
    proxies.set(key, created);
    return created;
  };

  return {
    remote: proxy([]) as SynchronousRemote<Api>,
    get diagnostics() {
      return { calls, requestChunks, responseChunks };
    }
  };
}

export function serveSynchronousRpc(
  channel: SynchronousChannel,
  implementation: object,
  options: ValueEncodingOptions & ValueDecodingOptions = {}
): SynchronousRpcServer {
  const controlWords = control(channel);
  const payload = payloadWindow(channel);
  let request: Uint8Array | undefined;
  /** The length the caller announced for the request being received. */
  let announced = 0;
  let received = 0;
  let response: FrameCursor | undefined;
  // Each exchange has a number so that an answer for one the caller abandoned is dropped.
  let exchange = 0;
  let stopped = false;

  const transition = (expected: number, next: number): boolean => {
    if (Atomics.compareExchange(controlWords, STATE, expected, next) !== expected) return false;
    Atomics.notify(controlWords, STATE);
    return true;
  };

  const reset = (): void => {
    request = undefined;
    announced = 0;
    received = 0;
    response = undefined;
    exchange += 1;
  };

  const writeChunk = (expected: number): void => {
    const cursor = response!;
    const length = cursor.next(payload);
    Atomics.store(controlWords, CHUNK_LENGTH, length);
    Atomics.store(controlWords, CHUNK_FINAL, cursor.done ? 1 : 0);
    if (cursor.isFirst) Atomics.store(controlWords, MESSAGE_LENGTH, cursor.byteLength);
    if (cursor.done) response = undefined;
    // The caller may have abandoned the exchange while this chunk was pending.
    if (!transition(expected, State.response)) reset();
  };

  const respond = (status: 0 | 1, value: unknown): void => {
    let frame: EncodedValue;
    try {
      frame = encodeValue([status, status === 0 ? value : serializeError(value)], options);
    } catch (error) {
      frame = encodeValue([1, serializeError(error)]);
    }
    if (status === 0 && frame.byteLength > channel.maxMessageBytes) {
      frame = encodeValue([
        1,
        serializeError(
          new SynchronousRpcError(
            'SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE',
            `The synchronous response of ${frame.byteLength} bytes exceeds its channel limit of ${channel.maxMessageBytes}.`
          )
        )
      ]);
    }
    response = new FrameCursor(frame);
    writeChunk(State.processing);
  };

  const invoke = (bytes: Uint8Array): void => {
    const current = exchange;
    let result: unknown;
    try {
      const [path, args] = decodeValue(bytes, options) as [string[], unknown[]];
      const resolved = resolveMethod(implementation, path);
      result = resolved.method.apply(resolved.receiver, args);
    } catch (error) {
      respond(1, error);
      return;
    }
    if (!isThenable(result)) {
      respond(0, result);
      return;
    }
    result.then(
      (value) => {
        if (!stopped && current === exchange) respond(0, value);
      },
      (error: unknown) => {
        if (!stopped && current === exchange) respond(1, error);
      }
    );
  };

  /** Rejects the request outright: the caller stops sending and reads this answer. */
  const rejectRequest = (error: Error): void => {
    request = undefined;
    announced = 0;
    received = 0;
    if (!transition(State.request, State.processing)) return;
    respond(1, error);
  };

  const takeRequestChunk = (): void => {
    const length = Atomics.load(controlWords, CHUNK_LENGTH);
    const final = Atomics.load(controlWords, CHUNK_FINAL) === 1;
    if (!request) {
      const messageLength = Atomics.load(controlWords, MESSAGE_LENGTH);
      if (messageLength > channel.maxMessageBytes) {
        rejectRequest(
          new SynchronousRpcError(
            'SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE',
            `The synchronous request of ${messageLength} bytes exceeds its channel limit of ${channel.maxMessageBytes}.`
          )
        );
        return;
      }
      if (messageLength < 0) {
        rejectRequest(new RangeError(`The synchronous request announced a length of ${messageLength} bytes.`));
        return;
      }
      announced = messageLength;
      request = new Uint8Array(Math.min(messageLength, Math.max(channel.capacity, INITIAL_REQUEST_BYTES)));
      received = 0;
    }
    if (length < 0 || length > payload.byteLength || received + length > announced) {
      rejectRequest(
        new RangeError(
          `The synchronous request chunk of ${length} bytes does not fit its announced length of ${announced}.`
        )
      );
      return;
    }
    if (final && received + length !== announced) {
      rejectRequest(
        new RangeError(
          `The synchronous request ended after ${received + length} of its announced ${announced} bytes.`
        )
      );
      return;
    }
    if (received + length > request.byteLength) {
      const grown = new Uint8Array(Math.min(announced, Math.max(request.byteLength * 2, received + length)));
      grown.set(request.subarray(0, received));
      request = grown;
    }
    request.set(payload.subarray(0, length), received);
    received += length;
    if (!transition(State.request, final ? State.processing : State.requestTaken)) {
      reset();
      return;
    }
    if (!final) return;
    const complete = request.byteLength === received ? request : request.slice(0, received);
    request = undefined;
    announced = 0;
    received = 0;
    invoke(complete);
  };

  const serve = async (): Promise<void> => {
    // Transitions handled since this loop last gave up its task. The caller
    // holds the shared header and may keep it busy forever; the callee serves
    // other channels and its own work in between.
    let transitions = 0;
    while (!stopped) {
      const state = Atomics.load(controlWords, STATE);
      switch (state) {
        case State.request:
          takeRequestChunk();
          break;
        case State.responseTaken:
          if (response) writeChunk(State.responseTaken);
          else transition(State.responseTaken, State.idle);
          break;
        case State.timedOut:
          reset();
          transition(State.timedOut, State.idle);
          break;
        case State.terminal:
          stopped = true;
          return;
        default:
          transitions = 0;
          await waitForChange(controlWords, state);
          continue;
      }
      if (++transitions >= TRANSITIONS_PER_TASK) {
        transitions = 0;
        await yieldTask();
      }
    }
  };

  const stop = (reason: number): void => {
    if (stopped) return;
    stopped = true;
    reset();
    terminate(controlWords, reason);
  };
  // A defect while serving fails the channel rather than leaving its caller blocked.
  serve().catch(() => stop(Terminal.failed));
  return {
    close: () => stop(Terminal.closed),
    fail: () => stop(Terminal.failed)
  };
}

function control(channel: SynchronousChannel): Int32Array {
  return new Int32Array(channel.buffer, 0, HEADER_INTS);
}

function payloadWindow(channel: SynchronousChannel): Uint8Array {
  return new Uint8Array(
    channel.buffer,
    (HEADER_INTS + channel.words) * Int32Array.BYTES_PER_ELEMENT,
    channel.capacity
  );
}

function terminate(controlWords: Int32Array, reason: number): void {
  if (Atomics.load(controlWords, STATE) === State.terminal) return;
  Atomics.store(controlWords, TERMINAL_REASON, reason);
  Atomics.store(controlWords, STATE, State.terminal);
  Atomics.notify(controlWords, STATE);
}

type WaitAsync = (
  array: Int32Array,
  index: number,
  value: number
) => { readonly async: boolean; readonly value: Promise<string> | string };

function yieldTask(): Promise<void> {
  return new Promise((resolve) => queueMacrotask(resolve));
}

function waitForChange(controlWords: Int32Array, observed: number): Promise<unknown> {
  const waitAsync = Reflect.get(Atomics, 'waitAsync') as WaitAsync | undefined;
  if (typeof waitAsync !== 'function') {
    throw new Error('Serving a synchronous channel requires Atomics.waitAsync.');
  }
  const result = waitAsync(controlWords, STATE, observed);
  return result.async ? (result.value as Promise<string>) : Promise.resolve();
}

/** Copies an encoded frame into fixed-size chunks without first joining its parts. */
class FrameCursor {
  readonly byteLength: number;
  readonly #parts: readonly Uint8Array[];
  #part = 0;
  #offset = 0;
  #remaining: number;
  #chunks = 0;

  constructor(frame: EncodedValue) {
    this.byteLength = frame.byteLength;
    this.#parts = frame.parts;
    this.#remaining = frame.byteLength;
  }

  /** True while the chunk last written is the frame's first. */
  get isFirst(): boolean {
    return this.#chunks === 1;
  }

  get done(): boolean {
    return this.#remaining === 0;
  }

  next(target: Uint8Array): number {
    this.#chunks += 1;
    let written = 0;
    while (written < target.byteLength && this.#remaining > 0) {
      const part = this.#parts[this.#part];
      const available = part.byteLength - this.#offset;
      if (available === 0) {
        this.#part += 1;
        this.#offset = 0;
        continue;
      }
      const length = Math.min(available, target.byteLength - written);
      target.set(part.subarray(this.#offset, this.#offset + length), written);
      this.#offset += length;
      this.#remaining -= length;
      written += length;
    }
    return written;
  }
}

function resolveMethod(
  implementation: object,
  path: readonly string[]
): { readonly receiver: unknown; readonly method: (...args: unknown[]) => unknown } {
  let receiver: unknown;
  let target: unknown = implementation;
  for (const key of path) {
    // Only the served object's own vocabulary is callable, never Object.prototype.
    if (typeof target !== 'object' || target === null || !(key in target) || key in Object.prototype) {
      throw new TypeError(`Synchronous method ${path.join('.')} is not implemented.`);
    }
    receiver = target;
    target = (target as Record<string, unknown>)[key];
  }
  if (typeof target !== 'function') throw new TypeError(`Synchronous method ${path.join('.')} is not implemented.`);
  return { receiver, method: target as (...args: unknown[]) => unknown };
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

import type { EventEmitter } from './events';
import type { WorkerThreadMessage, WorkerThreadPorts } from './worker-threads';

/**
 * The IPC channel of a child process started with `fork()`, or with `'ipc'` in
 * its `stdio`. It is one MessagePort pair of the Runtime Host's port relay:
 * the parent hosts the pair before it spawns the child, and the child's end
 * moves to the child's process worker, which links it before the entry runs.
 * The relay keeps what either side sent, in order, until the other side takes
 * it, and closes one end when the process holding the other one ends.
 *
 * Both sides attach the channel to an event emitter, the parent's
 * `ChildProcess` and the child's `process`, which then have `send()`,
 * `disconnect()`, `connected`, `channel` and the `message` and `disconnect`
 * events of Node.
 */

export type IpcSerialization = 'json' | 'advanced';

/** The child's end of the channel, as its spawn request names it. */
export interface IpcChannelEnd {
  readonly port: string;
  readonly serialization: IpcSerialization;
}

export interface IpcChannelOptions {
  readonly ports: WorkerThreadPorts;
  /** The end of the pair this side holds. */
  readonly port: string;
  readonly serialization: IpcSerialization;
  /** Keeps the process alive while the channel is referenced. */
  readonly activity?: { acquire(): () => void };
  /**
   * The process's own `nextTick`. Every event of the channel is emitted from
   * it, so a listener runs as process code: `process.exit()` in it ends the
   * process, and an error it throws is the process's uncaught exception.
   */
  readonly nextTick: (callback: () => void) => void;
}

/** `process.channel` and `subprocess.channel`. */
export interface IpcChannelHandle {
  ref(): void;
  unref(): void;
  hasRef(): boolean;
}

export interface IpcChannel {
  readonly connected: boolean;
  readonly handle: IpcChannelHandle;
  send(message: unknown, ...rest: readonly unknown[]): boolean;
  disconnect(): void;
  /** The process at the other end is gone; resolves once `disconnect` was emitted. */
  close(): Promise<void>;
}

type IpcWireValue =
  | Readonly<{ kind: 'json'; text: string }>
  | Readonly<{ kind: 'advanced'; value: unknown }>;

class IpcError extends Error {
  constructor(readonly code: string, message: string, name = 'Error') {
    super(message);
    this.name = name;
  }
}

/** The stdio entries of a spawn, without its IPC entry, and whether it asked for one. */
export function splitIpcStdio(stdio: unknown): { readonly stdio: unknown; readonly ipc: boolean } {
  if (!Array.isArray(stdio)) return { stdio, ipc: false };
  const ipcEntries = stdio.filter((entry) => entry === 'ipc').length;
  if (ipcEntries > 1) {
    throw new IpcError('ERR_IPC_ONE_PIPE', 'Child process can have only one IPC pipe');
  }
  if (ipcEntries === 0) return { stdio, ipc: false };
  // A descriptor that is the IPC channel is not also a standard stream.
  const standard = stdio.slice(0, 3).map((entry) => (entry === 'ipc' ? 'ignore' : entry));
  const extra = stdio.slice(3).filter((entry) => entry !== 'ipc' && entry !== 'ignore' && entry != null);
  return { stdio: [...standard, ...extra], ipc: true };
}

export function validateIpcSerialization(value: unknown): IpcSerialization {
  if (value === undefined || value === 'json' || value === 'advanced') return value ?? 'json';
  throw new IpcError(
    'ERR_INVALID_ARG_VALUE',
    `The property 'options.serialization' must be one of: 'json', 'advanced'. Received ${String(value)}`,
    'TypeError'
  );
}

/** Attaches the end `options.port` to `target`. */
export function attachIpcChannel(target: EventEmitter, options: IpcChannelOptions): IpcChannel {
  let connected = true;
  let referenced = true;
  let release: (() => void) | undefined;
  /** Messages that arrived while nothing listened; the first listener receives them. */
  const unheard: unknown[] = [];

  // As in Node, the channel keeps its process alive only while something listens to it.
  const listened = (): boolean =>
    target.listenerCount('message') > 0 || target.listenerCount('disconnect') > 0;
  const updateActivity = (): void => {
    const wanted = connected && referenced && listened();
    if (wanted && !release) release = options.activity?.acquire();
    if (!wanted && release) {
      release();
      release = undefined;
    }
  };
  const deliverUnheard = (): void => {
    while (connected && unheard.length > 0 && target.listenerCount('message') > 0) {
      target.emit('message', unheard.shift(), undefined);
    }
  };

  const finish = (): Promise<void> => {
    if (!connected) return Promise.resolve();
    connected = false;
    unheard.length = 0;
    updateActivity();
    return new Promise((resolve) =>
      options.nextTick(() => {
        try {
          target.emit('disconnect');
        } finally {
          resolve();
        }
      })
    );
  };

  const link = options.ports.link(options.port, {
    message(message: WorkerThreadMessage) {
      const value = decode(message.value as IpcWireValue);
      options.nextTick(() => {
        if (!connected) return;
        // Node's own messages, such as the cluster module's, are not the program's.
        if (isInternalMessage(value)) {
          target.emit('internalMessage', value, undefined);
          return;
        }
        if (target.listenerCount('message') === 0) {
          unheard.push(value);
          return;
        }
        deliverUnheard();
        target.emit('message', value, undefined);
      });
    },
    close: () => void finish()
  });
  link.listen();

  target.on('newListener', (event: string | symbol) => {
    if (event !== 'message' && event !== 'disconnect') return;
    options.nextTick(() => {
      updateActivity();
      deliverUnheard();
    });
  });
  target.on('removeListener', (event: string | symbol) => {
    if (event === 'message' || event === 'disconnect') options.nextTick(updateActivity);
  });

  const handle: IpcChannelHandle = {
    ref() {
      referenced = true;
      updateActivity();
    },
    unref() {
      referenced = false;
      updateActivity();
    },
    hasRef: () => release !== undefined
  };

  return {
    get connected() {
      return connected;
    },
    handle,
    send(message, ...rest) {
      let [sendHandle, sendOptions, callback] = rest;
      if (typeof sendHandle === 'function') {
        callback = sendHandle;
        sendHandle = undefined;
        sendOptions = undefined;
      } else if (typeof sendOptions === 'function') {
        callback = sendOptions;
        sendOptions = undefined;
      }
      if (message === undefined) {
        throw new IpcError('ERR_MISSING_ARGS', 'The "message" argument must be specified', 'TypeError');
      }
      if (sendHandle !== undefined && sendHandle !== null) {
        throw new IpcError('ENOTSUP', 'Sending a handle over an IPC channel is not supported in Mimic.');
      }
      const done = typeof callback === 'function' ? (callback as (error: Error | null) => void) : undefined;
      if (!connected) {
        const error = new IpcError('ERR_IPC_CHANNEL_CLOSED', 'Channel closed');
        options.nextTick(() => (done ? done(error) : target.emit('error', error)));
        return false;
      }
      const wire: IpcWireValue =
        options.serialization === 'advanced'
          ? { kind: 'advanced', value: structuredClone(message) }
          : { kind: 'json', text: JSON.stringify(message) };
      link.post({ value: wire, references: [] }, []);
      if (done) options.nextTick(() => done(null));
      return true;
    },
    disconnect() {
      if (!connected) {
        target.emit('error', new IpcError('ERR_IPC_DISCONNECTED', 'IPC channel is already disconnected'));
        return;
      }
      link.close();
      connected = false;
      unheard.length = 0;
      updateActivity();
      options.nextTick(() => target.emit('disconnect'));
    },
    close() {
      if (!connected) return Promise.resolve();
      link.close();
      return finish();
    }
  };
}

/** A message whose `cmd` starts with `NODE_`, which Node emits as `internalMessage`. */
function isInternalMessage(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const command = (value as { cmd?: unknown }).cmd;
  return typeof command === 'string' && command.length > 4 && command.startsWith('NODE_');
}

function decode(wire: IpcWireValue): unknown {
  return wire.kind === 'json' ? JSON.parse(wire.text) : wire.value;
}

/** Gives `target` the IPC members Node gives a forked `process` and a `ChildProcess`. */
export function exposeIpcChannel(target: object, channel: IpcChannel): void {
  Object.defineProperties(target, {
    send: {
      configurable: true,
      writable: true,
      value: (message: unknown, ...rest: readonly unknown[]) => channel.send(message, ...rest)
    },
    disconnect: { configurable: true, writable: true, value: () => channel.disconnect() },
    connected: { configurable: true, enumerable: true, get: () => channel.connected },
    channel: { configurable: true, enumerable: true, get: () => (channel.connected ? channel.handle : undefined) }
  });
}

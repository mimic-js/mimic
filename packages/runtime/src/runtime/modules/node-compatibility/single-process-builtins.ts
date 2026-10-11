import { EventEmitter } from './events';

/**
 * The builtins of process models the runtime does not host. They load, so a
 * package that only imports them or checks what they report keeps working,
 * and they describe the one process there is: `trace_events` records nothing,
 * and creating a REPL fails with an error that names what is missing.
 * `cluster` forks Runtime Processes (`cluster.ts`).
 *
 * A browser cannot send or receive UDP datagrams, so `dgram` behaves as on a
 * machine with no route for them: a socket is created and binds as in Node,
 * receives nothing, and a datagram it sends, a `connect` or a multicast
 * membership fails with `ENOTSUP`, reported where Node reports that failure
 * (the send callback, else the `error` event; a thrown membership error).
 */
export function createDgramBuiltin(): unknown {
  type Address = { address: string; family: 'IPv4' | 'IPv6'; port: number };
  const nodeError = (code: string, message: string): Error => Object.assign(new Error(message), { code });
  const systemError = (syscall: string, code: 'EBADF' | 'ENOTSUP', address?: string, port?: number): Error =>
    Object.assign(
      new Error(`${syscall} ${code}${address === undefined ? '' : ` ${address}:${port}`}`),
      { errno: code === 'EBADF' ? -9 : -95, code, syscall },
      address === undefined ? {} : { address, port }
    );
  let nextEphemeralPort = 49152;

  class Socket extends EventEmitter {
    readonly type: 'udp4' | 'udp6';
    #closed = false;
    #bound: Address | undefined;
    #binding = false;

    constructor(options: string | { type?: string }, listener?: (...args: unknown[]) => void) {
      super();
      const type = typeof options === 'string' ? options : options?.type;
      if (type !== 'udp4' && type !== 'udp6') {
        throw Object.assign(new TypeError('Bad socket type specified. Valid types are: udp4, udp6'), {
          code: 'ERR_SOCKET_BAD_TYPE'
        });
      }
      this.type = type;
      if (typeof listener === 'function') this.on('message', listener);
    }

    #running(): void {
      if (this.#closed) throw nodeError('ERR_SOCKET_DGRAM_NOT_RUNNING', 'Not running');
    }

    #anyAddress(): string {
      return this.type === 'udp4' ? '0.0.0.0' : '::';
    }

    #loopback(): string {
      return this.type === 'udp4' ? '127.0.0.1' : '::1';
    }

    bind(...args: unknown[]): this {
      this.#running();
      if (this.#bound || this.#binding) throw nodeError('ERR_SOCKET_ALREADY_BOUND', 'Socket is already bound');
      const callback = typeof args.at(-1) === 'function' ? (args.pop() as () => void) : undefined;
      const options = (
        args[0] !== null && typeof args[0] === 'object' ? args[0] : { port: args[0], address: args[1] }
      ) as { port?: unknown; address?: unknown };
      const requested = Number(options.port ?? 0) || 0;
      const address = typeof options.address === 'string' && options.address ? options.address : this.#anyAddress();
      if (callback) this.once('listening', callback);
      this.#binding = true;
      queueMicrotask(() => {
        this.#binding = false;
        if (this.#closed) return;
        const port = requested || nextEphemeralPort++;
        this.#bound = { address, family: this.type === 'udp4' ? 'IPv4' : 'IPv6', port };
        this.emit('listening');
      });
      return this;
    }

    /** No datagram leaves; the failure reaches the callback, as a failed send's does in Node. */
    send(...args: unknown[]): void {
      this.#running();
      const callback = typeof args.at(-1) === 'function' ? (args.pop() as (error: Error) => void) : undefined;
      const address = typeof args.at(-1) === 'string' ? (args.pop() as string) : this.#loopback();
      const port = Number(args.at(-1));
      if (!this.#bound && !this.#binding) this.bind(0);
      const error = systemError('send', 'ENOTSUP', address, port);
      queueMicrotask(() => {
        if (callback) callback(error);
        else if (!this.#closed) this.emit('error', error);
      });
    }

    connect(port: unknown, ...args: unknown[]): void {
      this.#running();
      const address = typeof args[0] === 'string' ? args[0] : this.#loopback();
      if (!this.#bound && !this.#binding) this.bind(0);
      const error = systemError('connect', 'ENOTSUP', address, Number(port));
      queueMicrotask(() => {
        if (!this.#closed) this.emit('error', error);
      });
    }

    close(callback?: () => void): this {
      this.#running();
      this.#closed = true;
      this.#bound = undefined;
      if (typeof callback === 'function') this.once('close', callback);
      queueMicrotask(() => this.emit('close'));
      return this;
    }

    address(): Address {
      this.#running();
      if (!this.#bound) throw systemError('getsockname', 'EBADF');
      return { ...this.#bound };
    }

    remoteAddress(): never {
      this.#running();
      throw nodeError('ERR_SOCKET_DGRAM_NOT_CONNECTED', 'Not connected');
    }

    disconnect(): void {
      this.remoteAddress();
    }

    /** A socket option is set on a bound socket, and fails on an unbound one as Node's does. */
    #option(syscall: string): void {
      this.#running();
      if (!this.#bound) throw systemError(syscall, 'EBADF');
    }

    setTTL(): void {
      this.#option('setTTL');
    }

    setMulticastTTL(): void {
      this.#option('setMulticastTTL');
    }

    setMulticastLoopback(): void {
      this.#option('setMulticastLoopback');
    }

    setMulticastInterface(): void {
      this.#option('setMulticastInterface');
    }

    setBroadcast(): void {
      this.#option('setBroadcast');
    }

    #membership(syscall: string): never {
      this.#running();
      throw systemError(syscall, 'ENOTSUP');
    }

    addMembership(): never {
      return this.#membership('addMembership');
    }

    dropMembership(): never {
      return this.#membership('dropMembership');
    }

    addSourceSpecificMembership(): never {
      return this.#membership('addSourceSpecificMembership');
    }

    dropSourceSpecificMembership(): never {
      return this.#membership('dropSourceSpecificMembership');
    }

    /** Linux's default socket buffer size, which Node reports before one is set. */
    #bufferSizes = { recv: 212992, send: 212992 };

    #bufferSize(kind: 'recv' | 'send', size?: unknown): number {
      this.#running();
      if (size === undefined) return this.#bufferSizes[kind];
      if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0) {
        throw Object.assign(new TypeError('Buffer size must be a positive integer'), {
          code: 'ERR_SOCKET_BAD_BUFFER_SIZE'
        });
      }
      return (this.#bufferSizes[kind] = size);
    }

    getRecvBufferSize(): number {
      return this.#bufferSize('recv');
    }

    setRecvBufferSize(size: number): void {
      this.#bufferSize('recv', size);
    }

    getSendBufferSize(): number {
      return this.#bufferSize('send');
    }

    setSendBufferSize(size: number): void {
      this.#bufferSize('send', size);
    }

    ref(): this {
      return this;
    }

    unref(): this {
      return this;
    }

    getSendQueueSize(): number {
      return 0;
    }

    getSendQueueCount(): number {
      return 0;
    }
  }
  const createSocket = (options: string | { type?: string }, listener?: (...args: unknown[]) => void) =>
    new Socket(options, listener);
  const dgram = { createSocket, Socket };
  return { ...dgram, default: dgram };
}

export function createTraceEventsBuiltin(): unknown {
  const createTracing = ({ categories }: { categories: readonly string[] }) => {
    let enabled = false;
    return {
      categories: categories.join(','),
      get enabled() {
        return enabled;
      },
      enable() {
        enabled = true;
      },
      disable() {
        enabled = false;
      }
    };
  };
  const traceEvents = { createTracing, getEnabledCategories: () => undefined };
  return { ...traceEvents, default: traceEvents };
}

export function createReplBuiltin(): unknown {
  const start = (): never => {
    throw unsupported('repl.start()', 'the runtime has no interactive evaluator');
  };
  class REPLServer extends EventEmitter {
    constructor() {
      super();
      start();
    }
  }
  const repl = {
    start,
    REPLServer,
    REPL_MODE_SLOPPY: Symbol('repl-sloppy'),
    REPL_MODE_STRICT: Symbol('repl-strict'),
    builtinModules: [] as string[]
  };
  return { ...repl, default: repl };
}

function unsupported(operation: string, reason: string): Error {
  return Object.assign(new Error(`${operation} is not supported in Mimic: ${reason}.`), {
    code: 'ERR_NOT_SUPPORTED'
  });
}

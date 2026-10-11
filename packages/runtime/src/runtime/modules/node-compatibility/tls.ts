import {
  Http1ChunkBodyDecoder,
  concatHttp1Bytes,
  parseHttp1RequestHead,
  serializeHttp1Chunk,
  serializeHttp1ChunkTerminator,
  serializeHttp1ResponseHead,
  type Http1Header,
  type Http1RequestHead
} from '../http-1-wire-codec';
import { isLoopbackHost } from '../virtual-network';
import { corsSimpleRequestHeaders } from './http';
import type { VirtualNetBuiltin } from './network-adapter';
import { nodeStream as stream, type NodeTransformStream } from './streams';

type NodeStyleError = Error & { code: string; syscall?: string };

export type TlsCapabilityError = Error & {
  readonly code: 'ENOTSUP';
  readonly syscall: string;
};

export type TlsFetch = (input: string, init: RequestInit) => Promise<Response>;

export type TlsBuiltinOptions = Readonly<{
  /** Browser Fetch; absent when the context has none. */
  fetch?: TlsFetch;
  /** Node Buffers for the bytes a program reads, as `node:net` makes them. */
  bytes?: Readonly<{
    buffer(value: Uint8Array): Uint8Array;
    from(value: string, encoding?: string): Uint8Array;
  }>;
  /** Queues a macrotask; connection events are delivered through it. */
  queue?: (callback: () => void) => unknown;
}>;

/** A connection `tls.connect` returns: a Node socket with the TLS members clients read. */
export type TlsSocket = NodeTransformStream & {
  readonly connecting: boolean;
  readonly pending: boolean;
  readonly authorized: boolean;
  readonly encrypted: boolean;
  readonly alpnProtocol: string | false;
  readonly servername: string;
  readonly remoteAddress: string;
  readonly remotePort: number;
  readonly bytesRead: number;
  readonly bytesWritten: number;
  setTimeout(timeout: number, callback?: () => void): TlsSocket;
  setNoDelay(): TlsSocket;
  setKeepAlive(): TlsSocket;
  ref(): TlsSocket;
  unref(): TlsSocket;
  getPeerCertificate(): object;
  getProtocol(): string;
  getSession(): undefined;
};

export type TlsBuiltin = {
  readonly connect: (...args: readonly unknown[]) => TlsSocket | object;
  readonly createServer: (...args: readonly unknown[]) => never;
  readonly createSecureContext: (...args: readonly unknown[]) => { readonly context: object };
  readonly createSecurePair: (...args: readonly unknown[]) => never;
  readonly checkServerIdentity: (...args: readonly unknown[]) => undefined;
  readonly getCiphers: () => readonly string[];
  readonly rootCertificates: readonly string[];
  readonly DEFAULT_MIN_VERSION: string;
  readonly DEFAULT_MAX_VERSION: string;
  readonly DEFAULT_CIPHERS: string;
  readonly DEFAULT_ECDH_CURVE: string;
  readonly TLSSocket: new (...args: readonly unknown[]) => object;
  readonly SecureContext: new (...args: readonly unknown[]) => object;
  readonly default: Omit<TlsBuiltin, 'default'>;
};

/**
 * Request headers that frame the HTTP/1 connection rather than the request;
 * Fetch frames its own request, so they are not sent.
 */
const CONNECTION_REQUEST_HEADERS = new Set([
  'connection',
  'content-length',
  'expect',
  'host',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/** Response headers Fetch has already consumed: the body arrives decoded and unframed. */
const CONNECTION_RESPONSE_HEADERS = new Set([
  'connection',
  'content-encoding',
  'content-length',
  'keep-alive',
  'trailer',
  'transfer-encoding'
]);

const REASON_PHRASES: ReadonlyMap<number, string> = new Map([
  [100, 'Continue'], [101, 'Switching Protocols'], [200, 'OK'], [201, 'Created'], [202, 'Accepted'],
  [204, 'No Content'], [206, 'Partial Content'], [301, 'Moved Permanently'], [302, 'Found'],
  [303, 'See Other'], [304, 'Not Modified'], [307, 'Temporary Redirect'], [308, 'Permanent Redirect'],
  [400, 'Bad Request'], [401, 'Unauthorized'], [403, 'Forbidden'], [404, 'Not Found'],
  [405, 'Method Not Allowed'], [408, 'Request Timeout'], [409, 'Conflict'], [410, 'Gone'],
  [412, 'Precondition Failed'], [413, 'Payload Too Large'], [416, 'Range Not Satisfiable'],
  [422, 'Unprocessable Entity'], [429, 'Too Many Requests'], [500, 'Internal Server Error'],
  [501, 'Not Implemented'], [502, 'Bad Gateway'], [503, 'Service Unavailable'], [504, 'Gateway Timeout']
]);

const encoder = new TextEncoder();

/**
 * `node:tls` over browser Fetch. A program that speaks HTTP/1.1 over
 * `tls.connect()` (undici and the clients built on it, which pnpm bundles)
 * gets a socket that frames each request it writes, sends it through Fetch
 * and writes the response back as HTTP/1.1 bytes, keeping the connection open
 * for the next request. The browser owns the TLS session, so the socket
 * reports an authorized peer and no certificate detail. Raw TLS to a loopback
 * listener and TLS servers stay unavailable.
 */
export function createTlsBuiltin(network?: VirtualNetBuiltin, options: TlsBuiltinOptions = {}): TlsBuiltin {
  const fetchImplementation = options.fetch ?? defaultFetch();
  const bytes = options.bytes ?? {
    buffer: (value: Uint8Array) => value,
    from: (value: string) => encoder.encode(value)
  };
  const queue = options.queue ?? ((callback: () => void) => globalThis.setTimeout(callback, 0));

  class FetchBackedTlsSocket extends stream.Duplex {
    connecting = true;
    pending = true;
    readonly authorized = true;
    readonly encrypted = true;
    readonly alpnProtocol: string | false;
    servername: string;
    readonly localAddress = '127.0.0.1';
    readonly localPort = 0;
    readonly remoteAddress: string;
    readonly remotePort: number;
    readonly remoteFamily = 'IPv4';
    bytesRead = 0;
    bytesWritten = 0;
    allowHalfOpen = false;
    readonly #fetch: TlsFetch;
    readonly #abort = new AbortController();
    #inbound: Uint8Array = new Uint8Array();
    #current: {
      readonly head: Http1RequestHead;
      readonly body: Uint8Array[];
      remaining: number;
      readonly decoder?: Http1ChunkBodyDecoder;
    } | undefined;
    readonly #queue: { readonly head: Http1RequestHead; readonly body: Uint8Array }[] = [];
    #serving = false;
    #resumeRead: (() => void) | undefined;
    #readRequested = false;
    #timeout: { readonly ms: number; timer: ReturnType<typeof setTimeout> | undefined } | undefined;

    constructor(
      target: Readonly<{ host: string; port: number; servername: string; alpnProtocols: readonly string[] }>,
      fetchImplementation: TlsFetch
    ) {
      super({
        allowHalfOpen: false,
        autoDestroy: true,
        emitClose: false,
        highWaterMark: 16 * 1024,
        read() {
          const target = this as FetchBackedTlsSocket;
          target.#readRequested = true;
          const resume = target.#resumeRead;
          target.#resumeRead = undefined;
          resume?.();
        },
        write(chunk, encoding, callback) {
          (this as FetchBackedTlsSocket).#receive(chunk, encoding, callback);
        },
        final(callback) {
          const target = this as FetchBackedTlsSocket;
          callback();
          target.#finishWhenIdle();
        },
        destroy(error, callback) {
          const target = this as FetchBackedTlsSocket;
          target.connecting = false;
          target.pending = false;
          target.#clearTimeout();
          target.#abort.abort();
          const resume = target.#resumeRead;
          target.#resumeRead = undefined;
          resume?.();
          callback(error);
          queueMicrotask(() => target.emit('close', Boolean(error)));
        }
      });
      this.#fetch = fetchImplementation;
      this.remoteAddress = target.host;
      this.remotePort = target.port;
      this.servername = target.servername;
      // HTTP/2 is not spoken here; a client offering it is told HTTP/1.1 was negotiated.
      this.alpnProtocol = target.alpnProtocols.includes('http/1.1') || target.alpnProtocols.length === 0 ? 'http/1.1' : false;
      queue(() => {
        if (this.destroyed) return;
        this.connecting = false;
        this.pending = false;
        this.emit('connect');
        this.emit('secureConnect');
        this.emit('ready');
      });
    }

    get readyState(): 'opening' | 'open' | 'readOnly' | 'writeOnly' | 'closed' {
      if (this.destroyed) return 'closed';
      if (this.connecting) return 'opening';
      if (this.readable && this.writable) return 'open';
      if (this.readable) return 'readOnly';
      if (this.writable) return 'writeOnly';
      return 'closed';
    }

    override read(size?: number): Uint8Array | string | null {
      return super.read(size) as Uint8Array | string | null;
    }

    setTimeout(timeout: number, callback?: () => void): this {
      if (callback) this.once('timeout', callback);
      this.#clearTimeout();
      this.#timeout = timeout > 0 ? { ms: timeout, timer: undefined } : undefined;
      this.#armTimeout();
      return this;
    }

    setNoDelay(): this { return this; }
    setKeepAlive(): this { return this; }
    ref(): this { return this; }
    unref(): this { return this; }
    setServername(name: string): void { this.servername = name; }
    getPeerCertificate(): object { return {}; }
    getCertificate(): null { return null; }
    getProtocol(): string { return 'TLSv1.3'; }
    getCipher(): { name: string; standardName: string; version: string } {
      return { name: 'TLS_AES_128_GCM_SHA256', standardName: 'TLS_AES_128_GCM_SHA256', version: 'TLSv1.3' };
    }
    getSession(): undefined { return undefined; }
    getTLSTicket(): undefined { return undefined; }
    isSessionReused(): boolean { return false; }
    address(): { address: string; family: string; port: number } {
      return { address: this.localAddress, family: this.remoteFamily, port: this.localPort };
    }

    #receive(chunk: unknown, encoding: string, callback: (error?: Error | null) => void): void {
      const data = typeof chunk === 'string' ? bytes.from(chunk, encoding) : toBytes(chunk ?? '');
      this.bytesWritten += data.byteLength;
      this.#inbound = this.#inbound.byteLength === 0 ? data : concatHttp1Bytes([this.#inbound, data]);
      this.#armTimeout();
      try {
        this.#frameRequests();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      callback();
    }

    /** Cuts complete HTTP/1 requests out of what the program wrote. */
    #frameRequests(): void {
      while (true) {
        if (!this.#current) {
          const head = parseHttp1RequestHead(this.#inbound);
          if (!head) return;
          if (head.upgrade) {
            throw unsupportedTransport('HTTP upgrade cannot be carried over browser Fetch.');
          }
          this.#inbound = this.#inbound.slice(head.bodyStart);
          const body: Uint8Array[] = [];
          this.#current = {
            head,
            body,
            remaining: head.contentLength,
            ...(head.chunked
              ? { decoder: new Http1ChunkBodyDecoder((chunk) => body.push(chunk), () => undefined, () => undefined) }
              : {})
          };
          if (
            (head.chunked || head.contentLength > 0) &&
            !this.#serving &&
            head.headers.some(([name, value]) => name === 'expect' && value.toLowerCase() === '100-continue')
          ) {
            void this.#send(encoder.encode('HTTP/1.1 100 Continue\r\n\r\n'));
          }
        }
        const current = this.#current;
        if (current.decoder) {
          if (this.#inbound.byteLength === 0 && !current.decoder.complete) return;
          current.decoder.push(this.#inbound);
          this.#inbound = new Uint8Array();
          if (!current.decoder.complete) return;
          this.#inbound = current.decoder.remainder;
        } else {
          const taken = Math.min(current.remaining, this.#inbound.byteLength);
          if (taken > 0) {
            current.body.push(this.#inbound.slice(0, taken));
            this.#inbound = this.#inbound.slice(taken);
            current.remaining -= taken;
          }
          if (current.remaining > 0) return;
        }
        this.#current = undefined;
        this.#queue.push({ head: current.head, body: concatHttp1Bytes(current.body) });
        this.#serve();
      }
    }

    #serve(): void {
      if (this.#serving) return;
      this.#serving = true;
      void (async () => {
        try {
          while (this.#queue.length > 0 && !this.destroyed) {
            const request = this.#queue.shift()!;
            await this.#respond(request.head, request.body);
          }
        } catch (error) {
          if (!this.destroyed) this.destroy(error instanceof Error ? error : new Error(String(error)));
        } finally {
          this.#serving = false;
        }
        this.#finishWhenIdle();
      })();
    }

    /** Ends the readable side once the program ended its writes and every request is answered. */
    #finishWhenIdle(): void {
      if (this.destroyed || !this.writableEnded || this.#serving || this.#queue.length > 0 || this.readableEnded) return;
      this.#clearTimeout();
      this.push(null);
    }

    async #respond(head: Http1RequestHead, body: Uint8Array): Promise<void> {
      const method = head.method.toUpperCase();
      const url = this.#urlFor(head);
      const headers = head.headers.filter(([name]) => !CONNECTION_REQUEST_HEADERS.has(name));
      const hasBody = body.byteLength > 0 && method !== 'GET' && method !== 'HEAD';
      let response: Response;
      try {
        response = await this.#fetch(url, {
          cache: 'no-store',
          credentials: 'omit',
          method,
          headers: corsSimpleRequestHeaders(method, url, headers.map(([name, value]): [string, string] => [name, value])),
          // Fetch can only hide a redirect (an opaque response without status
          // or Location) or follow it; the client receives the final response.
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal: this.#abort.signal,
          ...(hasBody ? { body: toArrayBuffer(body) } : {})
        });
      } catch (reason) {
        if (this.destroyed) return;
        throw fetchError(reason);
      }
      if (this.destroyed) return;
      const responseHeaders: Http1Header[] = [...response.headers.entries()]
        .map(([name, value]): Http1Header => [name.toLowerCase(), value])
        .filter(([name]) => !CONNECTION_RESPONSE_HEADERS.has(name));
      const bodiless = method === 'HEAD' || response.status === 204 || response.status === 304 || response.status < 200;
      const contentLength = response.headers.get('content-length');
      const framing: Http1Header[] = bodiless
        ? method === 'HEAD' && contentLength !== null ? [['content-length', contentLength]] : []
        : [['transfer-encoding', 'chunked']];
      await this.#send(
        serializeHttp1ResponseHead({
          status: response.status,
          statusText: response.statusText || REASON_PHRASES.get(response.status) || 'Unknown',
          headers: [...responseHeaders, ...framing, ['connection', 'keep-alive']]
        })
      );
      if (bodiless) {
        await response.body?.cancel().catch(() => undefined);
        return;
      }
      const reader = response.body?.getReader();
      if (reader) {
        try {
          while (!this.destroyed) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value.byteLength > 0) await this.#send(serializeHttp1Chunk(value));
          }
        } catch (reason) {
          if (this.destroyed) return;
          throw fetchError(reason);
        } finally {
          reader.releaseLock();
        }
      }
      if (!this.destroyed) await this.#send(serializeHttp1ChunkTerminator([]));
    }

    #urlFor(head: Http1RequestHead): string {
      if (/^https?:\/\//iu.test(head.path)) return head.path;
      const hostHeader = head.headers.find(([name]) => name === 'host')?.[1]?.trim();
      const authority = hostHeader || (this.remotePort === 443 ? this.servername : `${this.servername}:${this.remotePort}`);
      return `https://${authority}${head.path.startsWith('/') ? head.path : `/${head.path}`}`;
    }

    /** Hands bytes to the program, waiting while its read buffer is full. */
    #send(chunk: Uint8Array): Promise<void> {
      if (this.destroyed) return Promise.resolve();
      this.bytesRead += chunk.byteLength;
      this.#armTimeout();
      this.#readRequested = false;
      if (this.push(bytes.buffer(chunk)) || this.#readRequested || this.destroyed) return Promise.resolve();
      return new Promise((resolve) => {
        this.#resumeRead = resolve;
      });
    }

    #armTimeout(): void {
      const timeout = this.#timeout;
      if (!timeout) return;
      if (timeout.timer !== undefined) clearTimeout(timeout.timer);
      timeout.timer = setTimeout(() => {
        timeout.timer = undefined;
        if (!this.destroyed) this.emit('timeout');
      }, timeout.ms);
    }

    #clearTimeout(): void {
      if (this.#timeout?.timer !== undefined) clearTimeout(this.#timeout.timer);
      this.#timeout = undefined;
    }
  }

  const connect = (...args: readonly unknown[]): TlsSocket | object => {
    const target = parseConnectArguments(args);
    if (target.socket !== undefined && target.socket !== null) {
      // As in Node, the handshake over the given socket starts at once and its failure is an
      // 'error' event on the TLSSocket returned, not an exception.
      const socket = new TLSSocket(target.socket, { ...target.options, servername: target.servername });
      if (target.callback) socket.once('secureConnect', target.callback);
      socket._start();
      return socket;
    }
    if (network && isLoopbackHost(target.host)) {
      // The Virtual Network answers for its own listeners, including its refusal of raw TLS.
      return network.connect({ ...target.options, host: target.host, port: target.port, transport: 'tls' }, ...(target.callback ? [target.callback] : []));
    }
    const socket = new FetchBackedTlsSocket(
      { host: target.host, port: target.port, servername: target.servername, alpnProtocols: target.alpnProtocols },
      fetchImplementation
    ) as unknown as TlsSocket;
    if (target.callback) socket.once('secureConnect', target.callback);
    return socket;
  };

  /**
   * Node's internal adapter that makes any Duplex the socket under a TLSSocket; a program
   * reaches it as `new tls.TLSSocket(duplex)._handle._parentWrap.constructor`. It relays
   * what is written to the stream and what the stream reads.
   */
  class JSStreamSocket extends stream.Duplex {
    readonly stream: NodeTransformStream;

    constructor(wrapped: NodeTransformStream) {
      super({
        read() {
          (this as JSStreamSocket).stream.resume();
        },
        write(chunk, encoding, callback) {
          (this as JSStreamSocket).stream.write(chunk, encoding, callback);
        },
        final(callback) {
          (this as JSStreamSocket).stream.end(callback);
        },
        destroy(error, callback) {
          (this as JSStreamSocket).stream.destroy(error ?? undefined);
          callback(error);
        }
      });
      this.stream = wrapped;
      wrapped.on('data', (chunk: unknown) => {
        if (!this.push(chunk)) wrapped.pause();
      });
      wrapped.once('end', () => this.push(null));
      wrapped.once('error', (error: unknown) => this.destroy(error as Error));
      wrapped.once('close', () => this.destroy());
    }
  }

  /**
   * `new tls.TLSSocket([socket][, options])`. Constructing one starts nothing, as in Node:
   * the socket under it, or the JSStreamSocket wrapping a Duplex, is its handle's parent.
   * The handshake, when the client starts it or the peer of a server socket speaks, cannot
   * run here, because the browser holds the only TLS engine; it fails the way a handshake
   * fails in Node, as an 'error' event and a destroyed socket.
   */
  class TLSSocket extends stream.Duplex {
    readonly encrypted = true;
    authorized = false;
    authorizationError: Error | undefined;
    connecting = false;
    pending = true;
    alpnProtocol: string | false = false;
    servername: string | undefined;
    readonly _handle: { readonly _parentWrap: unknown; readonly _parent: unknown } | null;
    #handshake: 'idle' | 'failed' = 'idle';

    constructor(socket?: unknown, givenOptions?: unknown) {
      const options = (givenOptions && typeof givenOptions === 'object' ? givenOptions : {}) as Readonly<Record<string, unknown>>;
      super({
        write(_chunk, _encoding, callback) {
          // Node queues what is written until the session is secure; here it never becomes so.
          (this as TLSSocket)._start();
          callback();
        },
        read() {}
      });
      this.servername = typeof options.servername === 'string' ? options.servername : undefined;
      const parentWrap = wrapSocket(socket);
      this._handle = parentWrap === null ? null : {
        _parentWrap: parentWrap,
        _parent: (parentWrap as { _handle?: unknown })._handle ?? null
      };
      if (options.isServer === true && parentWrap !== null) {
        // A server's handshake starts when the client's hello arrives.
        (parentWrap as NodeTransformStream).once('data', () => this._start());
      }
    }

    _start(): void {
      if (this.#handshake !== 'idle') return;
      this.#handshake = 'failed';
      queue(() => {
        if (this.destroyed) return;
        this.destroy(tlsError('connect', 'node:tls cannot start TLS on an existing socket in this runtime.'));
      });
    }

    setServername(name: string): void { this.servername = name; }
    setTimeout(_timeout: number, callback?: () => void): this {
      if (callback) this.once('timeout', callback);
      return this;
    }
    setNoDelay(): this { return this; }
    setKeepAlive(): this { return this; }
    ref(): this { return this; }
    unref(): this { return this; }
    getPeerCertificate(): object { return {}; }
    getCertificate(): null { return null; }
    getProtocol(): null { return null; }
    getCipher(): undefined { return undefined; }
    getSession(): undefined { return undefined; }
    getTLSTicket(): undefined { return undefined; }
    isSessionReused(): boolean { return false; }
  }

  /** A socket with a native handle is its own parent; any other Duplex gets a JSStreamSocket, as in Node. */
  function wrapSocket(socket: unknown): unknown {
    if (socket === undefined || socket === null || typeof socket !== 'object') return null;
    if ((socket as { _handle?: unknown })._handle) return socket;
    if (typeof (socket as NodeTransformStream).pipe === 'function' && typeof (socket as NodeTransformStream).write === 'function') {
      return new JSStreamSocket(socket as NodeTransformStream);
    }
    return socket;
  }
  class SecureContext {
    readonly context = {};
  }
  const tls = {
    connect,
    createServer: (..._args: readonly unknown[]): never => unsupportedTls('createServer'),
    createSecureContext: (..._args: readonly unknown[]) => new SecureContext(),
    createSecurePair: (..._args: readonly unknown[]): never => unsupportedTls('createSecurePair'),
    // The browser verified the peer; the identity a program checks is the one it connected to.
    checkServerIdentity: (..._args: readonly unknown[]): undefined => undefined,
    getCiphers: (): readonly string[] => [],
    rootCertificates: Object.freeze([]) as readonly string[],
    DEFAULT_MIN_VERSION: 'TLSv1.2',
    DEFAULT_MAX_VERSION: 'TLSv1.3',
    DEFAULT_CIPHERS: '',
    DEFAULT_ECDH_CURVE: 'auto',
    TLSSocket,
    SecureContext
  };
  return { ...tls, default: tls };
}

type ConnectTarget = Readonly<{
  host: string;
  port: number;
  servername: string;
  alpnProtocols: readonly string[];
  socket: unknown;
  options: Readonly<Record<string, unknown>>;
  callback: (() => void) | undefined;
}>;

/** `connect(options[, callback])`, `connect(port[, host][, options][, callback])`. */
function parseConnectArguments(args: readonly unknown[]): ConnectTarget {
  const options = (args.find((arg): arg is Record<string, unknown> => Boolean(arg) && typeof arg === 'object') ?? {});
  const positionalPort = args.find((arg) => typeof arg === 'number' || (typeof arg === 'string' && /^\d+$/u.test(arg)));
  const positionalHost = args.find((arg) => typeof arg === 'string' && !/^\d+$/u.test(arg));
  const portValue = Number(options.port ?? positionalPort ?? 443);
  const host = String(options.host ?? options.hostname ?? positionalHost ?? 'localhost');
  const alpn = options.ALPNProtocols;
  return {
    host,
    port: Number.isInteger(portValue) && portValue > 0 && portValue <= 65_535 ? portValue : 443,
    servername: typeof options.servername === 'string' && options.servername !== '' ? options.servername : host,
    alpnProtocols: Array.isArray(alpn) ? alpn.map(String) : [],
    socket: options.socket,
    options,
    callback: args.find((arg): arg is () => void => typeof arg === 'function')
  };
}

function defaultFetch(): TlsFetch {
  return (input, init) => {
    if (typeof globalThis.fetch !== 'function') {
      return Promise.reject(unsupportedTransport('Browser Fetch is unavailable for outbound TLS.'));
    }
    return globalThis.fetch(input, init);
  };
}

function toBytes(input: unknown): Uint8Array {
  if (typeof input === 'string') return encoder.encode(input);
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return new Uint8Array(input as ArrayLike<number>);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer;
}

function fetchError(reason: unknown): NodeStyleError {
  const message = reason instanceof Error ? reason.message : String(reason);
  return Object.assign(new Error(`Browser Fetch failed: ${message}`), {
    code: 'ECONNREFUSED',
    syscall: 'connect',
    cause: reason
  });
}

function unsupportedTransport(message: string): NodeStyleError {
  return Object.assign(new Error(message), { code: 'ENOTSUP', syscall: 'tls' });
}

function unsupportedTls(operation: string): never {
  throw tlsError(operation);
}

function tlsError(operation: string, message?: string): TlsCapabilityError {
  const error = Object.assign(
    new Error(message ?? `node:tls.${operation}() is not supported because raw TLS is unavailable in this runtime.`),
    { code: 'ENOTSUP' as const, syscall: 'tls' }
  );
  error.name = 'NodeNetworkCapabilityError';
  return error;
}

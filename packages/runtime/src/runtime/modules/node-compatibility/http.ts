import {
  Http1ChunkBodyDecoder as HttpWireChunkBodyDecoder,
  concatHttp1Bytes,
  parseHttp1RequestHead,
  parseHttp1ResponseHead,
  serializeHttp1Chunk,
  serializeHttp1ChunkTerminator,
  serializeHttp1RequestHead,
  serializeHttp1ResponseHead,
  type Http1RequestHead
} from '../http-1-wire-codec';
import type {
  PublishedEndpointServer,
  PublishedEndpointWebSocketConnection,
  PublishedEndpointWebSocketConnectionObserver,
  PublishedHttpRequest,
  PublishedHttpResponse
} from '../published-endpoint';
import type { VirtualNetworkSocket, VirtualNetworkSocketEvent } from '../virtual-network';
import type { ProcessExecutionActivityLifecycle } from './child-process';
import { BrowserBuffer } from './buffer';
import { EventEmitter, type EventListener } from './events';
import { NODE_HTTP_METHODS } from './http-methods';
import { boundAddress, NET_SERVER_OWNER, type NetServerOwner } from './network-adapter';
import { nodeStream as stream } from './streams';

type EventEmitterLike = {
  on(event: string | symbol, listener: EventListener): EventEmitterLike;
  once(event: string | symbol, listener: EventListener): EventEmitterLike;
  emit?(event: string | symbol, ...args: unknown[]): boolean;
};

type VirtualNetSocket = EventEmitterLike & {
  readonly localAddress: string;
  readonly localPort: number;
  readonly remoteAddress: string;
  readonly remotePort: number;
  write(data?: unknown, encodingOrCallback?: string | ((error?: Error) => void), callback?: (error?: Error) => void): boolean;
  end(data?: unknown, encodingOrCallback?: string | (() => void), callback?: () => void): VirtualNetSocket;
  destroy(error?: Error): VirtualNetSocket;
  setEncoding(encoding?: string): VirtualNetSocket;
  pause(): VirtualNetSocket;
  resume(): VirtualNetSocket;
  cork(): void;
  uncork(): void;
};

type VirtualNetServer = EventEmitterLike & {
  readonly listening: boolean;
  listen(...args: unknown[]): VirtualNetServer;
  close(callback?: (error?: Error) => void): VirtualNetServer;
  address(): { address: string; family: string; port: number } | string | null;
};

type VirtualNetBuiltin = {
  /** `attach` gives the socket its connection; a published exchange supplies one of its own. */
  Socket: new () => VirtualNetSocket & { attach(connection: VirtualNetworkSocket): void };
  createServer(optionsOrListener?: unknown, listener?: EventListener): VirtualNetServer;
  createConnection(...args: unknown[]): VirtualNetSocket;
  connect(...args: unknown[]): VirtualNetSocket;
};

type NodeCompatibilityFetch = (
  input: string,
  init: RequestInit
) => Promise<Response>;

type HttpClientRequestOptions = {
  method: string;
  host: string;
  port: number;
  /** A Unix domain socket the request travels over instead of `host` and `port`. */
  socketPath?: string;
  path: string;
  headers: [string, string][];
  unsupportedTransportOptions: string[];
};

/**
 * Node Compatibility's port for publishing a listening `http.Server`. A claim
 * hands Published Endpoint a `PublishedEndpointServer`, which receives each
 * published exchange without HTTP/1 framing; the request, response and
 * WebSocket types are Published Endpoint's.
 */
export type HttpListenerClaims = {
  claim(port: number, listener: PublishedEndpointServer): void;
  release(port: number): void | (() => void);
};

type IncomingHttpHeaders = Record<string, string | string[]>;

// Node keeps only the first value of these headers when a message repeats them.
const singleValueIncomingHeaders = new Set([
  'age',
  'authorization',
  'content-length',
  'content-type',
  'etag',
  'expires',
  'from',
  'host',
  'if-modified-since',
  'if-unmodified-since',
  'last-modified',
  'location',
  'max-forwards',
  'proxy-authorization',
  'referer',
  'retry-after',
  'server',
  'user-agent'
]);

// Projects request headers onto `IncomingMessage.headers` with Node's
// duplicate rules. Nothing is added or rewritten here: the handler sees what
// was sent. Headers a Published Endpoint must supply are owned by
// `publishedRequestHeaders` in `../published-endpoint/browser-host.ts`.
function incomingHttpHeaders(headers: readonly (readonly [string, string])[]): IncomingHttpHeaders {
  const output: IncomingHttpHeaders = {};
  for (const [rawName, value] of headers) {
    const name = rawName.toLowerCase();
    const current = output[name];
    if (name === 'set-cookie') output[name] = [...(Array.isArray(current) ? current : []), value];
    else if (current === undefined) output[name] = value;
    else if (!singleValueIncomingHeaders.has(name)) {
      output[name] = `${String(current)}${name === 'cookie' ? '; ' : ', '}${value}`;
    }
  }
  return output;
}

function rawHttpHeaders(headers: readonly (readonly [string, string])[]): string[] {
  return headers.flatMap(([name, value]) => [name, value]);
}

function httpHeaderTokens(value: string | number | string[] | undefined): string[] {
  return arrayHeader(value ?? '').flatMap((part) => part.toLowerCase().split(',').map((token) => token.trim()));
}

const concatBytes = concatHttp1Bytes;

function toHttpBytes(input: unknown): Uint8Array {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return BrowserBuffer.from(String(input ?? ''));
}

function arrayHeader(value: string | number | string[]): string[] {
  return Array.isArray(value) ? value : [String(value)];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object';
}

function httpHeaderValue(value: unknown): string | undefined {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value) && value.every((part): part is string => typeof part === 'string')) return value.join(', ');
  return undefined;
}

function parseHttpClientRequestOptions(
  protocol: 'http' | 'https',
  input: unknown,
  overrides?: Record<string, unknown>
): HttpClientRequestOptions {
  let url: URL | undefined;
  if (typeof input === 'string' || input instanceof URL) {
    try {
      url = input instanceof URL ? input : new URL(input);
    } catch (cause) {
      throw Object.assign(new TypeError(`Invalid URL: ${String(input)}`, { cause }), { code: 'ERR_INVALID_URL' });
    }
    if (url.protocol !== `${protocol}:`) {
      throw Object.assign(new TypeError(`Protocol "${url.protocol}" not supported. Expected "${protocol}:"`), {
        code: 'ERR_INVALID_PROTOCOL'
      });
    }
  }
  const inputOptions = isObjectRecord(input) && !(input instanceof URL) ? input : {};
  const options = { ...inputOptions, ...overrides };
  if (typeof options.protocol === 'string' && options.protocol !== `${protocol}:`) {
    throw Object.assign(new TypeError(`Protocol "${options.protocol}" not supported. Expected "${protocol}:"`), {
      code: 'ERR_INVALID_PROTOCOL'
    });
  }
  const hostCandidate = options.hostname ?? options.host ?? url?.hostname ?? 'localhost';
  const host = String(hostCandidate).replace(/^\[|\]$/gu, '') || 'localhost';
  const portCandidate = options.port ?? url?.port;
  const defaultPort = protocol === 'https' ? 443 : 80;
  const port = portCandidate === undefined || portCandidate === '' ? defaultPort : Number(portCandidate);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw Object.assign(new RangeError(`Port should be >= 1 and < 65536. Received ${String(portCandidate)}.`), {
      code: 'ERR_SOCKET_BAD_PORT'
    });
  }
  const path = String(options.path ?? (url ? `${url.pathname}${url.search}` : '/')) || '/';
  const method = String(options.method ?? 'GET').toUpperCase();
  const headersValue = options.headers;
  const headers: [string, string][] = [];
  if (headersValue && typeof headersValue === 'object' && !Array.isArray(headersValue)) {
    for (const [name, value] of Object.entries(headersValue)) {
      const normalized = httpHeaderValue(value);
      if (normalized === undefined) continue;
      headers.push([name.toLowerCase(), normalized]);
    }
  }
  const rawSocketOptions = ['agent', 'createConnection', 'family', 'localAddress', 'localPort', 'lookup', 'socketPath'] as const;
  const tlsOptions = [
    'ca',
    'cert',
    'checkServerIdentity',
    'ciphers',
    'clientCertEngine',
    'crl',
    'dhparam',
    'ecdhCurve',
    'honorCipherOrder',
    'key',
    'maxVersion',
    'minVersion',
    'passphrase',
    'pfx',
    'privateKeyEngine',
    'privateKeyIdentifier',
    'rejectUnauthorized',
    'secureContext',
    'secureOptions',
    'secureProtocol',
    'servername',
    'session',
    'sigalgs'
  ] as const;
  const unsupportedTransportOptions = [
    ...rawSocketOptions.filter((name) => isUnsupportedSocketOption(name, options[name])),
    ...(protocol === 'https' ? tlsOptions.filter((name) => isUnsupportedTlsOption(name, options[name])) : [])
  ];
  return {
    method,
    host,
    port,
    ...(typeof options.socketPath === 'string' ? { socketPath: options.socketPath } : {}),
    path: path.startsWith('/') ? path : `/${path}`,
    headers,
    unsupportedTransportOptions
  };
}

function isUnsupportedSocketOption(name: string, value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (name === 'socketPath') return typeof value !== 'string';
  if (name !== 'agent') return true;
  return !isObjectRecord(value) || typeof value.addRequest !== 'function';
}

function isUnsupportedTlsOption(name: string, value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (name === 'rejectUnauthorized' && value === true) return false;
  return true;
}

// Outbound requests to hosts outside Virtual Network travel over browser
// Fetch, which owns these request headers and rejects a caller's value for
// them. Node would send them verbatim; the closest behaviour Fetch allows is
// to send the request without them rather than fail it, so the browser's own
// value (or none) reaches the remote server:
// - `cookie`: requests use `credentials: 'omit'`, so no cookie is sent.
// - `origin`, `referer`: the browser states the embedding page's origin; the
//   request uses `referrerPolicy: 'no-referrer'`.
// - `expect`: Fetch never waits for `100 Continue`; the request emits
//   `continue` locally so a caller waiting for it still sends its body.
// - `accept-encoding`, `accept-charset`, `date`, `dnt`, `keep-alive`, `te`,
//   `trailer`, `via`, `permissions-policy`, `access-control-request-*`,
//   `proxy-*`, `sec-*`: negotiated or stated by the browser.
// `upgrade` and a non-chunked `transfer-encoding` change the protocol or the
// body itself, so they stay unsupported instead of being dropped.
const browserOwnedRequestHeaders = new Set([
  'accept-charset',
  'accept-encoding',
  'access-control-request-headers',
  'access-control-request-method',
  'cookie',
  'date',
  'dnt',
  'expect',
  'keep-alive',
  'origin',
  'permissions-policy',
  'referer',
  'te',
  'trailer',
  'via'
]);

// A request header outside the CORS-safelisted set makes the browser ask the
// destination's permission with a preflight first. Public servers that serve
// credential-free GET and HEAD requests to any origin, the npm registry among
// them, do not answer preflights, so with such a header they cannot be reached
// at all. A credential-free GET or HEAD to another origin is therefore sent as
// a CORS-simple request, without those headers (for npm: `user-agent`,
// `npm-command`, `npm-session`, `pacote-*`). A request that carries
// `authorization` keeps every header and needs the destination's approval.
export function corsSimpleRequestHeaders(
  method: string,
  url: string,
  headers: readonly [string, string][]
): [string, string][] {
  if (method !== 'GET' && method !== 'HEAD') return [...headers];
  if (headers.some(([name]) => name === 'authorization' || name === 'proxy-authorization')) return [...headers];
  const origin = (globalThis as { location?: { origin?: string } }).location?.origin;
  if (origin !== undefined && new URL(url).origin === origin) return [...headers];
  return headers.filter(([name, value]) => isCorsSafelistedRequestHeader(name, value));
}

function isCorsSafelistedRequestHeader(name: string, value: string): boolean {
  if (value.length > 128) return false;
  if (name === 'range') return /^bytes=\d+-\d*$/u.test(value);
  if (name === 'content-type') {
    return ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(
      value.split(';', 1)[0]!.trim().toLowerCase()
    );
  }
  if (name === 'accept') return !/[\u0000-\u0008\u000a-\u001f"():<>?@[\\\]{}\u007f]/u.test(value);
  if (name === 'accept-language' || name === 'content-language') return /^[0-9A-Za-z *,\-.;=]*$/u.test(value);
  return false;
}

function browserFetchHeaders(
  headers: ReadonlyMap<string, string>,
  host: string,
  port: number,
  bodyLength: number
): [string, string][] {
  const output: [string, string][] = [];
  for (const [name, value] of headers) {
    if (browserOwnedRequestHeaders.has(name) || name.startsWith('proxy-') || name.startsWith('sec-')) continue;
    if (name === 'upgrade') {
      throw unsupportedBrowserTransport(`HTTP header "${name}" cannot be represented by browser Fetch.`);
    }
    if (name === 'transfer-encoding') {
      // The buffered body is re-framed by Fetch, so chunked framing is moot.
      if (httpHeaderTokens(value).every((token) => token === 'chunked')) continue;
      throw unsupportedBrowserTransport(`HTTP header "${name}" cannot be represented by browser Fetch.`);
    }
    if (name === 'host') {
      if (!matchesHttpAuthority(value, host, port)) {
        throw unsupportedBrowserTransport('HTTP header "host" does not match the outbound destination.');
      }
      continue;
    }
    if (name === 'connection') {
      const preference = value.trim().toLowerCase();
      if (preference !== 'close' && preference !== 'keep-alive') {
        throw unsupportedBrowserTransport('HTTP header "connection" cannot be represented by browser Fetch.');
      }
      continue;
    }
    if (name === 'content-length') {
      if (!/^\d+$/u.test(value.trim()) || Number(value) !== bodyLength) {
        throw unsupportedBrowserTransport('HTTP Content-Length does not match the supplied request body.');
      }
      continue;
    }
    output.push([name, value]);
  }
  return output;
}

function matchesHttpAuthority(header: string, host: string, port: number): boolean {
  const normalized = header.toLowerCase();
  return normalized === host.toLowerCase() || normalized === `${host}:${port}`.toLowerCase();
}

function httpUrl(protocol: 'http' | 'https', host: string, port: number, path: string): string {
  const defaultPort = protocol === 'https' ? 443 : 80;
  return `${protocol}://${host}${port === defaultPort ? '' : `:${port}`}${path}`;
}

function requestBody(bytes: Uint8Array): ArrayBuffer {
  // `Uint8Array.from` copies; a Buffer `slice()` is a view whose `.buffer` is the whole parent.
  return Uint8Array.from(bytes).buffer;
}

function unsupportedBrowserTransport(message: string): Error {
  return Object.assign(new Error(message), { code: 'ENOTSUP' });
}

function browserFetchError(reason: unknown): Error {
  return unsupportedBrowserTransport(
    `Browser Fetch failed: ${reason instanceof Error ? reason.message : String(reason)}`
  );
}

function serializeHttpClientRequestHead(
  method: string,
  path: string,
  host: string,
  port: number,
  requestHeaders: Map<string, string>
): Uint8Array {
  const headers = new Map(requestHeaders);
  headers.set('host', headers.get('host') ?? `${host}:${port}`);
  headers.set('connection', headers.get('connection') ?? 'close');
  return serializeHttp1RequestHead({ method, path, headers: [...headers] });
}

export function createHttpBuiltin(
  protocol: 'http' | 'https',
  net: VirtualNetBuiltin,
  listenerClaims?: HttpListenerClaims,
  requestLifecycle?: ProcessExecutionActivityLifecycle,
  browserFetch?: NodeCompatibilityFetch,
  registerResource?: (dispose: () => void) => () => void
): unknown {
  const unsupported = () => Object.assign(new Error(`${protocol} networking is not supported in the browser runtime yet`), { code: 'ENOTSUP' });
  class IncomingMessage extends stream.Readable {
    private static readonly consumerIntentTimeoutMs = 30_000;
    headers: IncomingHttpHeaders = {};
    rawHeaders: string[] = [];
    trailers: Record<string, string> = {};
    rawTrailers: string[] = [];
    httpVersion = '1.1';
    httpVersionMajor = 1;
    httpVersionMinor = 1;
    method = 'GET';
    url = '/';
    statusCode?: number;
    statusMessage?: string;
    socket?: VirtualNetSocket;
    complete = false;
    aborted = false;

    /** Node's older name for `socket`. */
    get connection(): VirtualNetSocket | undefined {
      return this.socket;
    }

    set connection(socket: VirtualNetSocket | undefined) {
      this.socket = socket;
    }
    private consuming = false;
    private consumptionIntentDeclared = false;
    private consumptionIntentTimeout?: ReturnType<typeof globalThis.setTimeout>;

    /** Asks the body's source for more once the handler has read what it holds. */
    private pullBody?: () => void;

    constructor(
      private readonly onConsumptionStart?: () => void,
      private readonly onConsumptionAbandoned?: () => void
    ) {
      super({
        read() {
          (this as IncomingMessage).pullBody?.();
        },
        destroy(error, callback) {
          const response = this as IncomingMessage;
          if (response.aborted) response.emit('aborted');
          callback(error);
        }
      });
    }

    override on(event: string | symbol, listener: EventListener): this {
      if (event === 'readable') this.declareConsumptionIntent();
      else if (event === 'data') this.startConsuming();
      super.on(event, listener);
      return this;
    }

    override read(size?: number): unknown {
      // The stream calls `read(0)` itself to refill its buffer; only a program's read consumes.
      if (size !== 0) this.startConsuming();
      return super.read(size);
    }

    override destroy(error?: Error): this {
      if (this.destroyed) return this;
      this.aborted = !this.readableEnded;
      this.clearConsumptionIntentTimeout();
      // Node surfaces a message's destroy error only to code that listens for
      // it; a peer that disconnects must not turn into an unhandled error.
      return super.destroy(error && this.listenerCount('error') > 0 ? error : undefined) as this;
    }

    receiveBodyChunk(bytes: Uint8Array): void {
      if (this.destroyed || this.complete || bytes.byteLength === 0) return;
      this.push(BrowserBuffer.from(bytes));
    }

    /** Reads a structured body with backpressure: a full buffer waits for the handler. */
    async receiveBodyStream(body: ReadableStream<Uint8Array>): Promise<void> {
      const reader = body.getReader();
      this.once('close', () => this.pullBody?.());
      try {
        while (!this.destroyed) {
          const { value, done } = await reader.read();
          if (done) {
            this.endBody();
            return;
          }
          if (this.destroyed || this.complete || value.byteLength === 0) continue;
          if (this.push(BrowserBuffer.from(value))) continue;
          await new Promise<void>((resolve) => {
            this.pullBody = resolve;
          });
          this.pullBody = undefined;
        }
        await reader.cancel().catch(() => undefined);
      } catch (error) {
        if (!this.destroyed) {
          this.destroy(
            Object.assign(new Error('Premature close while reading HTTP request'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE',
              cause: error
            })
          );
        }
      } finally {
        reader.releaseLock();
      }
    }

    endBody(): void {
      if (this.destroyed || this.complete) return;
      this.complete = true;
      this.push(null);
    }

    hasStartedConsuming(): boolean {
      return this.consuming || this.consumptionIntentDeclared;
    }

    override [Symbol.asyncIterator](): AsyncIterableIterator<unknown> {
      this.startConsuming();
      return super[Symbol.asyncIterator]();
    }

    private startConsuming(): void {
      if (this.consuming) return;
      this.consuming = true;
      this.consumptionIntentDeclared = true;
      this.clearConsumptionIntentTimeout();
      this.onConsumptionStart?.();
    }

    private declareConsumptionIntent(): void {
      if (this.consuming || this.consumptionIntentDeclared) return;
      this.consumptionIntentDeclared = true;
      this.consumptionIntentTimeout = globalThis.setTimeout(() => {
        this.consumptionIntentTimeout = undefined;
        if (this.consuming || this.destroyed) return;
        this.consumptionIntentDeclared = false;
        this.onConsumptionAbandoned?.();
      }, IncomingMessage.consumerIntentTimeoutMs);
    }

    private clearConsumptionIntentTimeout(): void {
      if (this.consumptionIntentTimeout === undefined) return;
      globalThis.clearTimeout(this.consumptionIntentTimeout);
      this.consumptionIntentTimeout = undefined;
    }

  }
  // Where a response goes: onto an HTTP/1 connection, which frames it, or to
  // a structured exchange, which carries its parts as they are.
  type ServerResponseWriter = {
    readonly requestMethod: string;
    writeHead(): void;
    writeInformational(status: number, statusText: string, headers: readonly [string, string][]): void;
    writeBody(chunk: Uint8Array, callback: (error?: Error) => void): void;
    end(trailers: readonly [string, string][]): void;
    abort(): void;
  };
  class ServerResponse extends stream.Writable {
    private responseStatusCode = 200;
    private explicitStatusMessage?: string;
    headers: Record<string, string | number | string[]> = {};
    headersSent = false;
    finished = false;
    private responseEnded = false;
    private readonly trailers = new Map<string, string>();
    private readonly streamWriter?: ServerResponseWriter;
    /** The request this response answers, and the socket it arrived on. */
    req?: IncomingMessage;
    socket?: VirtualNetSocket;

    constructor(streamWriter?: ServerResponseWriter) {
      super({
        highWaterMark: 16 * 1024,
        write(chunk, _encoding, callback) {
          (this as ServerResponse).writeResponseChunk(chunk, callback);
        },
        final(callback) {
          (this as ServerResponse).finishResponse();
          callback();
        },
        destroy(error, callback) {
          (this as ServerResponse).abortResponse();
          callback(error);
        }
      });
      this.streamWriter = streamWriter;
    }

    /** Node's older name for `socket`. */
    get connection(): VirtualNetSocket | undefined {
      return this.socket;
    }

    /**
     * Node's internal header state, which `express-session`, `compression`
     * and `on-headers` read and drive: the head once it is written, and a way
     * to write it with the current status.
     */
    get _header(): string | null {
      return this.headersSent ? `HTTP/1.1 ${this.statusCode} ${this.statusMessage}\r\n` : null;
    }

    get _headerSent(): boolean {
      return this.headersSent;
    }

    _implicitHeader(): void {
      this.writeHead(this.statusCode);
    }

    get statusCode(): number {
      return this.responseStatusCode;
    }

    set statusCode(value: number) {
      this.responseStatusCode = value;
    }

    get statusMessage(): string {
      return this.explicitStatusMessage ?? HttpStatusCodes[this.responseStatusCode] ?? 'unknown';
    }

    set statusMessage(value: string) {
      this.explicitStatusMessage = value;
    }

    override write(chunk?: unknown, encoding?: unknown, callback?: (error?: Error) => void): boolean {
      if (!this.destroyed || this.writableEnded) return super.write(chunk, encoding, callback);
      // Node reports a write to a disconnected response through the write
      // callback only; a handler that keeps streaming must not crash on it.
      const resolvedCallback = typeof encoding === 'function' ? (encoding as (error?: Error) => void) : callback;
      if (resolvedCallback) {
        queueMicrotask(() =>
          resolvedCallback(
            Object.assign(new Error('Cannot call write after a stream was destroyed'), { code: 'ERR_STREAM_DESTROYED' })
          )
        );
      }
      return false;
    }

    override end(chunk?: unknown, encoding?: unknown, callback?: () => void): this {
      if (this.destroyed && !this.writableEnded) return this;
      if (!this.writableEnded) {
        this.setImplicitContentLength(typeof chunk === 'function' ? undefined : chunk);
        this.finished = true;
      }
      return super.end(chunk, encoding, callback) as this;
    }

    writeHead(
      statusCode: number,
      statusMessageOrHeaders?: string | Record<string, string | number | string[]>,
      headers?: Record<string, string | number | string[]>
    ): this {
      this.statusCode = statusCode;
      if (typeof statusMessageOrHeaders === 'string') this.statusMessage = statusMessageOrHeaders;
      const resolvedHeaders = typeof statusMessageOrHeaders === 'string' ? headers : statusMessageOrHeaders;
      if (resolvedHeaders) {
        for (const [name, value] of Object.entries(resolvedHeaders)) this.setHeader(name, value);
      }
      this.headersSent = true;
      return this;
    }

    setHeader(name: string, value: string | number | string[]): void {
      this.headers[name.toLowerCase()] = value;
    }

    getHeader(name: string): string | number | string[] | undefined {
      return this.headers[name.toLowerCase()];
    }

    getHeaders(): Record<string, string | number | string[]> {
      return { ...this.headers };
    }

    getHeaderNames(): string[] {
      return Object.keys(this.headers);
    }

    hasHeader(name: string): boolean {
      return Object.prototype.hasOwnProperty.call(this.headers, name.toLowerCase());
    }

    removeHeader(name: string): void {
      delete this.headers[name.toLowerCase()];
    }

    appendHeader(name: string, value: string | number | string[]): void {
      const key = name.toLowerCase();
      const current = this.headers[key];
      if (current === undefined) {
        this.headers[key] = value;
        return;
      }
      this.headers[key] = [...arrayHeader(current), ...arrayHeader(value)];
    }

    addTrailers(headers: Record<string, string | number | string[]>): void {
      for (const [name, value] of Object.entries(headers)) {
        this.trailers.set(name.toLowerCase(), arrayHeader(value).join(', '));
      }
    }

    writeContinue(callback?: () => void): void {
      this.streamWriter?.writeInformational(100, 'Continue', []);
      callback?.();
    }

    writeProcessing(): void {
      this.streamWriter?.writeInformational(102, 'Processing', []);
    }

    writeEarlyHints(
      hints: Record<string, string | string[]>,
      callback?: () => void
    ): void {
      this.streamWriter?.writeInformational(
        103,
        'Early Hints',
        Object.entries(hints).flatMap(([name, value]) =>
          (Array.isArray(value) ? value : [value]).map((item) => [name.toLowerCase(), item] as [string, string])
        )
      );
      callback?.();
    }

    flushHeaders(): void {
      this.headersSent = true;
      this.streamWriter?.writeHead();
    }

    private writeResponseChunk(chunk: unknown, callback: (error?: Error | null) => void): void {
      this.headersSent = true;
      if (chunk !== undefined) {
        const bytes = toHttpBytes(chunk);
        this.streamWriter?.writeHead();
        if (this.streamWriter && bytes.byteLength > 0) this.streamWriter.writeBody(bytes, callback);
        else globalThis.setTimeout(callback, 0);
      } else callback();
    }

    private finishResponse(): void {
      this.headersSent = true;
      this.finished = true;
      this.responseEnded = true;
      this.streamWriter?.writeHead();
      this.streamWriter?.end([...this.trailers]);
    }

    // Runs for every destroy, including the automatic one after `finish`;
    // only a response that never completed takes its connection down.
    private abortResponse(): void {
      if (!this.responseEnded) this.streamWriter?.abort();
    }

    // Node frames a response whose only body is the `end()` argument with
    // Content-Length, which also lets the connection outlive the response.
    private setImplicitContentLength(chunk: unknown): void {
      if (!this.streamWriter || this.headersSent || this.trailers.size > 0) return;
      if (this.hasHeader('content-length') || this.hasHeader('transfer-encoding')) return;
      const status = this.responseStatusCode;
      if (this.streamWriter.requestMethod === 'HEAD' || status < 200 || status === 204 || status === 304) return;
      this.setHeader('content-length', chunk === undefined ? 0 : toHttpBytes(chunk).byteLength);
    }
  }
  class Server extends EventEmitter {
    listening = false;
    timeout = 0;
    keepAliveTimeout = 5_000;
    private host = '127.0.0.1';
    private port = 0;
    private socketServer?: VirtualNetServer;
    private pipe: string | undefined;
    private closing = false;
    private readonly idleSockets = new Set<VirtualNetSocket>();
    /** Every connection open to this server, for `closeAllConnections()`. */
    private readonly connections = new Set<VirtualNetSocket>();
    private readonly closeCallbacks: Array<(error?: Error) => void> = [];

    constructor(listener?: EventListener) {
      super();
      if (listener) this.on('request', listener);
    }

    listen(...args: unknown[]): this {
      if (protocol === 'https') throw unsupported();
      const callback = args.find((arg): arg is () => void => typeof arg === 'function');
      const options = args.find(
        (arg): arg is { host?: unknown; port?: unknown } => Boolean(arg) && typeof arg === 'object'
      );
      // Node's positional overload is listen(port, host?, backlog?, callback?);
      // a numeric string is a port and any other leading string is a pipe name.
      const positionalPort = typeof args[0] === 'number' || typeof args[0] === 'string' ? args[0] : undefined;
      const pipe =
        options && typeof (options as { path?: unknown }).path === 'string' ? (options as { path: string }).path
          : !options && typeof positionalPort === 'string' && !/^\d+$/u.test(positionalPort) ? positionalPort
            : undefined;
      if (pipe !== undefined) return this.listenOnPipe(pipe, callback);
      const port = options ? options.port : positionalPort;
      this.port = port === undefined || port === null ? 0 : Number(port);
      if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535) {
        throw Object.assign(new RangeError(`options.port should be >= 0 and < 65536. Received ${String(port)}.`), {
          code: 'ERR_SOCKET_BAD_PORT'
        });
      }
      const host = options ? options.host : positionalPort === undefined ? undefined : args[1];
      this.host = typeof host === 'string' && host.length > 0 ? host : '127.0.0.1';
      const socketServer = net.createServer(
        { allowHalfOpen: true },
        (socket: unknown) => this.handleSocketConnection(socket as VirtualNetSocket)
      );
      (socketServer as { [NET_SERVER_OWNER]?: NetServerOwner })[NET_SERVER_OWNER] = {
        server: this,
        host: typeof host === 'string' && host.length > 0 ? host : null
      };
      this.socketServer = socketServer;
      socketServer.on('error', (error) => {
        this.emit('error', error);
        if (!this.listening && this.socketServer === socketServer) {
          this.socketServer = undefined;
          if (this.closing) this.completeClose();
        }
      });
      socketServer.on('listening', () => {
        if (this.socketServer !== socketServer) return;
        const address = socketServer.address();
        this.port = typeof address === 'object' && address !== null ? address.port : this.port;
        if (this.closing) {
          socketServer.close();
          this.socketServer = undefined;
          this.completeClose();
          return;
        }
        this.listening = true;
        listenerClaims?.claim(this.port, {
          address: { host: this.host, port: this.port },
          serveHttp: (request, options) => this.serveExchange(request, options.signal),
          openWebSocket: (request, observer) => this.openExchangeWebSocket(request, observer),
          close: () => {
            this.listening = false;
            socketServer.close();
          }
        });
        callback?.call(this);
        this.emit('listening');
      });
      if (options) socketServer.listen({ ...options, host: this.bindHost(), port: this.port });
      else socketServer.listen(this.port, this.bindHost());
      return this;
    }

    /**
     * A server on a Unix domain socket: processes of the container reach it
     * by its path, and it is not published, since no browser URL names a path.
     */
    private listenOnPipe(path: string, callback: (() => void) | undefined): this {
      const socketServer = net.createServer(
        { allowHalfOpen: true },
        (socket: unknown) => this.handleSocketConnection(socket as VirtualNetSocket)
      );
      (socketServer as { [NET_SERVER_OWNER]?: NetServerOwner })[NET_SERVER_OWNER] = { server: this, host: null };
      this.socketServer = socketServer;
      this.pipe = path;
      socketServer.on('error', (error) => {
        this.emit('error', error);
        if (!this.listening && this.socketServer === socketServer) this.socketServer = undefined;
      });
      socketServer.on('listening', () => {
        if (this.socketServer !== socketServer) return;
        const address = socketServer.address();
        if (typeof address === 'string') this.pipe = address;
        this.listening = true;
        callback?.call(this);
        this.emit('listening');
      });
      socketServer.listen(path);
      return this;
    }

    // Virtual Network has one wildcard address; Node's dual-stack `::`
    // listener accepts the same loopback connections, so it binds there.
    private bindHost(): string {
      return this.host === '::' ? '0.0.0.0' : this.host;
    }

    // Published Endpoint exchanges enter through the listener's own address.
    private dialHost(): string {
      const host = this.bindHost();
      return host === '0.0.0.0' ? '127.0.0.1' : host;
    }

    close(callback?: (error?: Error) => void): this {
      if (callback) this.closeCallbacks.push(callback);
      this.closing = true;
      const socketServer = this.socketServer;
      if (socketServer && !this.listening) return this;

      const wasListening = this.listening;
      this.listening = false;
      const completeClose = wasListening && this.pipe === undefined ? listenerClaims?.release(this.port) : undefined;
      socketServer?.close();
      this.socketServer = undefined;
      this.closeIdleConnections();
      this.completeClose(completeClose);
      return this;
    }

    closeIdleConnections(): void {
      for (const socket of [...this.idleSockets]) socket.destroy();
    }

    /** Node's `server.closeAllConnections()`: destroys every open connection, active or idle. */
    closeAllConnections(): void {
      for (const socket of [...this.connections]) socket.destroy();
    }

    private trackConnection(socket: VirtualNetSocket): void {
      this.connections.add(socket);
      socket.once('close', () => this.connections.delete(socket));
    }

    private completeClose(completeBridgeClose?: void | (() => void)): void {
      const callbacks = this.closeCallbacks.splice(0);
      this.closing = false;
      globalThis.setTimeout(() => {
        try {
          for (const callback of callbacks) callback();
          this.emit('close');
        } finally {
          if (completeBridgeClose) completeBridgeClose();
        }
      }, 0);
    }

    address(): { address: string; family: string; port: number } | string | null {
      if (!this.listening) return null;
      if (this.pipe !== undefined) return this.pipe;
      return boundAddress(this.host, this.port);
    }

    setTimeout(timeout: number, callback?: () => void): this {
      if (!Number.isFinite(timeout) || timeout < 0) throw new RangeError(`Invalid server timeout: ${timeout}`);
      this.timeout = timeout;
      if (callback) this.on('timeout', callback);
      return this;
    }

    ref(): this {
      return this;
    }

    unref(): this {
      return this;
    }

    // A structured exchange has no byte stream of its own; its socket is a
    // connection that carries nothing but its lifetime, so `close` reports a
    // client that went away. Bytes a handler writes to it are not part of the
    // response and are discarded.
    private openExchangeSocket(sink: ExchangeConnectionSink): {
      readonly socket: VirtualNetSocket;
      readonly connection: ExchangeConnection;
    } {
      const connection = new ExchangeConnection(
        { host: this.dialHost(), port: this.port },
        sink
      );
      const socket = new net.Socket();
      socket.attach(connection);
      this.trackConnection(socket);
      return { socket, connection };
    }

    private exchangeRequest(request: PublishedHttpRequest, socket: VirtualNetSocket): IncomingMessage {
      const message = new IncomingMessage();
      message.method = request.method;
      message.url = request.url;
      message.headers = incomingHttpHeaders(request.headers);
      message.rawHeaders = rawHttpHeaders(request.headers);
      message.socket = socket;
      return message;
    }

    private serveExchange(
      exchange: PublishedHttpRequest,
      signal: AbortSignal | undefined
    ): Promise<PublishedHttpResponse> {
      return new Promise<PublishedHttpResponse>((resolve, reject) => {
        const { socket, connection } = this.openExchangeSocket(discardedExchangeBytes);
        const request = this.exchangeRequest(exchange, socket);
        const informational: number[] = [];
        let headResolved = false;
        let bodyController!: ReadableStreamDefaultController<Uint8Array>;
        let bodyClosed = false;
        let pendingWrite: (() => void) | undefined;
        const releaseWrite = () => {
          const callback = pendingWrite;
          pendingWrite = undefined;
          callback?.();
        };
        const body = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              bodyController = controller;
            },
            pull: releaseWrite,
            cancel: () => {
              settleBody(() => undefined);
              disconnect();
            }
          },
          new ByteLengthQueuingStrategy({ highWaterMark: 64 * 1024 })
        );
        const settleBody = (operation: () => void) => {
          if (bodyClosed) return;
          bodyClosed = true;
          operation();
          releaseWrite();
        };
        // The client is gone: the request and response close as they would
        // when a connection drops, and a head that never came rejects.
        const disconnect = () => {
          signal?.removeEventListener('abort', abort);
          connection.close();
          settleBody(() => bodyController.error(new Error('Published HTTP exchange was cancelled.')));
          if (!headResolved) reject(new Error('Published HTTP exchange was cancelled.'));
        };
        const abort = () => disconnect();
        const response = new ServerResponse({
          requestMethod: request.method,
          writeHead: () => {
            if (headResolved) return;
            headResolved = true;
            resolve({
              status: response.statusCode,
              statusText: response.statusMessage,
              headers: responseHeaderList(response.headers),
              informational,
              body
            });
          },
          // `100 Continue` asks a connection for the body; a structured
          // request already carries it as a stream.
          writeInformational: (status) => {
            if (status !== 100 && !headResolved) informational.push(status);
          },
          writeBody: (chunk, callback) => {
            if (bodyClosed) {
              callback();
              return;
            }
            if (request.method !== 'HEAD') bodyController.enqueue(chunk.slice());
            if ((bodyController.desiredSize ?? 0) > 0) queueMicrotask(() => callback());
            else pendingWrite = () => callback();
          },
          end: (trailers) => {
            signal?.removeEventListener('abort', abort);
            settleBody(() => {
              if (trailers.length === 0) bodyController.close();
              else bodyController.error(new Error('A published HTTP response cannot carry trailers.'));
            });
            // The exchange is over; its connection closes after the turn the
            // response's acknowledged writes need to finish.
            globalThis.setTimeout(() => connection.close(), 0);
          },
          abort: disconnect
        });
        socket.once('close', () => {
          if (!request.destroyed) {
            request.destroy(
              request.complete ? undefined : Object.assign(new Error('aborted'), { code: 'ECONNRESET' })
            );
          }
          closeResponseWithConnection(response);
        });
        signal?.addEventListener('abort', abort, { once: true });
        if (signal?.aborted) {
          disconnect();
          return;
        }
        if (exchange.body) void request.receiveBodyStream(exchange.body);
        else request.endBody();
        this.dispatchRequest(request, response);
      });
    }

    private openExchangeWebSocket(
      exchange: PublishedHttpRequest,
      observer: PublishedEndpointWebSocketConnectionObserver
    ): PublishedEndpointWebSocketConnection {
      let head: Uint8Array | undefined = new Uint8Array();
      let closed = false;
      const finish = () => {
        if (closed) return;
        closed = true;
        observer.onClose();
      };
      // After `upgrade` the program owns the socket's bytes: they start with
      // its HTTP/1 response head, which decides whether the WebSocket opened.
      // The bytes after a 101 head are the server's frames; the observer
      // holds the program's writes while the client has not read them.
      const { socket, connection } = this.openExchangeSocket({
        write: (bytes) => {
          if (closed) return true;
          if (!head) return observer.onData(bytes);
          head = concatBytes([head, bytes]);
          let parsed: ReturnType<typeof parseHttp1ResponseHead>;
          try {
            parsed = parseHttp1ResponseHead(head);
          } catch {
            connection.close();
            return true;
          }
          if (!parsed) return true;
          const rest = head.slice(parsed.bodyStart);
          head = undefined;
          observer.onHead({
            status: parsed.status,
            statusText: parsed.statusText || HttpStatusCodes[parsed.status] || '',
            headers: parsed.headers.map(([name, value]) => [name, value] as [string, string])
          });
          if (parsed.status !== 101) {
            connection.close();
            return true;
          }
          return rest.byteLength > 0 ? observer.onData(rest) : true;
        },
        end: () => observer.onEnd(),
        close: finish
      });
      const request = this.exchangeRequest(exchange, socket);
      request.endBody();
      // A server that `close()` was called on accepts no new connection, as in
      // Node, though its publication may still route one to it.
      if (!this.listening || this.listenerCount('upgrade') === 0) connection.close();
      else this.emit('upgrade', request, socket, BrowserBuffer.alloc(0));
      return {
        send(bytes, delivered) {
          if (!closed) connection.receive(bytes, delivered);
        },
        resume: () => connection.drain(),
        end: () => connection.receiveEnd(),
        close: () => connection.close()
      };
    }

    private handleSocketConnection(socket: VirtualNetSocket): void {
      this.trackConnection(socket);
      type Exchange = {
        readonly request: IncomingMessage;
        response?: ServerResponse;
        remainingBodyBytes: number;
        chunkedBody?: HttpWireChunkBodyDecoder;
        readonly keepAlive: boolean;
        persistent: boolean;
      };
      let pending: Uint8Array = new Uint8Array();
      let exchange: Exchange | undefined;
      let starting = false;
      let finishedWhileStarting = false;
      let detached = false;
      let inputEnded = false;
      let closed = false;
      let idleTimer: ReturnType<typeof globalThis.setTimeout> | undefined;
      const leaveIdle = () => {
        this.idleSockets.delete(socket);
        if (idleTimer === undefined) return;
        globalThis.clearTimeout(idleTimer);
        idleTimer = undefined;
      };
      const abortActiveRequest = (error?: Error) => {
        const activeRequest = exchange?.request;
        if (!activeRequest || activeRequest.destroyed) return;
        const normalized = error ?? Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        activeRequest.destroy(activeRequest.complete && error === undefined ? undefined : normalized);
      };
      const deliverWireBodyBytes = (bytes: Uint8Array) => {
        if (!exchange) return;
        if (exchange.chunkedBody) {
          try {
            exchange.chunkedBody.push(bytes);
          } catch (error) {
            abortActiveRequest(error instanceof Error ? error : new Error(String(error)));
            socket.destroy();
          }
          return;
        }
        const acceptedLength = Math.min(bytes.byteLength, exchange.remainingBodyBytes);
        if (acceptedLength > 0) {
          exchange.request.receiveBodyChunk(bytes.slice(0, acceptedLength));
          exchange.remainingBodyBytes -= acceptedLength;
        }
        if (exchange.remainingBodyBytes === 0) exchange.request.endBody();
        // Bytes past the declared body belong to the next request on a
        // persistent connection.
        if (acceptedLength < bytes.byteLength) pending = concatBytes([pending, bytes.slice(acceptedLength)]);
      };
      const rejectRequestHead = (status: 400 | 431, error: Error) => {
        detached = true;
        pending = new Uint8Array();
        if (this.listenerCount('clientError') > 0) {
          this.emit('clientError', error, socket);
          return;
        }
        socket.end(
          serializeHttp1ResponseHead({
            status,
            statusText: HttpStatusCodes[status] ?? '',
            headers: [['connection', 'close']]
          })
        );
      };
      const finishExchange = () => {
        if (starting) {
          finishedWhileStarting = true;
          return;
        }
        const finished = exchange;
        if (!finished?.persistent || !finished.request.complete || inputEnded || closed) {
          socket.end();
          return;
        }
        abortActiveRequest();
        exchange = undefined;
        this.idleSockets.add(socket);
        if (this.keepAliveTimeout > 0) idleTimer = globalThis.setTimeout(() => socket.end(), this.keepAliveTimeout);
        if (pending.byteLength > 0) startExchange();
      };
      const startExchange = () => {
        if (exchange || detached || closed) return;
        let parsedHead: Http1RequestHead | undefined;
        try {
          parsedHead = parseHttp1RequestHead(pending);
        } catch (error) {
          rejectRequestHead(400, error instanceof Error ? error : new Error(String(error)));
          return;
        }
        if (!parsedHead) {
          if (pending.byteLength > maxHttpHeaderSize) {
            rejectRequestHead(
              431,
              Object.assign(new Error('Parse Error: Header overflow'), { code: 'HPE_HEADER_OVERFLOW' })
            );
          }
          return;
        }
        leaveIdle();
        const body = pending.slice(parsedHead.bodyStart);
        pending = new Uint8Array();
        const request = this.createIncomingRequest(parsedHead, socket);
        if (parsedHead.upgrade) {
          detached = true;
          if (this.listenerCount('upgrade') === 0) {
            socket.destroy();
            return;
          }
          this.emit('upgrade', request, socket, BrowserBuffer.from(body));
          return;
        }
        const active: Exchange = {
          request,
          remainingBodyBytes: parsedHead.chunked ? 0 : parsedHead.contentLength,
          // A chunked request body does not report where the next request
          // starts, so only length-delimited requests may share a connection.
          keepAlive: !parsedHead.chunked && requestAllowsKeepAlive(parsedHead),
          persistent: false
        };
        exchange = active;
        starting = true;
        finishedWhileStarting = false;
        active.response = this.dispatchNodeRequestToSocket(request, socket, {
          keepAlive: active.keepAlive,
          isClosed: () => closed,
          onHead: (persistent) => {
            active.persistent = persistent;
          },
          onEnd: finishExchange
        });
        if (parsedHead.chunked) {
          active.chunkedBody = new HttpWireChunkBodyDecoder(
            (bodyChunk) => request.receiveBodyChunk(bodyChunk),
            (trailers) => {
              request.trailers = Object.fromEntries(trailers);
              request.rawTrailers = trailers.flatMap(([name, value]) => [name, value]);
            },
            () => request.endBody()
          );
        }
        deliverWireBodyBytes(body);
        starting = false;
        if (finishedWhileStarting) finishExchange();
      };
      socket.on('data', (chunk) => {
        if (detached) return;
        const bytes = toHttpBytes(chunk);
        if (exchange && !exchange.request.complete && !exchange.request.destroyed) {
          deliverWireBodyBytes(bytes);
          return;
        }
        // Only a connection that may persist keeps bytes for a later request.
        if (exchange && !exchange.keepAlive) return;
        pending = concatBytes([pending, bytes]);
        startExchange();
      });
      socket.once('end', () => {
        inputEnded = true;
        const activeRequest = exchange?.request;
        if (!exchange || !activeRequest) {
          if (detached) return;
          leaveIdle();
          // The peer finished without an exchange in flight: an idle
          // persistent connection closes, a truncated request head is malformed.
          if (pending.byteLength > 0) {
            rejectRequestHead(
              400,
              Object.assign(new Error('Parse Error: Incomplete request head'), { code: 'HPE_INVALID_EOF_STATE' })
            );
          } else socket.end();
          return;
        }
        if (activeRequest.complete || activeRequest.destroyed) return;
        if (exchange.chunkedBody) {
          if (exchange.chunkedBody.complete) {
            activeRequest.endBody();
            return;
          }
          abortActiveRequest(
            Object.assign(new Error('Premature close while reading chunked HTTP request'), {
              code: 'ERR_STREAM_PREMATURE_CLOSE'
            })
          );
          socket.destroy();
          return;
        }
        if (exchange.remainingBodyBytes === 0) {
          activeRequest.endBody();
          return;
        }
        abortActiveRequest(
          Object.assign(new Error('Premature close while reading HTTP request'), { code: 'ERR_STREAM_PREMATURE_CLOSE' })
        );
        socket.destroy();
      });
      socket.once('error', (error) => abortActiveRequest(error instanceof Error ? error : new Error(String(error))));
      socket.once('close', () => {
        closed = true;
        leaveIdle();
        abortActiveRequest();
        // A client that disconnects closes the response as well as the
        // request, which is how long-lived handlers learn to stop writing.
        const response = exchange?.response;
        if (response) closeResponseWithConnection(response);
      });
    }

    private createIncomingRequest(head: Http1RequestHead, socket: VirtualNetSocket): IncomingMessage {
      const request = this.exchangeRequest({ method: head.method, url: head.path, headers: head.headers }, socket);
      const version = /^HTTP\/(\d)\.(\d)$/u.exec(head.version);
      if (version) {
        request.httpVersionMajor = Number(version[1]);
        request.httpVersionMinor = Number(version[2]);
        request.httpVersion = `${version[1]}.${version[2]}`;
      }
      return request;
    }

    private dispatchNodeRequestToSocket(
      request: IncomingMessage,
      socket: VirtualNetSocket,
      connection: {
        readonly keepAlive: boolean;
        isClosed(): boolean;
        onHead(persistent: boolean): void;
        onEnd(): void;
      }
    ): ServerResponse {
      let headWritten = false;
      let chunked = false;
      let response!: ServerResponse;
      const writeHead = () => {
        if (headWritten) return;
        headWritten = true;
        const head = serializeHttpServerResponseHead(response, {
          keepAlive: connection.keepAlive && request.method !== 'HEAD',
          keepAliveTimeout: this.keepAliveTimeout
        });
        chunked = httpHeaderTokens(response.getHeader('transfer-encoding')).includes('chunked');
        connection.onHead(head.persistent);
        socket.write(head.bytes);
      };
      // The response has no deadline: it stays open until the handler ends it
      // or the peer closes the socket, as server-sent events and long polling need.
      response = new ServerResponse({
        requestMethod: request.method,
        writeHead,
        writeInformational: (status, statusText, headers) => {
          socket.write(serializeHttp1ResponseHead({ status, statusText, headers }));
        },
        // A write the socket rejects means the peer is gone. Node reports that
        // by closing the response, never as a response error.
        writeBody: (chunk, callback) =>
          socket.write(chunked ? serializeHttp1Chunk(chunk) : chunk, () => callback()),
        end: (trailers) => {
          if (chunked) socket.write(serializeHttp1ChunkTerminator(trailers));
          connection.onEnd();
        },
        abort: () => {
          if (!connection.isClosed()) socket.destroy();
        }
      });
      this.dispatchRequest(request, response);
      return response;
    }

    private dispatchRequest(request: IncomingMessage, response: ServerResponse): void {
      response.req = request;
      response.socket = request.socket;
      try {
        if (httpHeaderTokens(request.headers.expect).includes('100-continue')) {
          if (this.listenerCount('checkContinue') > 0) {
            this.emit('checkContinue', request, response);
            return;
          }
          response.writeContinue();
        }
        this.emit('request', request, response);
      } catch (error) {
        const normalized = error instanceof Error ? error : new Error(String(error));
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.statusCode = 500;
        response.setHeader('content-type', 'text/plain; charset=utf-8');
        response.setHeader('x-mimic-runtime-error', normalized.message);
        response.end(normalized.stack ?? normalized.message);
      }
    }
  }
  class ClientRequest extends stream.Writable {
    readonly method: string;
    readonly path: string;
    readonly host: string;
    readonly port: number;
    socket?: VirtualNetSocket;
    private readonly headers = new Map<string, string>();
    private readonly requestChunks: Uint8Array[] = [];
    private timeoutHandle?: ReturnType<typeof globalThis.setTimeout>;
    private connected = false;
    private requestHeadWritten = false;
    private transportEnded = false;
    private finalCallback?: (error?: Error | null) => void;
    private response?: IncomingMessage;
    private responseBuffer: Uint8Array<ArrayBufferLike> = new Uint8Array();
    private responseBodyDecoder?: HttpWireChunkBodyDecoder;
    private remainingResponseBytes?: number;
    private responseCompleted = false;
    private responseTransportEnded = false;
    private fetchStarted = false;
    private virtualNetworkUnsupported = false;
    private readonly socketPath: string | undefined;
    private readonly fetchAbortController = new AbortController();
    private readonly unsupportedTransportOptions: string[];
    private requestActivityRelease = requestLifecycle?.acquire();
    private unregisterResource?: () => void;

    constructor(options: HttpClientRequestOptions) {
      super({
        autoDestroy: false,
        highWaterMark: options.headers.some(([name]) => name.toLowerCase() === 'content-length')
          ? 16 * 1024
          : 64 * 1024,
        write(chunk, _encoding, callback) {
          (this as ClientRequest).requestChunks.push(toHttpBytes(chunk));
          queueMicrotask(callback);
        },
        final(callback) {
          (this as ClientRequest).finishRequest(callback);
        },
        destroy(error, callback) {
          (this as ClientRequest).destroyRequest();
          callback(error);
        }
      });
      this.method = options.method;
      this.path = options.path;
      this.host = options.host;
      this.port = options.port;
      this.socketPath = options.socketPath;
      this.unsupportedTransportOptions = options.unsupportedTransportOptions;
      for (const [name, value] of options.headers) this.headers.set(name.toLowerCase(), value);
      this.unregisterResource = registerResource?.(() => this.destroy());
    }

    start(): void {
      if (this.destroyed || this.socket || this.fetchStarted) return;
      if (this.unsupportedTransportOptions.length > 0) {
        this.failUnsupported(
          Object.assign(
            new Error(
              `Browser-backed ${protocol.toUpperCase()} cannot represent transport option(s): ${this.unsupportedTransportOptions.join(', ')}`
            ),
            { code: 'ENOTSUP' }
          )
        );
        return;
      }
      if (this.virtualNetworkUnsupported) {
        if (!this.writableEnded) return;
        this.startFetch();
        return;
      }
      if (!this.writableEnded && !this.headers.has('content-length')) return;

      const socket = net.createConnection(
        this.socketPath !== undefined
          ? { path: this.socketPath }
          : { port: this.port, host: this.host, transport: protocol === 'https' ? 'tls' : 'tcp' },
        () => {
        if (this.destroyed) {
          socket.destroy();
          return;
        }
        this.connected = true;
        this.emit('socket', socket);
        this.flushRequest();
        }
      );
      this.socket = socket;
      socket.on('data', (chunk) => {
        try {
          this.receiveResponseBytes(toHttpBytes(chunk));
        } catch (error) {
          this.failResponse(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.once('end', () => {
        this.responseTransportEnded = true;
        this.finishResponseOnSocketEnd();
      });
      socket.once('error', (error) => {
        if (this.destroyed) return;
        if (
          !this.connected &&
          this.socket === socket &&
          error &&
          typeof error === 'object' &&
          'code' in error &&
          error.code === 'ENOTSUP' &&
          'cause' in error &&
          error.cause &&
          typeof error.cause === 'object' &&
          'code' in error.cause &&
          error.cause.code === 'EXTERNAL_TRANSPORT_UNSUPPORTED'
        ) {
          this.virtualNetworkUnsupported = true;
          this.socket = undefined;
          if (this.writableEnded) this.startFetch();
          // Fetch cannot negotiate `Expect: 100-continue`; release the body.
          else if (httpHeaderTokens(this.headers.get('expect')).includes('100-continue')) this.emit('continue');
          return;
        }
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      });
      socket.once('close', () => {
        if (this.socket !== socket) return;
        if (!this.response) {
          this.releaseRequest();
          return;
        }
        if (this.responseCompleted || this.responseTransportEnded || this.response.destroyed) return;
        this.responseCompleted = true;
        this.response.destroy(
          Object.assign(new Error('Premature close while reading HTTP response'), {
            code: 'ERR_STREAM_PREMATURE_CLOSE'
          })
        );
      });
    }

    private finishRequest(callback: (error?: Error | null) => void): void {
      this.finalCallback = callback;
      if (!this.headers.has('content-length')) {
        // The buffered body is sent length-delimited, so a caller's chunked
        // framing request must not describe it as well.
        if (httpHeaderTokens(this.headers.get('transfer-encoding')).every((token) => token === 'chunked')) {
          this.headers.delete('transfer-encoding');
        }
        this.headers.set('content-length', String(this.requestChunks.reduce((length, chunk) => length + chunk.byteLength, 0)));
      }
      this.start();
      this.flushRequest();
    }

    abort(): void {
      if (this.destroyed) return;
      this.emit('abort');
      this.destroy();
    }

    private destroyRequest(): void {
      if (this.timeoutHandle) globalThis.clearTimeout(this.timeoutHandle);
      this.fetchAbortController.abort();
      this.socket?.destroy();
      this.releaseRequest();
    }

    setHeader(name: string, value: string | number | string[]): void {
      this.headers.set(name.toLowerCase(), arrayHeader(value).join(', '));
    }

    getHeader(name: string): string | undefined {
      return this.headers.get(name.toLowerCase());
    }

    getHeaders(): Record<string, string> {
      return Object.fromEntries(this.headers);
    }

    getHeaderNames(): string[] {
      return [...this.headers.keys()];
    }

    hasHeader(name: string): boolean {
      return this.headers.has(name.toLowerCase());
    }

    removeHeader(name: string): void {
      this.headers.delete(name.toLowerCase());
    }

    setTimeout(timeout: number, callback?: () => void): this {
      if (callback) this.on('timeout', callback);
      if (this.timeoutHandle) globalThis.clearTimeout(this.timeoutHandle);
      this.timeoutHandle = globalThis.setTimeout(() => this.emit('timeout'), timeout);
      return this;
    }

    private flushRequest(): void {
      const socket = this.socket;
      if (!socket || !this.connected || this.destroyed) return;
      if (!this.requestHeadWritten) {
        this.requestHeadWritten = true;
        socket.write(serializeHttpClientRequestHead(this.method, this.path, this.host, this.port, this.headers));
      }
      while (this.requestChunks.length > 0) {
        const chunk = this.requestChunks.shift();
        if (!chunk) break;
        socket.write(chunk);
      }
      if (this.writableEnded && !this.transportEnded) {
        this.transportEnded = true;
        socket.end(undefined, () => {
          const callback = this.finalCallback;
          this.finalCallback = undefined;
          callback?.();
        });
      }
    }

    private startFetch(): void {
      if (this.fetchStarted || this.destroyed) return;
      this.fetchStarted = true;
      const callback = this.finalCallback;
      this.finalCallback = undefined;
      const body = concatBytes(this.requestChunks);
      this.requestChunks.length = 0;
      if (!browserFetch) {
        const error = unsupportedBrowserTransport(
          `Browser Fetch is unavailable for outbound ${protocol.toUpperCase()}.`
        );
        callback?.();
        this.failUnsupported(error);
        return;
      }
      let headers: [string, string][];
      try {
        headers = browserFetchHeaders(this.headers, this.host, this.port, body.byteLength);
        if ((this.method === 'GET' || this.method === 'HEAD') && body.byteLength > 0) {
          throw unsupportedBrowserTransport(`HTTP ${this.method} request bodies cannot be represented by browser Fetch.`);
        }
      } catch (reason) {
        callback?.();
        this.failUnsupported(reason instanceof Error ? reason : new Error(String(reason)));
        return;
      }
      const url = httpUrl(protocol, this.host, this.port, this.path);
      let response: Promise<Response>;
      try {
        response = browserFetch(url, {
          cache: 'no-store',
          credentials: 'omit',
          method: this.method,
          headers: corsSimpleRequestHeaders(this.method, url, headers),
          // Node hands a 3xx response to the caller. Fetch can only hide it
          // (`manual` yields an opaque redirect without status or Location)
          // or follow it, so the caller receives the redirect's final response.
          redirect: 'follow',
          referrerPolicy: 'no-referrer',
          signal: this.fetchAbortController.signal,
          ...(body.byteLength > 0 ? { body: requestBody(body) } : {})
        });
      } catch (reason) {
        callback?.();
        this.failUnsupported(browserFetchError(reason));
        return;
      }
      queueMicrotask(() => callback?.());
      void response.then(
        (result) => this.receiveFetchResponse(result),
        (reason: unknown) => {
          if (!this.destroyed) this.destroy(browserFetchError(reason));
        }
      );
    }

    private async receiveFetchResponse(result: Response): Promise<void> {
      if (this.destroyed) return;
      if (result.type === 'opaqueredirect') {
        this.failUnsupported(unsupportedBrowserTransport('Opaque browser redirects cannot be represented as a Node HTTP response.'));
        return;
      }
      const response = new IncomingMessage(
        () => this.ensureRequestActivity(),
        () => this.releaseRequest()
      );
      response.statusCode = result.status;
      response.statusMessage = result.statusText;
      const headers = [...result.headers.entries()]
        .map(([name, value]) => [name.toLowerCase(), value] as [string, string])
        .filter(([name]) => !['connection', 'content-encoding', 'content-length', 'trailer', 'transfer-encoding'].includes(name));
      response.headers = incomingHttpHeaders(headers);
      response.rawHeaders = rawHttpHeaders(headers);
      response.once('aborted', () => this.destroy());
      response.once('close', () => this.destroy());
      this.response = response;
      this.emit('response', response);
      try {
        const reader = result.body?.getReader();
        if (reader) {
          while (true) {
            const { done, value } = await reader.read();
            if (done || this.destroyed) break;
            response.receiveBodyChunk(value);
          }
        }
        if (!this.destroyed) this.completeResponse();
      } catch (reason) {
        if (!this.destroyed) this.failResponse(browserFetchError(reason));
      }
    }

    private receiveResponseBytes(bytes: Uint8Array): void {
      if (this.destroyed || this.responseCompleted) return;
      if (!this.response) {
        this.responseBuffer = concatBytes([this.responseBuffer, bytes]);
        let parsedHead = tryParseHttpResponseHead(this.responseBuffer);
        // Interim 1xx responses precede the final head on the same socket.
        while (parsedHead && parsedHead.status >= 100 && parsedHead.status < 200 && parsedHead.status !== 101) {
          this.responseBuffer = this.responseBuffer.slice(parsedHead.bodyStart);
          if (parsedHead.status === 100) this.emit('continue');
          else {
            this.emit('information', {
              statusCode: parsedHead.status,
              statusMessage: parsedHead.statusText,
              headers: incomingHttpHeaders(parsedHead.headers),
              rawHeaders: rawHttpHeaders(parsedHead.headers)
            });
          }
          if (this.destroyed) return;
          parsedHead = tryParseHttpResponseHead(this.responseBuffer);
        }
        if (!parsedHead) return;
        const response = new IncomingMessage(
          () => this.ensureRequestActivity(),
          () => this.releaseRequest()
        );
        response.statusCode = parsedHead.status;
        response.statusMessage = parsedHead.statusText;
        response.headers = incomingHttpHeaders(parsedHead.headers);
        response.rawHeaders = rawHttpHeaders(parsedHead.headers);
        response.socket = this.socket;
        response.once('aborted', () => {
          this.destroy();
        });
        response.once('close', () => {
          this.destroy();
        });
        this.response = response;
        if (parsedHead.chunked) {
          this.responseBodyDecoder = new HttpWireChunkBodyDecoder(
            (chunk) => response.receiveBodyChunk(chunk),
            (trailers) => {
              response.trailers = Object.fromEntries(trailers);
              response.rawTrailers = trailers.flatMap(([name, value]) => [name, value]);
            },
            () => this.completeResponse()
          );
        } else {
          this.remainingResponseBytes = parsedHead.contentLength;
        }
        this.emit('response', response);
        const body = this.responseBuffer.slice(parsedHead.bodyStart);
        this.responseBuffer = new Uint8Array();
        this.receiveResponseBody(body);
        return;
      }
      this.receiveResponseBody(bytes);
    }

    private receiveResponseBody(bytes: Uint8Array): void {
      if (!this.response || this.responseCompleted || bytes.byteLength === 0) return;
      if (this.responseBodyDecoder) {
        this.responseBodyDecoder.push(bytes);
        return;
      }
      if (this.remainingResponseBytes === undefined) {
        this.response.receiveBodyChunk(bytes);
        return;
      }
      const accepted = bytes.slice(0, Math.max(0, this.remainingResponseBytes));
      if (accepted.byteLength > 0) this.response.receiveBodyChunk(accepted);
      this.remainingResponseBytes -= accepted.byteLength;
      if (this.remainingResponseBytes === 0) this.completeResponse();
    }

    private finishResponseOnSocketEnd(): void {
      if (this.timeoutHandle) globalThis.clearTimeout(this.timeoutHandle);
      if (this.responseCompleted) return;
      if (!this.response) {
        const error = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
        this.emit('error', error);
        this.emit('close');
        this.releaseRequest();
        return;
      }
      if (this.responseBodyDecoder && !this.responseBodyDecoder.complete) {
        this.response.destroy(Object.assign(new Error('Premature close while reading chunked HTTP response'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        this.responseCompleted = true;
        return;
      }
      if (this.remainingResponseBytes !== undefined && this.remainingResponseBytes > 0) {
        this.response.destroy(Object.assign(new Error('Premature close while reading HTTP response'), { code: 'ERR_STREAM_PREMATURE_CLOSE' }));
        this.responseCompleted = true;
        return;
      }
      this.completeResponse();
    }

    private completeResponse(): void {
      if (!this.response || this.responseCompleted) return;
      this.responseCompleted = true;
      const response = this.response;
      response.endBody();
      globalThis.setTimeout(() => {
        if (!response.hasStartedConsuming()) this.releaseRequest();
      }, 0);
    }

    private ensureRequestActivity(): void {
      // A destroyed request holds no activity, even if its response is read afterwards.
      if (this.destroyed || this.requestActivityRelease || !requestLifecycle) return;
      this.requestActivityRelease = requestLifecycle.acquire();
    }

    private releaseRequest(): void {
      const release = this.requestActivityRelease;
      this.requestActivityRelease = undefined;
      release?.();
      this.unregisterResource?.();
      this.unregisterResource = undefined;
    }

    private failUnsupported(error: Error): void {
      globalThis.setTimeout(() => this.destroy(error), 0);
    }

    private failResponse(error: Error): void {
      if (this.responseCompleted || this.destroyed) return;
      if (this.timeoutHandle) globalThis.clearTimeout(this.timeoutHandle);
      if (this.response) {
        this.responseCompleted = true;
        this.socket?.destroy();
        this.response.destroy(error);
        return;
      }
      this.destroy(error);
    }
  }
  const createServer = (optionsOrListener?: unknown, listener?: EventListener) => {
    if (protocol === 'https') throw unsupported();
    return new Server(typeof optionsOrListener === 'function' ? (optionsOrListener as EventListener) : listener);
  };
  const request = (
    urlOrOptions?: unknown,
    optionsOrCallback?: Record<string, unknown> | ((response: IncomingMessage) => void),
    callback?: (response: IncomingMessage) => void
  ) => {
    const options = isObjectRecord(optionsOrCallback)
      ? optionsOrCallback
      : undefined;
    const responseCallback = typeof optionsOrCallback === 'function'
      ? optionsOrCallback
      : callback;
    const req = new ClientRequest(parseHttpClientRequestOptions(protocol, urlOrOptions, options));
    if (responseCallback) req.on('response', responseCallback as EventListener);
    globalThis.setTimeout(() => req.start(), 0);
    return req;
  };
  const get = (
    urlOrOptions?: unknown,
    optionsOrCallback?: Record<string, unknown> | ((response: IncomingMessage) => void),
    callback?: (response: IncomingMessage) => void
  ) => {
    const req = request(urlOrOptions, optionsOrCallback, callback);
    req.end();
    return req;
  };
  /**
   * `http.Agent`. The browser transport pools connections itself, so requests
   * never go through an agent's sockets; the class keeps Node's shape for the
   * packages that subclass it (agentkeepalive, under pnpm 10): an
   * EventEmitter with the methods a subclass calls through `super`.
   */
  class Agent extends EventEmitter {
    readonly options: Record<string, unknown>;
    readonly keepAlive: boolean;
    readonly maxSockets: number;
    readonly maxFreeSockets: number;
    readonly maxTotalSockets: number;
    readonly defaultPort = protocol === 'https' ? 443 : 80;
    readonly protocol = `${protocol}:`;
    readonly requests: Record<string, unknown[]> = {};
    readonly sockets: Record<string, unknown[]> = {};
    readonly freeSockets: Record<string, unknown[]> = {};

    constructor(options?: Record<string, unknown>) {
      super();
      this.options = { path: null, ...options };
      this.keepAlive = options?.keepAlive === true;
      this.maxSockets = typeof options?.maxSockets === 'number' ? options.maxSockets : Infinity;
      this.maxFreeSockets = typeof options?.maxFreeSockets === 'number' ? options.maxFreeSockets : 256;
      this.maxTotalSockets = typeof options?.maxTotalSockets === 'number' ? options.maxTotalSockets : Infinity;
    }

    addRequest(): void {
      // Browser transport owns connection pooling; accepting the Node Agent
      // shape preserves request compatibility without delegating transport.
    }

    /** The pool key Node files a request's sockets under. */
    getName(
      options: {
        host?: string | null;
        port?: number | string | null;
        localAddress?: string;
        family?: number;
        socketPath?: string;
      } = {}
    ): string {
      let name = `${options.host || 'localhost'}:`;
      if (options.port) name += String(options.port);
      name += ':';
      if (options.localAddress) name += options.localAddress;
      if (options.family === 4 || options.family === 6) name += `:${options.family}`;
      if (options.socketPath) name += `:${options.socketPath}`;
      return name;
    }

    createConnection(...args: unknown[]): unknown {
      return net.createConnection(...args);
    }

    keepSocketAlive(socket: { setKeepAlive?(enable: boolean, delay?: number): unknown; unref?(): unknown }): boolean {
      socket.setKeepAlive?.(true, typeof this.options.keepAliveMsecs === 'number' ? this.options.keepAliveMsecs : 1000);
      socket.unref?.();
      return true;
    }

    reuseSocket(socket: { ref?(): unknown }): void {
      socket.ref?.();
    }

    destroy(): void {}
  }
  const http = {
    Agent,
    ClientRequest,
    IncomingMessage,
    ...(protocol === 'http' ? { METHODS: [...NODE_HTTP_METHODS] } : {}),
    Server,
    ServerResponse,
    STATUS_CODES: HttpStatusCodes,
    maxHeaderSize: maxHttpHeaderSize,
    createServer,
    get,
    request,
    globalAgent: new Agent()
  };
  return {
    ...http,
    default: http
  };
}

function requestAllowsKeepAlive(head: Http1RequestHead): boolean {
  const connection = head.headers
    .filter(([name]) => name === 'connection')
    .flatMap(([, value]) => httpHeaderTokens(value));
  if (connection.includes('close')) return false;
  return head.version === 'HTTP/1.1' || connection.includes('keep-alive');
}

function responseHeaderList(headers: Record<string, string | number | string[]>): [string, string][] {
  return Object.entries(headers).flatMap(([name, value]) =>
    arrayHeader(value).map((item) => [name.toLowerCase(), String(item)] as [string, string])
  );
}

// A client that disconnects closes the response as well as the request,
// which is how long-lived handlers learn to stop writing. A peer may close as
// soon as it holds the complete body; an ended response first gets the turn
// its acknowledged writes need to finish.
function closeResponseWithConnection(response: { readonly destroyed: boolean; readonly writableEnded: boolean; destroy(): unknown }): void {
  if (response.destroyed) return;
  const close = () => {
    if (!response.destroyed) response.destroy();
  };
  if (response.writableEnded) globalThis.setTimeout(close, 0);
  else close();
}

type ExchangeConnectionSink = {
  /**
   * Bytes the program wrote to the exchange's socket. `false` holds the
   * program's further writes until `ExchangeConnection.drain()`.
   */
  write(bytes: Uint8Array): boolean | void;
  /** The program ended its side of the socket. */
  end(): void;
  close(): void;
};

const discardedExchangeBytes: ExchangeConnectionSink = {
  write: () => undefined,
  end: () => undefined,
  close: () => undefined
};

/**
 * The connection beneath a structured exchange's socket: an in-process byte
 * pipe that `net.Socket` attaches to as it would to a Virtual Network socket.
 */
class ExchangeConnection implements VirtualNetworkSocket {
  private static nextId = 0;
  readonly id = `http-exchange-${++ExchangeConnection.nextId}`;
  readonly remoteAddress = { host: '127.0.0.1', port: 0 };
  readonly connected = Promise.resolve();
  readonly closed: Promise<void>;
  private readonly listeners = new Map<string, Set<(event: never) => void>>();
  private isClosed = false;
  private resolveClosed!: () => void;
  /** Client bytes held while the program paused its socket, with their delivery callbacks. */
  private readonly held: ({ readonly data: Uint8Array; readonly delivered?: () => void } | 'end')[] = [];
  private paused = false;

  constructor(
    readonly localAddress: { readonly host: string; readonly port: number },
    private readonly sink: ExchangeConnectionSink
  ) {
    this.closed = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
  }

  on<Type extends VirtualNetworkSocketEvent['type']>(
    type: Type,
    listener: (event: Extract<VirtualNetworkSocketEvent, { readonly type: Type }>) => void
  ): () => void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(type, listeners);
    return () => listeners.delete(listener as (event: never) => void);
  }

  write(data: Uint8Array): boolean {
    if (this.isClosed) return true;
    return this.sink.write(data) !== false;
  }

  /** The program's socket stops reading: client bytes wait until it resumes. */
  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
    while (!this.paused && !this.isClosed && this.held.length > 0) {
      const next = this.held.shift()!;
      if (next === 'end') this.emit({ type: 'end' });
      else this.deliver(next.data, next.delivered);
    }
  }

  end(): void {
    if (!this.isClosed) this.sink.end();
  }

  destroy(): void {
    this.close();
  }

  /** Delivers bytes from the client to the program; `delivered` runs once the program's socket took them. */
  receive(data: Uint8Array, delivered?: () => void): void {
    if (this.isClosed) return;
    if (this.paused || this.held.length > 0) this.held.push({ data, delivered });
    else this.deliver(data, delivered);
  }

  /** The client ended its side. */
  receiveEnd(): void {
    if (this.isClosed) return;
    if (this.paused || this.held.length > 0) this.held.push('end');
    else this.emit({ type: 'end' });
  }

  /** The sink can take the program's writes again after `write` returned `false`. */
  drain(): void {
    if (!this.isClosed) this.emit({ type: 'drain' });
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.held.length = 0;
    this.emit({ type: 'close' });
    this.sink.close();
    this.resolveClosed();
  }

  private deliver(data: Uint8Array, delivered?: () => void): void {
    this.emit({ type: 'data', data });
    delivered?.();
  }

  private emit(event: VirtualNetworkSocketEvent): void {
    for (const listener of [...(this.listeners.get(event.type) ?? [])]) {
      (listener as (event: VirtualNetworkSocketEvent) => void)(event);
    }
  }
}

// Serializes the handler's response head. The only header this adds is the
// connection-persistence signal, which Node's server also owns: the connection
// persists when the request allows it and the response delimits its own body
// (Content-Length or chunked framing); every other response is delimited by
// closing the connection and says so.
function serializeHttpServerResponseHead(
  response: {
    statusCode: number;
    statusMessage: string;
    headers: Record<string, string | number | string[]>;
  },
  connection: { keepAlive: boolean; keepAliveTimeout: number }
): { bytes: Uint8Array; persistent: boolean } {
  const statusText = response.statusMessage || HttpStatusCodes[response.statusCode] || '';
  let headers = Object.entries(response.headers).flatMap(([name, value]) =>
    arrayHeader(value).map((item) => [name.toLowerCase(), String(item)] as [string, string])
  );
  const connectionTokens = headers
    .filter(([name]) => name === 'connection')
    .flatMap(([, value]) => httpHeaderTokens(value));
  const selfDelimiting = headers.some(
    ([name, value]) =>
      name === 'content-length' || (name === 'transfer-encoding' && httpHeaderTokens(value).includes('chunked'))
  );
  const persistent = connection.keepAlive && selfDelimiting && !connectionTokens.includes('close');
  if (persistent) {
    if (connectionTokens.length === 0) {
      headers.push(['connection', 'keep-alive']);
      if (connection.keepAliveTimeout > 0 && !headers.some(([name]) => name === 'keep-alive')) {
        headers.push(['keep-alive', `timeout=${Math.floor(connection.keepAliveTimeout / 1000)}`]);
      }
    }
  } else if (!connectionTokens.includes('close')) {
    headers = headers.filter(
      ([name, value]) => name !== 'keep-alive' && (name !== 'connection' || !httpHeaderTokens(value).includes('keep-alive'))
    );
    headers.push(['connection', 'close']);
  }
  return {
    bytes: serializeHttp1ResponseHead({ status: response.statusCode, statusText, headers }),
    persistent
  };
}

type ParsedHttpResponseHead = {
  status: number;
  statusText: string;
  headers: [string, string][];
  bodyStart: number;
  chunked: boolean;
  contentLength?: number;
};

function tryParseHttpResponseHead(bytes: Uint8Array): ParsedHttpResponseHead | undefined {
  const parsed = parseHttp1ResponseHead(bytes);
  if (!parsed) return undefined;
  return {
    status: parsed.status,
    statusText: parsed.statusText || HttpStatusCodes[parsed.status] || '',
    headers: parsed.headers.map(([name, value]) => [name, value] as [string, string]),
    bodyStart: parsed.bodyStart,
    chunked: parsed.chunked,
    contentLength: parsed.contentLength
  };
}

// Node v22 `http.STATUS_CODES`, verbatim.
const HttpStatusCodes: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  102: 'Processing',
  103: 'Early Hints',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  208: 'Already Reported',
  226: 'IM Used',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  305: 'Use Proxy',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Payload Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a Teapot",
  421: 'Misdirected Request',
  422: 'Unprocessable Entity',
  423: 'Locked',
  424: 'Failed Dependency',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
  506: 'Variant Also Negotiates',
  507: 'Insufficient Storage',
  508: 'Loop Detected',
  509: 'Bandwidth Limit Exceeded',
  510: 'Not Extended',
  511: 'Network Authentication Required'
};

const maxHttpHeaderSize = 16 * 1024;


import type { MessageStream } from '../worker-transport';
import type {
  PublishedEndpointWebSocketMessage,
  PublishedWebSocketClientMessage,
  PublishedWebSocketServerMessage
} from './types';

type PublishedEndpointDocumentWindow = Window & typeof globalThis & {
  __mimicPublishedEndpointWebSocketTransport?: boolean;
};

export type PublishedEndpointDocumentWebSocketProgramOptions = {
  openStream: (targetOrigin: string) => Promise<MessageStream>;
  manifest: {
    version: 1;
    epochId: string;
    routes: readonly {
      routeId: string;
      protocol: 'http' | 'https';
      address: { host: string; port: number };
      url: string;
    }[];
  };
};

type ProtocolList = string | string[] | undefined;
type WebSocketSendData = string | ArrayBuffer | ArrayBufferView | Blob;
type EventHandler = ((event: Event) => unknown) | null;
type PublishedEndpointDocumentRoute = PublishedEndpointDocumentWebSocketProgramOptions['manifest']['routes'][number];
type PublishedEndpointDocumentSocketRoute = {
  /** The route that serves this document. */
  endpoint: PublishedEndpointDocumentRoute;
  path: string;
  /**
   * Another loopback port of the document's machine, which the host resolves
   * to the route that serves it when the socket opens (ADR-0037).
   */
  loopbackPort?: number;
};

/**
 * Replaces the document's `WebSocket` with one that reaches the container's
 * published listeners (ADR-0038). The handshake request goes to the host over
 * the Service Worker; the host answers with a port on which the process
 * worker that owns the listener serves the socket as whole messages, each
 * direction acknowledged by count. The worker speaks RFC 6455 to the server,
 * so no frame is built or read here. Each side watches the other's Web Lock to
 * learn when it is gone. This function is serialized into the document, so it
 * refers to nothing outside itself.
 */
export function installPublishedEndpointDocumentWebSocketProgram(
  options: PublishedEndpointDocumentWebSocketProgramOptions
): void {
  const documentWindow = window as PublishedEndpointDocumentWindow;
  if (documentWindow.__mimicPublishedEndpointWebSocketTransport) return;
  documentWindow.__mimicPublishedEndpointWebSocketTransport = true;
  const NativeWebSocket = window.WebSocket;
  const { manifest, openStream } = options;
  /** How long the host may take to answer the handshake request. */
  const HOST_ANSWER_TIMEOUT_MS = 30_000;
  /** Acknowledgements are batched once this many are pending, or at the next task. */
  const ACK_BATCH = 32;
  const EVENT_HANDLER_TYPES = ['open', 'message', 'error', 'close'] as const;
  const activePublishedEndpointSockets = new Set<PublishedEndpointDocumentWebSocket>();
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  /** The lock this document holds while it lives, which the serving process worker watches. */
  const documentLock: Promise<string | undefined> = locks
    ? new Promise((resolve) => {
        const name = 'mimic:document:' + crypto.randomUUID();
        locks
          .request(name, () => {
            resolve(name);
            return new Promise<never>(() => undefined);
          })
          .catch(() => resolve(undefined));
      })
    : Promise.resolve(undefined);
  /** The sockets each serving process worker's lock stands for. */
  const watchedProcesses = new Map<string, Set<PublishedEndpointDocumentWebSocket>>();

  class PublishedEndpointDocumentWebSocket extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    declare readonly CONNECTING: 0;
    declare readonly OPEN: 1;
    declare readonly CLOSING: 2;
    declare readonly CLOSED: 3;

    /** A browser socket for an unpublished port is a `WebSocket` too. */
    static [Symbol.hasInstance](value: unknown): boolean {
      return (
        value instanceof NativeWebSocket ||
        (typeof value === 'object' && value !== null && PublishedEndpointDocumentWebSocket.prototype.isPrototypeOf(value))
      );
    }

    #readyState = 0;
    #bufferedAmount = 0;
    #protocol = '';
    #extensions = '';
    #url = '';
    #binaryType: BinaryType = 'blob';
    #requestedProtocols: string[] = [];
    #handlers = new Map<string, EventHandler>();
    #control: MessageStream | null = null;
    #port: MessagePort | null = null;
    #hostTimer: ReturnType<typeof setTimeout> | undefined;
    /** Byte lengths of the sends the worker has not acknowledged, oldest first. */
    #unacknowledged: number[] = [];
    /** Messages dispatched since the last acknowledgement. */
    #received = 0;
    #ackTimer: ReturnType<typeof setTimeout> | undefined;
    /** Sends after a `Blob` wait for it, so the server receives them in order. */
    #outgoing: Promise<void> = Promise.resolve();
    #pendingBlobs = 0;
    #processLock: string | undefined;
    /** The browser's own socket, for a loopback port the container does not publish. */
    #native: WebSocket | null = null;

    constructor(url: string | URL, protocols?: ProtocolList) {
      const requestedProtocols = validateProtocols(protocols);
      const route = matchingPublishedEndpointRoute(url);
      if (!route) {
        return new NativeWebSocket(url, protocols) as unknown as PublishedEndpointDocumentWebSocket;
      }
      super();
      this.#url = String(new URL(url, window.location.href));
      this.#requestedProtocols = requestedProtocols;
      activePublishedEndpointSockets.add(this);
      void this.#openPublishedEndpointSocket(route);
    }

    get readyState(): number {
      return this.#readyState;
    }

    get bufferedAmount(): number {
      return this.#bufferedAmount;
    }

    get protocol(): string {
      return this.#protocol;
    }

    get extensions(): string {
      return this.#extensions;
    }

    get url(): string {
      return this.#url;
    }

    get binaryType(): BinaryType {
      return this.#binaryType;
    }

    set binaryType(value) {
      if (value === 'blob' || value === 'arraybuffer') this.#binaryType = value;
      if (this.#native) this.#native.binaryType = this.#binaryType;
    }

    send(data: WebSocketSendData): void {
      if (this.#readyState === 0) throw new DOMException('WebSocket is not open', 'InvalidStateError');
      if (this.#readyState !== 1) return;
      if (this.#native) {
        this.#native.send(data);
        return;
      }
      const bytes = payloadByteLength(data);
      this.#bufferedAmount += bytes;
      this.#unacknowledged.push(bytes);
      // Queued sends keep the port they were made on: the socket may close
      // before a `Blob` is read, and its port closes after them.
      const port = this.#port;
      if (data instanceof Blob) {
        this.#pendingBlobs += 1;
        const read = data.arrayBuffer();
        this.#enqueue(async () => {
          let buffer: ArrayBuffer;
          try {
            buffer = await read;
          } finally {
            this.#pendingBlobs -= 1;
          }
          this.#post({ type: 'send', data: buffer }, [buffer], port);
        });
        return;
      }
      const payload: string | ArrayBuffer =
        typeof data === 'string'
          ? data
          : ArrayBuffer.isView(data)
            ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer
            : data instanceof ArrayBuffer
              ? data.slice(0)
              : String(data);
      const transfer = typeof payload === 'string' ? [] : [payload];
      if (this.#pendingBlobs > 0) this.#enqueue(() => this.#post({ type: 'send', data: payload }, transfer, port));
      else this.#post({ type: 'send', data: payload }, transfer, port);
    }

    close(code?: number, reason?: string): void {
      const close = normalizeCloseArguments(arguments.length, code, reason);
      validateCloseArguments(close.frameCode, close.reason);
      if (this.#readyState === 2 || this.#readyState === 3) return;
      const connecting = this.#readyState === 0;
      this.#readyState = 2;
      if (this.#native) {
        this.#native.close(close.frameCode, close.reason);
        return;
      }
      if (connecting) {
        // The handshake never completes: the worker drops the connection.
        this.#post({ type: 'abort' });
        queueMicrotask(() => this.#finish(1006, '', false, true));
        return;
      }
      const message: PublishedWebSocketClientMessage =
        close.frameCode === undefined
          ? { type: 'close', reason: '' }
          : { type: 'close', code: close.frameCode, reason: close.reason };
      const port = this.#port;
      if (this.#pendingBlobs > 0) this.#enqueue(() => this.#post(message, [], port));
      else this.#post(message, [], port);
      queueMicrotask(() => this.#finish(close.eventCode, close.reason, true));
    }

    async #openPublishedEndpointSocket(route: PublishedEndpointDocumentSocketRoute): Promise<void> {
      this.#hostTimer = setTimeout(() => this.#failConnection(), HOST_ANSWER_TIMEOUT_MS);
      const parsed = new URL(this.#url, window.location.href);
      const headers: [string, string][] = [
        // The host the server would see on a developer machine, as a published
        // HTTP request carries: servers that check it, such as Vite's HMR
        // socket, refuse the preview origin's hostname.
        ['host', `localhost:${route.loopbackPort ?? route.endpoint.address.port}`],
        ['connection', 'Upgrade'],
        ['upgrade', 'websocket'],
        ['sec-websocket-key', webSocketKey()],
        ['sec-websocket-version', '13']
      ];
      // A socket to a loopback port, or to a host other than the document's,
      // carries the document's logical origin, which pairs with the Host
      // above: webpack-dev-server refuses an Origin whose hostname differs
      // from the Host's, and the preview origin's is never localhost.
      if (route.loopbackPort !== undefined || parsed.host !== window.location.host) {
        headers.push(['origin', `${route.endpoint.protocol}://localhost:${route.endpoint.address.port}`]);
      }
      if (this.#requestedProtocols.length > 0) headers.push(['sec-websocket-protocol', this.#requestedProtocols.join(', ')]);
      let stream: MessageStream;
      let lock: string | undefined;
      try {
        lock = await documentLock;
        stream = await openStream(window.location.origin);
      } catch {
        this.#failConnection();
        return;
      }
      if (this.#readyState !== 0) {
        stream.close();
        return;
      }
      this.#control = stream;
      stream.subscribe((message) => this.#receiveControl(message as PublishedEndpointWebSocketMessage));
      // The host answers before it closes the stream; a stream closed without
      // an answer is a host that is gone or refused the document.
      void stream.closed.then(() => {
        if (this.#readyState === 0 && !this.#port && !this.#native) this.#failConnection();
      });
      stream.send({
        type: 'published-endpoint:websocket-open',
        requestId: 'published-endpoint-ws-' + crypto.randomUUID(),
        instanceId: manifest.epochId,
        routeId: route.loopbackPort === undefined ? route.endpoint.routeId : '',
        manifestVersion: manifest.version,
        port: route.loopbackPort ?? route.endpoint.address.port,
        path: route.path,
        method: 'GET',
        url: this.#url,
        headers,
        ...(lock ? { documentLock: lock } : {}),
        // A browser sends cookies with every WebSocket handshake.
        ...(route.loopbackPort === undefined ? {} : { loopback: { credentials: 'include' } })
      });
    }

    #receiveControl(message: PublishedEndpointWebSocketMessage): void {
      if (typeof message !== 'object' || message === null) return;
      if (message.type === 'published-endpoint:websocket-connect') {
        if (!(message.port instanceof MessagePort) || this.#port) return;
        clearTimeout(this.#hostTimer);
        if (this.#readyState !== 0) {
          // Closed while the host answered: the worker drops the connection.
          message.port.postMessage({ type: 'abort' } satisfies PublishedWebSocketClientMessage);
          message.port.close();
          this.#control?.close();
          this.#control = null;
          return;
        }
        this.#port = message.port;
        this.#port.onmessage = (event) => this.#receive(event.data as PublishedWebSocketServerMessage);
        return;
      }
      if (this.#readyState === 3) return;
      if (message.type === 'published-endpoint:websocket-unrouted') {
        if (this.#readyState === 0) this.#openNativeSocket();
        return;
      }
      if (message.type === 'published-endpoint:websocket-close') {
        // Before the server answered, the handshake failed; after, the host
        // closes a socket whose endpoint is gone, as a dropped connection.
        if (this.#readyState === 0) {
          this.#failConnection();
          return;
        }
        this.#post({ type: 'abort' });
        this.#finish(
          typeof message.code === 'number' ? message.code : 1006,
          typeof message.reason === 'string' ? message.reason : '',
          false,
          true
        );
      }
    }

    #receive(message: PublishedWebSocketServerMessage): void {
      if (this.#readyState === 3 || typeof message !== 'object' || message === null) return;
      switch (message.type) {
        case 'open':
          if (this.#readyState !== 0) return;
          this.#protocol = typeof message.protocol === 'string' ? message.protocol : '';
          this.#readyState = 1;
          if (typeof message.lock === 'string') this.#watchProcess(message.lock);
          this.dispatchEvent(new Event('open'));
          return;
        case 'message': {
          // Every message is acknowledged, dispatched or not, so the worker
          // does not hold the server's writes for it.
          this.#acknowledgeReceived();
          if (this.#readyState !== 1) return;
          const data =
            typeof message.data === 'string' || this.#binaryType === 'arraybuffer'
              ? message.data
              : new Blob([message.data]);
          this.dispatchEvent(new MessageEvent('message', { data, origin: new URL(this.#url).origin }));
          return;
        }
        case 'ack': {
          const count = typeof message.count === 'number' ? message.count : 0;
          for (let index = 0; index < count && this.#unacknowledged.length > 0; index += 1) {
            this.#bufferedAmount = Math.max(0, this.#bufferedAmount - this.#unacknowledged.shift()!);
          }
          return;
        }
        case 'close': {
          const failed = this.#readyState === 0 || !message.wasClean;
          this.#finish(
            failed ? 1006 : message.code,
            failed ? '' : message.reason,
            !failed,
            failed
          );
          return;
        }
      }
    }

    #post(
      message: PublishedWebSocketClientMessage,
      transfer: Transferable[] = [],
      port: MessagePort | null = this.#port
    ): void {
      // What the document sends answers what it has received: the server
      // learns it was read first, as its bytes left before the reply did.
      if (message.type !== 'ack' && this.#received > 0) this.#flushAck();
      try {
        port?.postMessage(message, transfer);
      } catch {
        // The worker is gone; its lock closes this socket.
      }
    }

    #enqueue(operation: () => void | Promise<void>): void {
      this.#outgoing = this.#outgoing.then(operation).catch(() => undefined);
    }

    #acknowledgeReceived(): void {
      this.#received += 1;
      if (this.#received >= ACK_BATCH) this.#flushAck();
      else this.#ackTimer ??= setTimeout(() => this.#flushAck(), 0);
    }

    #flushAck(): void {
      clearTimeout(this.#ackTimer);
      this.#ackTimer = undefined;
      if (this.#received === 0) return;
      this.#post({ type: 'ack', count: this.#received });
      this.#received = 0;
    }

    #watchProcess(lock: string): void {
      this.#processLock = lock;
      const sockets = watchedProcesses.get(lock);
      if (sockets) {
        sockets.add(this);
        return;
      }
      const watched = new Set<PublishedEndpointDocumentWebSocket>([this]);
      watchedProcesses.set(lock, watched);
      if (!locks) return;
      void (async () => {
        // A lock this document's partition cannot see is not watched.
        const state = await locks.query();
        if (!state.held?.some((held) => held.name === lock)) return;
        await locks.request(lock, { mode: 'shared' }, () => {
          watchedProcesses.delete(lock);
          for (const socket of watched) socket._closeForServerGone();
        });
      })().catch(() => undefined);
    }

    /** The browser's socket answers a loopback port the container does not publish. */
    #openNativeSocket(): void {
      clearTimeout(this.#hostTimer);
      this.#control?.close();
      this.#control = null;
      const native = new NativeWebSocket(this.#url, this.#requestedProtocols);
      native.binaryType = this.#binaryType;
      this.#native = native;
      native.addEventListener('open', () => {
        if (this.#readyState !== 0) return;
        this.#protocol = native.protocol;
        this.#extensions = native.extensions;
        this.#readyState = 1;
        this.dispatchEvent(new Event('open'));
      });
      native.addEventListener('message', (event) => {
        this.dispatchEvent(new MessageEvent('message', { data: event.data, origin: event.origin }));
      });
      native.addEventListener('error', () => this.dispatchEvent(new Event('error')));
      native.addEventListener('close', (event) => {
        this.#readyState = 3;
        activePublishedEndpointSockets.delete(this);
        this.dispatchEvent(new CloseEvent('close', { code: event.code, reason: event.reason, wasClean: event.wasClean }));
      });
    }

    /** The connection failed before or after opening: `error`, then an abnormal close. */
    #failConnection(): void {
      if (this.#readyState === 3) return;
      this.#post({ type: 'abort' });
      this.#finish(1006, '', false, true);
    }

    /** The process worker serving this socket is gone, as a server whose connection dropped. */
    _closeForServerGone(): void {
      this.#finish(1006, '', false, true);
    }

    _closeForDocumentUnload(): void {
      if (this.#readyState === 3) return;
      // The browser closes its own socket with the document.
      if (this.#native) return;
      if (this.#readyState === 1) this.#post({ type: 'close', code: 1001, reason: '' });
      else this.#post({ type: 'abort' });
      this.#finish(1001, '', false);
    }

    #finish(code: number, reason: string, wasClean: boolean, dispatchError = false): void {
      if (this.#readyState === 3) return;
      this.#readyState = 3;
      this.#bufferedAmount = 0;
      this.#unacknowledged = [];
      clearTimeout(this.#hostTimer);
      clearTimeout(this.#ackTimer);
      activePublishedEndpointSockets.delete(this);
      if (this.#processLock) watchedProcesses.get(this.#processLock)?.delete(this);
      // A socket closed before the host answered still takes the host's
      // port, to tell the worker to drop the connection.
      if (this.#port) {
        this.#control?.close();
        this.#control = null;
      }
      const port = this.#port;
      this.#port = null;
      // The port closes once the sends queued behind a `Blob` reached it.
      if (port) this.#outgoing = this.#outgoing.then(() => port.close());
      if (dispatchError) this.dispatchEvent(new Event('error'));
      this.dispatchEvent(new CloseEvent('close', { code, reason, wasClean }));
    }
  }

  // `onopen` and the others are event handler attributes: a handler joins the
  // listeners where it is first set, as in a browser.
  for (const type of EVENT_HANDLER_TYPES) {
    const handlers = new WeakMap<PublishedEndpointDocumentWebSocket, EventHandler>();
    const registered = new WeakSet<PublishedEndpointDocumentWebSocket>();
    Object.defineProperty(PublishedEndpointDocumentWebSocket.prototype, 'on' + type, {
      configurable: true,
      enumerable: true,
      get(this: PublishedEndpointDocumentWebSocket) {
        return handlers.get(this) ?? null;
      },
      set(this: PublishedEndpointDocumentWebSocket, value: unknown) {
        handlers.set(this, typeof value === 'function' ? (value as EventHandler) : null);
        if (registered.has(this)) return;
        registered.add(this);
        EventTarget.prototype.addEventListener.call(this, type, (event: Event) => {
          const handler = handlers.get(this);
          if (handler) handler.call(this, event);
        });
      }
    });
  }
  for (const [name, value] of [['CONNECTING', 0], ['OPEN', 1], ['CLOSING', 2], ['CLOSED', 3]] as const) {
    Object.defineProperty(PublishedEndpointDocumentWebSocket.prototype, name, { value, enumerable: true });
  }

  window.addEventListener('pagehide', () => {
    for (const socket of [...activePublishedEndpointSockets]) socket._closeForDocumentUnload();
  });

  function payloadByteLength(data: WebSocketSendData): number {
    if (typeof data === 'string') return utf8ByteLength(data);
    if (data instanceof Blob) return data.size;
    if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) return data.byteLength;
    return utf8ByteLength(String(data));
  }

  /** The length of `text` encoded as UTF-8, a lone surrogate as U+FFFD. */
  function utf8ByteLength(text: string): number {
    let length = 0;
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index);
      if (code < 0x80) length += 1;
      else if (code < 0x800) length += 2;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
        const next = text.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          length += 4;
          index += 1;
        } else {
          length += 3;
        }
      } else {
        length += 3;
      }
    }
    return length;
  }

  function normalizeCloseArguments(
    argumentCount: number,
    code?: number,
    reason?: string
  ): { frameCode?: number; eventCode: number; reason: string } {
    if (argumentCount >= 2 && code === undefined) {
      throw new DOMException('The WebSocket close code must be specified when a reason is provided.', 'SyntaxError');
    }
    const hasStatusCode = !(argumentCount === 0 || code === undefined);
    return {
      frameCode: hasStatusCode ? code : undefined,
      eventCode: hasStatusCode ? code! : 1005,
      reason: argumentCount >= 2 ? String(reason ?? '') : ''
    };
  }

  function validateCloseArguments(code: number | undefined, reason: string): void {
    if (code !== undefined && (!Number.isInteger(code) || (code !== 1000 && (code < 3000 || code > 4999)))) {
      throw new DOMException('The WebSocket close code must be 1000 or between 3000 and 4999.', 'InvalidAccessError');
    }
    if (new TextEncoder().encode(String(reason ?? '')).byteLength > 123) {
      throw new DOMException('The WebSocket close reason must not be longer than 123 bytes.', 'SyntaxError');
    }
  }

  function webSocketKey(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }

  function validateProtocols(protocols?: ProtocolList): string[] {
    const list = Array.isArray(protocols) ? protocols.map(String) : protocols ? [String(protocols)] : [];
    const seen = new Set();
    for (const protocol of list) {
      if (seen.has(protocol) || !isValidProtocolToken(protocol)) {
        throw new DOMException('The WebSocket protocol is invalid.', 'SyntaxError');
      }
      seen.add(protocol);
    }
    return list;
  }

  function isValidProtocolToken(protocol: string): boolean {
    if (protocol.length === 0) return false;
    for (let index = 0; index < protocol.length; index += 1) {
      const code = protocol.charCodeAt(index);
      const alphanumeric = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
      if (alphanumeric || "!#$%&'*+-.^_\`|~".includes(protocol[index])) continue;
      return false;
    }
    return true;
  }

  function matchingPublishedEndpointRoute(
    url: string | URL
  ): PublishedEndpointDocumentSocketRoute | undefined {
    let parsed;
    try {
      parsed = new URL(url, window.location.href);
    } catch {
      return undefined;
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') return undefined;
    const document = new URL(window.location.href);
    for (const endpoint of manifest.routes) {
      const publicUrl = new URL(endpoint.url);
      const publicPrefix = publicUrl.pathname;
      const documentOwned = document.origin === publicUrl.origin && pathHasPrefix(document.pathname, publicPrefix);
      if (!documentOwned) continue;
      if (isPublishedPublicWebSocketTarget(parsed, publicUrl)) {
        return { endpoint, path: stripProjectedPrefix(parsed.pathname, publicPrefix) + parsed.search };
      }
      const expectedProtocol = endpoint.protocol === 'https' ? 'wss:' : 'ws:';
      if (
        parsed.protocol === expectedProtocol &&
        parsed.port === String(endpoint.address.port) &&
        hostsMatch(parsed.hostname, endpoint.address.host)
      ) {
        return { endpoint, path: (parsed.pathname || '/') + parsed.search };
      }
      if (isLoopbackHost(normalizeHost(parsed.hostname))) {
        return {
          endpoint,
          path: (parsed.pathname || '/') + parsed.search,
          loopbackPort: parsed.port ? Number(parsed.port) : parsed.protocol === 'wss:' ? 443 : 80
        };
      }
    }
    return undefined;
  }

  function pathHasPrefix(pathname: string, prefix: string): boolean {
    return pathname === prefix || pathname.startsWith(prefix.endsWith('/') ? prefix : prefix + '/');
  }

  function stripProjectedPrefix(pathname: string, prefix: string): string {
    if (!pathHasPrefix(pathname, prefix)) return pathname || '/';
    const remainder = pathname.slice(prefix.length);
    return remainder.startsWith('/') ? remainder : '/' + remainder;
  }

  function isPublishedPublicWebSocketTarget(target: URL, publicUrl: URL): boolean {
    const expectedProtocol = publicUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return target.protocol === expectedProtocol && target.hostname === publicUrl.hostname && target.port === publicUrl.port;
  }

  function hostsMatch(actual: string, expected: string): boolean {
    const normalizedActual = normalizeHost(actual);
    const normalizedExpected = normalizeHost(expected);
    return normalizedActual === normalizedExpected || (isLoopbackHost(normalizedActual) && isLoopbackHost(normalizedExpected));
  }

  function normalizeHost(host: string): string {
    return host.toLowerCase().replace(/^\[|\]$/g, '');
  }

  function isLoopbackHost(host: string): boolean {
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  window.WebSocket = PublishedEndpointDocumentWebSocket as unknown as typeof WebSocket;
  console.debug(
    '[mimic] installed Published Endpoint document WebSocket transport',
    manifest.epochId
  );
}

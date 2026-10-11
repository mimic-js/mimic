import type {
  PublishedEndpointServer,
  PublishedEndpointWebSocketConnection,
  PublishedHttpRequest,
  PublishedHttpResponseHead,
  PublishedWebSocketClientMessage,
  PublishedWebSocketServerMessage
} from './types';

/**
 * Unacknowledged bytes of server messages on the document's port beyond which
 * the server's further writes wait until the document has dispatched them.
 */
export const PUBLISHED_WEBSOCKET_HIGH_WATER_MARK = 1024 * 1024;

/** How long the closing handshake may take before the connection is dropped. */
const CLOSING_HANDSHAKE_TIMEOUT_MS = 5_000;

/** Acknowledgements are batched once this many are pending, or at the next task. */
const ACK_BATCH = 32;

type SessionPhase = 'connecting' | 'open' | 'closing' | 'closed';

type ServerFrame = {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Uint8Array<ArrayBuffer>;
};

type FrameFailure = { readonly failure: { readonly code: number; readonly reason: string } };

export type PublishedWebSocketSessionOptions = {
  readonly server: PublishedEndpointServer;
  readonly request: PublishedHttpRequest;
  /** The document's end of the socket's port. */
  readonly client: MessagePort;
  /** The Web Lock the document holds while it lives. */
  readonly documentLock?: string;
  /** The Web Lock this worker holds while it lives, which the document watches. */
  readonly processLock?: string;
  readonly locks?: LockManager;
};

/**
 * Serves one published WebSocket to a document from the process worker that
 * owns its listener (ADR-0038). The server's `upgrade` socket speaks RFC 6455,
 * so this side is the WebSocket client: it masks the document's messages into
 * frames, reads the server's frames, answers pings and close frames, and
 * gives the document whole messages. Each direction is acknowledged by count,
 * which drives the document's `bufferedAmount` and holds the server's writes
 * while the document has not read them.
 *
 * Resolves with the server's response head, or `undefined` when the socket
 * closed before it.
 */
export function servePublishedWebSocket(
  options: PublishedWebSocketSessionOptions
): Promise<PublishedHttpResponseHead | undefined> {
  const { client } = options;
  const requestedProtocols = headerValue(options.request.headers, 'sec-websocket-protocol')
    ?.split(',')
    .map((protocol) => protocol.trim())
    .filter(Boolean) ?? [];
  const reader = new ServerFrameReader();
  const textDecoder = new TextDecoder('utf-8', { fatal: true });
  const textEncoder = new TextEncoder();
  const unacknowledged: number[] = [];
  let unacknowledgedBytes = 0;
  let serverHeld = false;
  let delivered = 0;
  let ackTimer: ReturnType<typeof setTimeout> | undefined;
  let fragments: { readonly opcode: number; readonly chunks: Uint8Array[] } | undefined;
  let phase: SessionPhase = 'connecting';
  let closeSent = false;
  let reported = false;
  let closingTimer: ReturnType<typeof setTimeout> | undefined;
  const lockWatch = new AbortController();
  let resolveHead!: (head: PublishedHttpResponseHead | undefined) => void;
  const head = new Promise<PublishedHttpResponseHead | undefined>((resolve) => {
    resolveHead = resolve;
  });

  const post = (message: PublishedWebSocketServerMessage, transfer: Transferable[] = []): void => {
    try {
      client.postMessage(message, transfer);
    } catch {
      // The document is gone; its lock, or the server's close, ends the session.
    }
  };
  /** The document's `close` event, once: what a browser reports for this connection. */
  const report = (code: number, reason: string, wasClean: boolean): void => {
    if (reported) return;
    reported = true;
    flushAck();
    post({ type: 'close', code, reason, wasClean });
  };
  const flushAck = (): void => {
    if (ackTimer !== undefined) clearTimeout(ackTimer);
    ackTimer = undefined;
    if (delivered === 0 || reported) return;
    post({ type: 'ack', count: delivered });
    delivered = 0;
  };
  const acknowledgeSend = (): void => {
    delivered += 1;
    if (delivered >= ACK_BATCH) flushAck();
    else ackTimer ??= setTimeout(flushAck, 0);
  };

  const finish = (): void => {
    if (phase === 'closed') return;
    if (phase === 'connecting') resolveHead(undefined);
    phase = 'closed';
    report(1006, '', false);
    if (closingTimer !== undefined) clearTimeout(closingTimer);
    if (ackTimer !== undefined) clearTimeout(ackTimer);
    lockWatch.abort();
    client.removeEventListener('message', onClientMessage);
    client.close();
  };
  /** Waits for the server to close the socket after the close frames, as a TCP client does. */
  const awaitServerClose = (): void => {
    if (closingTimer !== undefined) return;
    closingTimer = setTimeout(() => connection.close(), CLOSING_HANDSHAKE_TIMEOUT_MS);
  };
  const sendFrame = (opcode: number, payload: Uint8Array, onDelivered?: () => void): void => {
    connection.send(encodeClientFrame(opcode, payload), onDelivered);
  };
  const sendClose = (code: number | undefined, reason: string): void => {
    if (closeSent) return;
    closeSent = true;
    sendFrame(8, closePayload(code, reason, textEncoder));
  };
  /** Fails the connection (RFC 6455 section 7.1.7): a close frame, then the socket. */
  const fail = (code: number, reason: string): void => {
    if (phase === 'closed') return;
    report(1006, '', false);
    sendClose(code, reason);
    phase = 'closing';
    connection.end();
    awaitServerClose();
  };

  const deliverMessage = (opcode: number, payload: Uint8Array<ArrayBuffer>): boolean => {
    let data: string | ArrayBuffer;
    if (opcode === 1) {
      try {
        data = textDecoder.decode(payload);
      } catch {
        fail(1007, 'Invalid WebSocket text frame UTF-8');
        return false;
      }
    } else {
      data = payload.buffer;
    }
    unacknowledged.push(payload.byteLength);
    unacknowledgedBytes += payload.byteLength;
    post({ type: 'message', data }, typeof data === 'string' ? [] : [data]);
    return true;
  };
  const receiveClose = (payload: Uint8Array): void => {
    const close = parseClosePayload(payload, textDecoder);
    if ('failure' in close) {
      fail(close.failure.code, close.failure.reason);
      return;
    }
    // A close frame answering the document's own is the end of the handshake.
    if (!closeSent) {
      report(close.code, close.reason, true);
      sendClose(close.code === 1005 ? undefined : close.code, '');
    }
    phase = 'closing';
    awaitServerClose();
  };
  const receiveFrame = (frame: ServerFrame): boolean => {
    const { opcode, fin, payload } = frame;
    if (opcode === 8) {
      receiveClose(payload);
      return false;
    }
    if (opcode === 9) {
      if (!closeSent) sendFrame(10, payload);
      return true;
    }
    if (opcode === 10) return true;
    if (opcode === 0) {
      if (!fragments) {
        fail(1002, 'Unexpected WebSocket continuation frame');
        return false;
      }
      fragments.chunks.push(payload);
      if (!fin) return true;
      const message = concatBytes(fragments.chunks);
      const messageOpcode = fragments.opcode;
      fragments = undefined;
      return deliverMessage(messageOpcode, message);
    }
    if (fragments) {
      fail(1002, 'Interleaved fragmented WebSocket message');
      return false;
    }
    if (!fin) {
      fragments = { opcode, chunks: [payload] };
      return true;
    }
    return deliverMessage(opcode, payload);
  };
  const receiveServerBytes = (bytes: Uint8Array): void => {
    // Past a close frame, sent or received, the server's frames are not read.
    if (phase !== 'open') return;
    reader.push(bytes);
    for (;;) {
      const frame = reader.next();
      if (!frame) return;
      if ('failure' in frame) {
        fail(frame.failure.code, frame.failure.reason);
        return;
      }
      if (!receiveFrame(frame)) return;
    }
  };

  // The server's `upgrade` handler runs while the socket opens, so the
  // observer may act on the connection before `openWebSocket` returns it.
  let opened: PublishedEndpointWebSocketConnection | undefined;
  const early: ((connection: PublishedEndpointWebSocketConnection) => void)[] = [];
  const onConnection = (operation: (connection: PublishedEndpointWebSocketConnection) => void): void => {
    if (opened) operation(opened);
    else early.push(operation);
  };
  const connection: PublishedEndpointWebSocketConnection = {
    send: (bytes, onDelivered) => onConnection((target) => target.send(bytes, onDelivered)),
    resume: () => onConnection((target) => target.resume()),
    end: () => onConnection((target) => target.end()),
    close: () => onConnection((target) => target.close())
  };
  opened = options.server.openWebSocket(options.request, {
    onHead(response) {
      if (phase !== 'connecting') return;
      resolveHead(response);
      const accepted = headerValue(response.headers, 'sec-websocket-protocol')?.trim() ?? '';
      if (
        response.status !== 101 ||
        (accepted !== '' && !requestedProtocols.includes(accepted)) ||
        // The handshake offered no extension, so the server may accept none.
        headerValue(response.headers, 'sec-websocket-extensions') !== undefined
      ) {
        connection.close();
        return;
      }
      phase = 'open';
      post({
        type: 'open',
        protocol: accepted,
        ...(options.processLock ? { lock: options.processLock } : {})
      });
    },
    onData(bytes) {
      receiveServerBytes(bytes);
      serverHeld = unacknowledgedBytes >= PUBLISHED_WEBSOCKET_HIGH_WATER_MARK;
      return !serverHeld;
    },
    onEnd() {
      // The server closed its side: without a close frame the connection
      // closed abnormally, and either way the client closes its side.
      connection.close();
    },
    onClose: finish
  });
  for (const operation of early.splice(0)) operation(opened);

  const onClientMessage = (event: MessageEvent): void => {
    const message = event.data as Partial<PublishedWebSocketClientMessage> | null;
    if (typeof message !== 'object' || message === null || phase === 'closed') return;
    switch (message.type) {
      case 'send': {
        if (phase !== 'open' || closeSent) return;
        const data = (message as { data?: unknown }).data;
        if (typeof data === 'string') sendFrame(1, textEncoder.encode(data), acknowledgeSend);
        else if (data instanceof ArrayBuffer) sendFrame(2, new Uint8Array(data), acknowledgeSend);
        return;
      }
      case 'ack': {
        const count = (message as { count?: unknown }).count;
        if (typeof count !== 'number' || !Number.isInteger(count) || count < 1) return;
        for (let index = 0; index < count && unacknowledged.length > 0; index += 1) {
          unacknowledgedBytes -= unacknowledged.shift()!;
        }
        if (serverHeld && unacknowledgedBytes < PUBLISHED_WEBSOCKET_HIGH_WATER_MARK) {
          serverHeld = false;
          connection.resume();
        }
        return;
      }
      case 'close': {
        // The document reports its own close event; the server still gets the
        // closing handshake.
        reported = true;
        if (phase === 'connecting') {
          connection.close();
          return;
        }
        if (phase !== 'open') return;
        const code = (message as { code?: unknown }).code;
        const reason = (message as { reason?: unknown }).reason;
        sendClose(
          typeof code === 'number' && Number.isInteger(code) ? code : undefined,
          typeof reason === 'string' ? reason : ''
        );
        phase = 'closing';
        awaitServerClose();
        return;
      }
      case 'abort':
        reported = true;
        connection.close();
        return;
    }
  };
  client.addEventListener('message', onClientMessage);
  client.start();
  watchDocument(options, lockWatch.signal, () => connection.close());
  return head;
}

/**
 * Closes the connection once the document's lock is released, which is when
 * the document is gone, unloaded or crashed (ADR-0038). A lock the document's
 * lock manager holds but this worker's cannot see, as for a document opened
 * in a tab of another storage partition, is not watched.
 */
function watchDocument(
  options: PublishedWebSocketSessionOptions,
  signal: AbortSignal,
  onGone: () => void
): void {
  const { documentLock, locks } = options;
  if (!documentLock || !locks) return;
  void (async () => {
    const state = await locks.query();
    if (signal.aborted || !state.held?.some((lock) => lock.name === documentLock)) return;
    await locks.request(documentLock, { mode: 'shared', signal }, () => {
      if (!signal.aborted) onGone();
    });
  })().catch(() => undefined);
}

/** Reads a server's frames from the bytes of its socket, copying each payload once. */
export class ServerFrameReader {
  #chunks: Uint8Array[] = [];
  #offset = 0;
  #buffered = 0;

  push(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.#chunks.push(bytes);
    this.#buffered += bytes.byteLength;
  }

  /** The next whole frame, a failure, or `undefined` until more bytes arrive. */
  next(): ServerFrame | FrameFailure | undefined {
    if (this.#buffered < 2) return undefined;
    const header = this.#peek(Math.min(this.#buffered, 10));
    const first = header[0];
    const second = header[1];
    let length = second & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      if (header.byteLength < 4) return undefined;
      length = (header[2] << 8) | header[3];
      headerLength = 4;
    } else if (length === 127) {
      if (header.byteLength < 10) return undefined;
      length = readUint32(header, 2) * 2 ** 32 + readUint32(header, 6);
      headerLength = 10;
    }
    const masked = (second & 0x80) !== 0;
    const total = headerLength + (masked ? 4 : 0) + length;
    if (this.#buffered < total) return undefined;
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if (masked) return failure(1002, 'Masked WebSocket frames from the server are invalid');
    if ((first & 0x70) !== 0) return failure(1002, 'Reserved WebSocket frame bits are set');
    if (opcode >= 8) {
      if (!fin) return failure(1002, 'Fragmented WebSocket control frames are invalid');
      if (length > 125) return failure(1002, 'Oversized WebSocket control frames are invalid');
    }
    if ((opcode > 2 && opcode < 8) || opcode > 10) {
      return failure(1002, 'Reserved WebSocket opcode ' + opcode);
    }
    this.#skip(headerLength);
    return { fin, opcode, payload: this.#take(length) };
  }

  #peek(count: number): Uint8Array {
    const first = this.#chunks[0];
    if (first.byteLength - this.#offset >= count) {
      return first.subarray(this.#offset, this.#offset + count);
    }
    const bytes = new Uint8Array(count);
    let filled = 0;
    let offset = this.#offset;
    for (const chunk of this.#chunks) {
      const part = chunk.subarray(offset, offset + count - filled);
      bytes.set(part, filled);
      filled += part.byteLength;
      offset = 0;
      if (filled === count) break;
    }
    return bytes;
  }

  #skip(count: number): void {
    this.#consume(count, undefined);
  }

  #take(count: number): Uint8Array<ArrayBuffer> {
    const payload = new Uint8Array(count);
    this.#consume(count, payload);
    return payload;
  }

  #consume(count: number, target: Uint8Array | undefined): void {
    let remaining = count;
    let written = 0;
    while (remaining > 0) {
      const chunk = this.#chunks[0];
      const available = chunk.byteLength - this.#offset;
      const used = Math.min(available, remaining);
      target?.set(chunk.subarray(this.#offset, this.#offset + used), written);
      written += used;
      remaining -= used;
      this.#offset += used;
      if (this.#offset === chunk.byteLength) {
        this.#chunks.shift();
        this.#offset = 0;
      }
    }
    this.#buffered -= count;
  }
}

function failure(code: number, reason: string): FrameFailure {
  return { failure: { code, reason } };
}

/** A client frame: masked with a fresh key, as RFC 6455 requires of a client. */
export function encodeClientFrame(opcode: number, payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = payload.byteLength;
  const headerLength = length < 126 ? 2 : length <= 0xffff ? 4 : 10;
  const frame = new Uint8Array(headerLength + 4 + length);
  frame[0] = 0x80 | opcode;
  if (length < 126) {
    frame[1] = 0x80 | length;
  } else if (length <= 0xffff) {
    frame[1] = 0x80 | 126;
    frame[2] = length >>> 8;
    frame[3] = length & 0xff;
  } else {
    frame[1] = 0x80 | 127;
    writeUint32(frame, 2, Math.floor(length / 2 ** 32));
    writeUint32(frame, 6, length >>> 0);
  }
  const mask = frame.subarray(headerLength, headerLength + 4);
  crypto.getRandomValues(mask);
  const m0 = mask[0];
  const m1 = mask[1];
  const m2 = mask[2];
  const m3 = mask[3];
  const offset = headerLength + 4;
  let index = 0;
  for (; index + 4 <= length; index += 4) {
    frame[offset + index] = payload[index] ^ m0;
    frame[offset + index + 1] = payload[index + 1] ^ m1;
    frame[offset + index + 2] = payload[index + 2] ^ m2;
    frame[offset + index + 3] = payload[index + 3] ^ m3;
  }
  for (; index < length; index += 1) frame[offset + index] = payload[index] ^ mask[index & 3];
  return frame;
}

function closePayload(code: number | undefined, reason: string, encoder: TextEncoder): Uint8Array {
  if (code === undefined) return new Uint8Array();
  const reasonBytes = encoder.encode(reason);
  const payload = new Uint8Array(2 + reasonBytes.byteLength);
  payload[0] = (code >>> 8) & 0xff;
  payload[1] = code & 0xff;
  payload.set(reasonBytes, 2);
  return payload;
}

function parseClosePayload(
  payload: Uint8Array,
  decoder: TextDecoder
): { readonly code: number; readonly reason: string } | FrameFailure {
  if (payload.byteLength === 0) return { code: 1005, reason: '' };
  if (payload.byteLength === 1) return failure(1002, 'Invalid WebSocket close status code');
  const code = (payload[0] << 8) | payload[1];
  if (!isValidReceivedCloseCode(code)) return failure(1002, 'Invalid WebSocket close status code');
  try {
    return { code, reason: decoder.decode(payload.subarray(2)) };
  } catch {
    return failure(1007, 'Invalid WebSocket close reason UTF-8');
  }
}

function isValidReceivedCloseCode(code: number): boolean {
  if (code < 1000 || code >= 5000) return false;
  return code !== 1004 && code !== 1005 && code !== 1006 && code !== 1015;
}

function headerValue(
  headers: readonly (readonly [string, string])[],
  name: string
): string | undefined {
  const values = headers.filter(([candidate]) => candidate.toLowerCase() === name).map(([, value]) => value);
  return values.length > 0 ? values.join(', ') : undefined;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function writeUint32(bytes: Uint8Array, offset: number, value: number): void {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

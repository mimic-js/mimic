import { afterEach, describe, expect, test } from 'vitest';
import {
  PUBLISHED_WEBSOCKET_HIGH_WATER_MARK,
  ServerFrameReader,
  encodeClientFrame,
  servePublishedWebSocket
} from './websocket-session';
import type {
  PublishedEndpointServer,
  PublishedEndpointWebSocketConnectionObserver,
  PublishedWebSocketClientMessage,
  PublishedWebSocketServerMessage
} from './types';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const ports: MessagePort[] = [];

afterEach(() => {
  for (const port of ports.splice(0)) port.close();
});

describe('servePublishedWebSocket', () => {
  test('opens with the accepted subprotocol and carries whole messages both ways', async () => {
    const session = openSession(['chat', 'json']);
    session.observer.onHead(switching([['sec-websocket-protocol', 'json']]));
    const head = await session.head;
    expect(head?.status).toBe(101);

    session.observer.onData(concat(frame(1, encoder.encode('hel'), false), frame(0, encoder.encode('lo'))));
    session.observer.onData(frame(2, new Uint8Array([1, 2, 3])));
    session.send({ type: 'send', data: 'ping' });
    session.send({ type: 'send', data: new Uint8Array([9, 8]).buffer });
    await settle();

    expect(session.received).toEqual([
      { type: 'open', protocol: 'json', lock: 'process-lock' },
      { type: 'message', data: 'hello' },
      { type: 'message', data: new Uint8Array([1, 2, 3]).buffer },
      { type: 'ack', count: 2 }
    ]);
    expect(session.clientFrames()).toEqual([
      { opcode: 1, payload: 'ping' },
      { opcode: 2, payload: '9,8' }
    ]);
  });

  test('answers a ping and a server close frame, then closes once the server ends', async () => {
    const session = openSession();
    session.observer.onHead(switching());
    session.observer.onData(frame(9, encoder.encode('beat')));
    session.observer.onData(closeFrame(4000, 'bye'));
    await settle();

    expect(session.received).toEqual([
      { type: 'open', protocol: '', lock: 'process-lock' },
      { type: 'close', code: 4000, reason: 'bye', wasClean: true }
    ]);
    expect(session.clientFrames()).toEqual([
      { opcode: 10, payload: 'beat' },
      { opcode: 8, payload: closePayloadText(4000, '') }
    ]);
    session.observer.onEnd();
    expect(session.calls).toContain('close');
  });

  test('reports a server that ends without a close frame as an abnormal closure', async () => {
    const session = openSession();
    session.observer.onHead(switching());
    session.observer.onEnd();
    await settle();
    expect(session.received.at(-1)).toEqual({ type: 'close', code: 1006, reason: '', wasClean: false });
  });

  test.each([
    ['a masked server frame', maskedFrame(1, encoder.encode('x')), 1002, 'Masked WebSocket frames from the server are invalid'],
    ['invalid UTF-8 text', frame(1, new Uint8Array([0xc3, 0x28])), 1007, 'Invalid WebSocket text frame UTF-8'],
    ['a reserved opcode', frame(3, new Uint8Array()), 1002, 'Reserved WebSocket opcode 3'],
    ['a fragmented ping', frame(9, new Uint8Array(), false), 1002, 'Fragmented WebSocket control frames are invalid'],
    ['a one-byte close frame', frame(8, new Uint8Array([3])), 1002, 'Invalid WebSocket close status code'],
    ['an invalid close reason', frame(8, new Uint8Array([3, 0xe8, 0xc3, 0x28])), 1007, 'Invalid WebSocket close reason UTF-8']
  ])('fails the connection on %s', async (_label, bytes, code, reason) => {
    const session = openSession();
    session.observer.onHead(switching());
    session.observer.onData(bytes);
    await settle();
    expect(session.received.at(-1)).toEqual({ type: 'close', code: 1006, reason: '', wasClean: false });
    expect(session.clientFrames().at(-1)).toEqual({ opcode: 8, payload: closePayloadText(code, reason) });
    expect(session.calls).toContain('end');
  });

  test('refuses a handshake whose subprotocol the document did not request', async () => {
    const session = openSession(['chat']);
    session.observer.onHead(switching([['sec-websocket-protocol', 'other']]));
    await settle();
    expect(session.calls).toEqual(['close']);
    expect(session.received).toEqual([{ type: 'close', code: 1006, reason: '', wasClean: false }]);
  });

  test('holds the server\'s writes past the high-water mark until the document acknowledges them', async () => {
    const session = openSession();
    session.observer.onHead(switching());
    const half = new Uint8Array(PUBLISHED_WEBSOCKET_HIGH_WATER_MARK / 2);
    expect(session.observer.onData(frame(2, half))).toBe(true);
    expect(session.observer.onData(frame(2, half))).toBe(false);
    session.send({ type: 'ack', count: 1 });
    await settle();
    expect(session.calls).toEqual(['resume']);
  });

  test('sends the closing handshake the document starts and an empty close frame without a code', async () => {
    const session = openSession();
    session.observer.onHead(switching());
    session.send({ type: 'close', reason: '' });
    session.send({ type: 'send', data: 'late' });
    await settle();
    expect(session.clientFrames()).toEqual([{ opcode: 8, payload: '' }]);
    expect(session.received).toEqual([{ type: 'open', protocol: '', lock: 'process-lock' }]);
  });

  test('drops a connection the document abandons while it opens', async () => {
    const session = openSession();
    session.send({ type: 'close', reason: '' });
    await settle();
    expect(session.calls).toEqual(['close']);
    expect(await session.head).toBeUndefined();
  });
});

describe('ServerFrameReader', () => {
  test('reads a frame split across chunks and frames sharing one chunk', () => {
    const reader = new ServerFrameReader();
    const long = frame(2, new Uint8Array(300).fill(7));
    reader.push(long.subarray(0, 1));
    expect(reader.next()).toBeUndefined();
    reader.push(long.subarray(1, 3));
    expect(reader.next()).toBeUndefined();
    reader.push(concat(long.subarray(3), frame(1, encoder.encode('a'))));
    const first = reader.next();
    expect(first && 'payload' in first ? first.payload.byteLength : -1).toBe(300);
    const second = reader.next();
    expect(second && 'payload' in second ? decoder.decode(second.payload) : '').toBe('a');
    expect(reader.next()).toBeUndefined();
  });

  test('masks client frames with a key the payload decodes from', () => {
    const payload = encoder.encode('x'.repeat(70_000));
    const encoded = encodeClientFrame(1, payload);
    expect(encoded[1]).toBe(0x80 | 127);
    expect(decodeClientFrames(encoded)).toEqual([{ opcode: 1, payload: 'x'.repeat(70_000) }]);
  });
});

function openSession(protocols: string[] = []) {
  const channel = new MessageChannel();
  ports.push(channel.port1, channel.port2);
  const received: PublishedWebSocketServerMessage[] = [];
  channel.port1.onmessage = (event) => received.push(event.data as PublishedWebSocketServerMessage);
  const written: Uint8Array[] = [];
  const calls: string[] = [];
  let observer!: PublishedEndpointWebSocketConnectionObserver;
  const server: PublishedEndpointServer = {
    address: { host: '127.0.0.1', port: 5173 },
    serveHttp: () => Promise.reject(new Error('unused')),
    openWebSocket(_request, connectionObserver) {
      observer = connectionObserver;
      return {
        send(bytes, delivered) {
          written.push(bytes);
          delivered?.();
        },
        resume: () => calls.push('resume'),
        end: () => calls.push('end'),
        close() {
          calls.push('close');
          connectionObserver.onClose();
        }
      };
    },
    close: () => undefined
  };
  const head = servePublishedWebSocket({
    server,
    request: {
      method: 'GET',
      url: '/socket',
      headers: protocols.length > 0 ? [['sec-websocket-protocol', protocols.join(', ')]] : []
    },
    client: channel.port2,
    processLock: 'process-lock'
  });
  return {
    head,
    observer,
    received,
    calls,
    send: (message: PublishedWebSocketClientMessage) => channel.port1.postMessage(message),
    clientFrames: () => written.flatMap((bytes) => decodeClientFrames(bytes))
  };
}

/** A few tasks, so port messages and the acknowledgements they schedule arrive. */
async function settle(): Promise<void> {
  for (let round = 0; round < 5; round += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

function switching(headers: [string, string][] = []) {
  return {
    status: 101,
    statusText: 'Switching Protocols',
    headers: [['upgrade', 'websocket'], ['connection', 'Upgrade'], ...headers] as [string, string][]
  };
}

function frame(opcode: number, payload: Uint8Array, fin = true): Uint8Array {
  const headerLength = payload.byteLength < 126 ? 2 : payload.byteLength <= 0xffff ? 4 : 10;
  const output = new Uint8Array(headerLength + payload.byteLength);
  output[0] = (fin ? 0x80 : 0) | opcode;
  if (payload.byteLength < 126) {
    output[1] = payload.byteLength;
  } else if (payload.byteLength <= 0xffff) {
    output[1] = 126;
    output[2] = payload.byteLength >>> 8;
    output[3] = payload.byteLength & 0xff;
  } else {
    output[1] = 127;
    new DataView(output.buffer).setUint32(6, payload.byteLength);
  }
  output.set(payload, headerLength);
  return output;
}

function maskedFrame(opcode: number, payload: Uint8Array): Uint8Array {
  const output = new Uint8Array(6 + payload.byteLength);
  output[0] = 0x80 | opcode;
  output[1] = 0x80 | payload.byteLength;
  output.set(payload, 6);
  return output;
}

function closeFrame(code: number, reason: string): Uint8Array {
  const reasonBytes = encoder.encode(reason);
  return frame(8, concat(new Uint8Array([code >>> 8, code & 0xff]), reasonBytes));
}

function closePayloadText(code: number, reason: string): string {
  return decoder.decode(concat(new Uint8Array([code >>> 8, code & 0xff]), encoder.encode(reason)));
}

function decodeClientFrames(bytes: Uint8Array): { opcode: number; payload: string }[] {
  const frames: { opcode: number; payload: string }[] = [];
  let offset = 0;
  while (offset < bytes.byteLength) {
    const opcode = bytes[offset] & 0x0f;
    expect(bytes[offset + 1] & 0x80).toBe(0x80);
    let length = bytes[offset + 1] & 0x7f;
    let header = 2;
    if (length === 126) {
      length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      header = 4;
    } else if (length === 127) {
      length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset + 6);
      header = 10;
    }
    const mask = bytes.subarray(offset + header, offset + header + 4);
    const payload = bytes.slice(offset + header + 4, offset + header + 4 + length);
    for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4];
    frames.push({ opcode, payload: opcode === 2 ? [...payload].join(',') : decoder.decode(payload) });
    offset += header + 4 + length;
  }
  return frames;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.byteLength;
  }
  return output;
}

import { describe, expect, test } from 'vitest';

import {
  Http1ChunkBodyDecoder,
  concatHttp1Bytes,
  parseHttp1RequestHead,
  parseHttp1ResponseHead,
  serializeHttp1Chunk,
  serializeHttp1ChunkTerminator,
  serializeHttp1RequestHead,
  serializeHttp1ResponseHead
} from '../../src/runtime/modules/http-1-wire-codec';

describe('HTTP/1 wire codec', () => {
  test('waits for a fragmented request head and preserves its byte boundary', () => {
    const encoder = new TextEncoder();
    const first = encoder.encode('POST /binary HTTP/1.1\r\nHost: local');
    const complete = concatHttp1Bytes([
      encoder.encode('POST /binary HTTP/1.1\r\nHost: localhost\r\nContent-Length: 3\r\n\r\n'),
      new Uint8Array([0x00, 0xff, 0x78])
    ]);

    expect(parseHttp1RequestHead(first)).toBeUndefined();
    expect(parseHttp1RequestHead(complete)).toEqual({
      method: 'POST',
      path: '/binary',
      version: 'HTTP/1.1',
      headers: [
        ['host', 'localhost'],
        ['content-length', '3']
      ],
      contentLength: 3,
      bodyStart: 61,
      chunked: false,
      upgrade: false
    });
  });

  test('recognizes chunked request framing without inventing a content length', () => {
    const parsed = parseHttp1RequestHead(
      new TextEncoder().encode('POST /stream HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n')
    );

    expect(parsed).toMatchObject({ path: '/stream', contentLength: 0, chunked: true });
  });

  test('rejects invalid Content-Length values instead of silently guessing a body boundary', () => {
    const bytes = new TextEncoder().encode('POST / HTTP/1.1\r\nContent-Length: three\r\n\r\n');

    try {
      parseHttp1RequestHead(bytes);
      throw new Error('expected invalid Content-Length to throw');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'HPE_INVALID_CONTENT_LENGTH',
        message: 'Invalid Content-Length: three'
      });
    }
  });

  test('rejects a request line that is not HTTP/1', () => {
    for (const head of ['NOT A REQUEST LINE\r\n\r\n', 'GET / HTTP/9.9\r\nHost: localhost\r\n\r\n']) {
      expect(() => parseHttp1RequestHead(new TextEncoder().encode(head))).toThrowError(
        expect.objectContaining({ code: 'HPE_INVALID_METHOD' })
      );
    }
  });

  test('rejects conflicting response Content-Length values', () => {
    const bytes = new TextEncoder().encode('HTTP/1.1 200 OK\r\nContent-Length: 1\r\ncontent-length: 2\r\n\r\n');

    try {
      parseHttp1ResponseHead(bytes);
      throw new Error('expected conflicting Content-Length values to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'HPE_UNEXPECTED_CONTENT_LENGTH' });
    }
  });

  test('serializes heads exactly and exposes protocol-switch bytes after a complete 101 head', () => {
    const encoder = new TextEncoder();
    expect(serializeHttp1RequestHead({ method: 'GET', path: '/socket', headers: [['host', 'localhost:5173']] })).toEqual(
      encoder.encode('GET /socket HTTP/1.1\r\nhost: localhost:5173\r\n\r\n')
    );
    expect(serializeHttp1ResponseHead({ status: 204, statusText: 'No Content', headers: [['connection', 'close']] })).toEqual(
      encoder.encode('HTTP/1.1 204 No Content\r\nconnection: close\r\n\r\n')
    );

    const response = concatHttp1Bytes([
      encoder.encode('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'),
      new Uint8Array([0x81, 0x01, 0xff])
    ]);
    const head = parseHttp1ResponseHead(response);

    expect(head).toMatchObject({ status: 101, statusText: 'Switching Protocols', bodyStart: 77, chunked: false });
    expect(response.slice(head!.bodyStart)).toEqual(new Uint8Array([0x81, 0x01, 0xff]));
  });

  test('decodes fragmented chunked bytes with extensions and trailers without decoding the binary body', () => {
    const chunks: Uint8Array[] = [];
    const trailers: unknown[] = [];
    let ended = false;
    const decoder = new Http1ChunkBodyDecoder(
      (chunk) => chunks.push(chunk),
      (nextTrailers) => trailers.push(nextTrailers),
      () => (ended = true)
    );
    const wire = concatHttp1Bytes([
      new TextEncoder().encode('2;chunk=one\r\n'),
      new Uint8Array([0x00, 0xff]),
      new TextEncoder().encode('\r\n'),
      serializeHttp1Chunk(new Uint8Array([0x78])),
      serializeHttp1ChunkTerminator([['x-checksum', 'ok']])
    ]);

    decoder.push(wire.slice(0, 5));
    decoder.push(wire.slice(5, wire.byteLength - 3));
    expect(decoder.complete).toBe(false);
    decoder.push(wire.slice(wire.byteLength - 3));

    expect(chunks).toEqual([new Uint8Array([0x00, 0xff]), new Uint8Array([0x78])]);
    expect(trailers).toEqual([[['x-checksum', 'ok']]]);
    expect(ended).toBe(true);
    expect(decoder.complete).toBe(true);
  });

  test('keeps truncated data incomplete and rejects malformed chunk framing', () => {
    const decoder = new Http1ChunkBodyDecoder(() => undefined, () => undefined, () => undefined);
    decoder.push(new TextEncoder().encode('3\r\nab'));
    expect(decoder.complete).toBe(false);

    const malformed = new Http1ChunkBodyDecoder(() => undefined, () => undefined, () => undefined);
    try {
      malformed.push(new TextEncoder().encode('1\r\naX\r'));
      throw new Error('expected malformed chunk framing to throw');
    } catch (error) {
      expect(error).toMatchObject({ code: 'HPE_INVALID_CHUNK_SIZE' });
    }

    const partiallyHex = new Http1ChunkBodyDecoder(() => undefined, () => undefined, () => undefined);
    expect(() => partiallyHex.push(new TextEncoder().encode('1g\r\na\r\n0\r\n\r\n'))).toThrowError(
      expect.objectContaining({ code: 'HPE_INVALID_CHUNK_SIZE' })
    );
  });
});

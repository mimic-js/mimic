import { describe, expect, test } from 'vitest';

import { createDnsBuiltin, type DnsLookupAddress, type DnsLookupOptions } from '../dns';
import { createHttp2Builtin } from '../http2';
import { createTlsBuiltin } from '../tls';

describe('Node Compatibility network capability boundaries', () => {
  test('resolves loopback deterministically through node:dns callbacks and promises', async () => {
    const dns = createDnsBuiltin();

    await expect(lookup(dns, 'localhost')).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(lookup(dns, 'localhost', { family: 6 })).resolves.toEqual({ address: '::1', family: 6 });
    await expect(lookup(dns, '::1')).resolves.toEqual({ address: '::1', family: 6 });
    await expect(lookup(dns, '127.0.0.42')).resolves.toEqual({ address: '127.0.0.42', family: 4 });
    await expect(lookup(dns, '127.0.0.1', { all: true })).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
    await expect(dns.promises.lookup('localhost')).resolves.toEqual({ address: '127.0.0.1', family: 4 });
    await expect(dns.promises.lookup('localhost', { all: true })).resolves.toEqual([{ address: '127.0.0.1', family: 4 }]);
    expect(dns.default.lookup).toBe(dns.lookup);
    expect(dns.default.promises).toBe(dns.promises);
  });

  test('reports external and record DNS resolution as explicitly unsupported', async () => {
    const dns = createDnsBuiltin();

    await expect(lookup(dns, 'example.com')).rejects.toMatchObject({ code: 'ENOTSUP', syscall: 'getaddrinfo' });
    await expect(dns.promises.resolve4('example.com')).rejects.toMatchObject({ code: 'ENOTSUP', syscall: 'getaddrinfo' });
    await expect(unsupportedDns(dns)).resolves.toMatchObject({ code: 'ENOTSUP', syscall: 'getaddrinfo' });
  });

  test('loads node:tls with client connections over Fetch while rejecting servers', () => {
    const tls = createTlsBuiltin();

    expect(typeof tls.connect).toBe('function');
    expect(tls.default.connect).toBe(tls.connect);
    expect(tls.default.TLSSocket).toBe(tls.TLSSocket);
    const socket = tls.connect(443, 'example.com') as { destroy(): void; readonly connecting: boolean };
    expect(socket.connecting).toBe(true);
    socket.destroy();
    const overSocket = tls.connect({ host: 'example.com', port: 443, socket: {} }) as { destroy(): void };
    expect(overSocket).toBeInstanceOf(tls.TLSSocket);
    overSocket.destroy();
    expect(() => tls.createServer()).toThrow(expect.objectContaining({ code: 'ENOTSUP', syscall: 'tls' }));
    expect(tls.createSecureContext()).toMatchObject({ context: {} });
    expect(tls.checkServerIdentity('example.com', {})).toBeUndefined();
    expect(new tls.TLSSocket()).toMatchObject({ encrypted: true, _handle: null });
  });

  test('loads node:http2 for feature detection while rejecting client and server creation', () => {
    const http2 = createHttp2Builtin();

    expect(typeof http2.connect).toBe('function');
    expect(http2.default.connect).toBe(http2.connect);
    expect({} instanceof http2.Http2ServerRequest).toBe(false);
    expect({} instanceof http2.Http2ServerResponse).toBe(false);
    expect(http2.default.createSecureServer).toBe(http2.createSecureServer);
    expect(http2.constants).toMatchObject({
      HTTP2_HEADER_LOCATION: 'location',
      HTTP2_HEADER_CONTENT_TYPE: 'content-type',
      HTTP2_HEADER_USER_AGENT: 'user-agent',
      HTTP_STATUS_REQUEST_TIMEOUT: 408,
      HTTP_STATUS_TOO_MANY_REQUESTS: 429,
      HTTP_STATUS_INTERNAL_SERVER_ERROR: 500
    });
    expect(http2.default.constants).toBe(http2.constants);
    expect(() => http2.connect('https://example.com')).toThrow(expect.objectContaining({ code: 'ENOTSUP', syscall: 'http2' }));
    expect(() => http2.createServer()).toThrow(expect.objectContaining({ code: 'ENOTSUP', syscall: 'http2' }));
    expect(() => http2.createSecureServer()).toThrow(expect.objectContaining({ code: 'ENOTSUP', syscall: 'http2' }));
    expect(() => new http2.Http2SecureServer()).toThrow(expect.objectContaining({ code: 'ENOTSUP', syscall: 'http2' }));
  });
});

function lookup(
  dns: ReturnType<typeof createDnsBuiltin>,
  hostname: string,
  options?: DnsLookupOptions
): Promise<DnsLookupAddress | readonly DnsLookupAddress[]> {
  return new Promise((resolve, reject) => {
    const callback = (
      error: Error | null,
      address?: string | readonly DnsLookupAddress[],
      family?: 4 | 6
    ) => {
      if (error) reject(error);
      else if (typeof address === 'string' && family !== undefined) resolve({ address, family });
      else if (Array.isArray(address)) resolve(address);
      else reject(new Error('Expected node:dns.lookup to return an address.'));
    };
    if (options === undefined) dns.lookup(hostname, callback);
    else dns.lookup(hostname, options, callback);
  });
}

function unsupportedDns(dns: ReturnType<typeof createDnsBuiltin>): Promise<Error> {
  return new Promise((resolve, reject) => {
    dns.resolve('example.com', (error: Error) => {
      if (error) resolve(error);
      else reject(new Error('Expected node:dns.resolve to report an unsupported operation.'));
    });
  });
}

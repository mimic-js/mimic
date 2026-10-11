import { describe, expect, test } from 'vitest';

import { createVirtualNetworkAuthority, isLoopbackHost } from './index';

describe('Virtual Network loopback', () => {
  test.each([
    '127.0.0.1',
    '127.0.0.2',
    '127.255.255.254',
    '0.0.0.0',
    '::1',
    '[::1]',
    '::',
    '::ffff:127.0.0.1',
    'localhost',
    'LocalHost',
    'app.localhost',
    'a.b.localhost',
    ''
  ])('treats %j as loopback', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  test.each([
    'example.com',
    'localhost.example.com',
    'notlocalhost',
    '127.0.0.1.nip.io',
    '128.0.0.1',
    '10.0.0.1',
    '1270.0.0.1',
    '::2',
    '::ffff:10.0.0.1'
  ])('treats %j as external', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  test('answers every loopback host itself instead of leaving it to the browser', async () => {
    const network = createVirtualNetworkAuthority();
    const listener = await network.listen({ ownerId: 'server', host: '127.0.0.1', port: 8443 });
    const accepted: string[] = [];
    listener.onConnection((socket) => accepted.push(socket.remoteAddress.host));

    // The unspecified address, `localhost` and `*.localhost` all reach a listener on 127.0.0.1.
    for (const host of ['0.0.0.0', 'localhost', 'app.localhost', '127.0.0.1']) {
      const client = network.connect({ ownerId: 'client', host, port: 8443 });
      await expect(client.connected).resolves.toBeUndefined();
      expect(client.remoteAddress).toEqual({ host: '127.0.0.1', port: 8443 });
    }
    expect(accepted).toEqual(['127.0.0.1', '127.0.0.1', '127.0.0.1', '127.0.0.1']);
    // Another 127/8 address is loopback but not where the listener is bound: refused, never external.
    await expect(
      network.connect({ ownerId: 'client', host: '127.0.0.2', port: 8443 }).connected
    ).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    await expect(
      network.connect({ ownerId: 'client', host: '0.0.0.0', port: 80 }).connected
    ).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    await expect(
      network.connect({ ownerId: 'client', host: 'app.localhost', port: 80 }).connected
    ).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    await expect(
      network.connect({ ownerId: 'client', host: '127.0.0.2', port: 8443, transport: 'tls' }).connected
    ).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await expect(
      network.connect({ ownerId: 'client', host: 'example.com', port: 443 }).connected
    ).rejects.toMatchObject({ code: 'EXTERNAL_TRANSPORT_UNSUPPORTED' });

    network.dispose();
  });
});

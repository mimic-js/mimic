import { describe, expect, test, vi } from 'vitest';

import {
  createVirtualNetworkAuthority,
  createVirtualNetworkClient,
  serveVirtualNetwork
} from '../../src/runtime/modules/virtual-network';
import { connectRpc } from '../../src/runtime/modules/worker-transport';

describe('Virtual Network', () => {
  test('connects a listener through byte-only duplex sockets', async () => {
    const network = createVirtualNetworkAuthority();
    const listener = await network.listen({ ownerId: 'server', host: '127.0.0.1', port: 4100 });
    const accepted = new Promise<Awaited<ReturnType<typeof network.connect>>>((resolve) => listener.onConnection(resolve));
    const client = network.connect({ ownerId: 'client', host: '127.0.0.1', port: 4100 });

    await client.connected;
    const server = await accepted;
    const received = new Promise<Uint8Array>((resolve) => server.on('data', (event) => resolve(event.data)));

    expect(client.write(new Uint8Array([0, 255, 12]))).toBe(true);
    expect(await received).toEqual(new Uint8Array([0, 255, 12]));
    expect(client.id).not.toBe(server.id);
    expect(client.localAddress.port).toBeGreaterThan(0);
    expect(server.localAddress).toEqual({ host: '127.0.0.1', port: 4100 });

    network.dispose();
  });

  test('applies backpressure, drains, pauses, and preserves half-close byte delivery', async () => {
    const network = createVirtualNetworkAuthority();
    const listener = await network.listen({ ownerId: 'server', host: '127.0.0.1', port: 4101 });
    const accepted = new Promise<Awaited<ReturnType<typeof network.connect>>>((resolve) => listener.onConnection(resolve));
    const client = network.connect({ ownerId: 'client', host: '127.0.0.1', port: 4101 });
    const server = await accepted;
    const drained = new Promise<void>((resolve) => client.on('drain', resolve));
    const received: number[] = [];
    server.pause();
    server.on('data', (event) => received.push(...event.data));

    expect(client.write(new Uint8Array(16 * 1024))).toBe(false);
    await Promise.resolve();
    expect(received).toEqual([]);
    let didDrain = false;
    void drained.then(() => {
      didDrain = true;
    });
    await Promise.resolve();
    expect(didDrain).toBe(false);
    server.resume();
    await drained;
    expect(received).toHaveLength(16 * 1024);

    const ended = new Promise<void>((resolve) => server.on('end', resolve));
    const reply = new Promise<Uint8Array>((resolve) => client.on('data', (event) => resolve(event.data)));
    client.end();
    await ended;
    expect(server.write(new Uint8Array([9]))).toBe(true);
    server.end();
    expect(await reply).toEqual(new Uint8Array([9]));
    await Promise.all([client.closed, server.closed]);
  });

  test('rejects connection misses and cancellation without leaving reusable addresses occupied', async () => {
    const network = createVirtualNetworkAuthority();
    const missing = network.connect({ ownerId: 'client', host: '127.0.0.1', port: 4199 });
    await expect(missing.connected).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });

    const first = await network.listen({ ownerId: 'first', host: '127.0.0.1', port: 0 });
    await expect(network.listen({ ownerId: 'second', host: '127.0.0.1', port: first.address.port })).rejects.toMatchObject({
      code: 'ADDRESS_IN_USE'
    });
    await first.close();
    const reused = await network.listen({ ownerId: 'second', host: '127.0.0.1', port: 0 });
    expect(reused.address.port).toBe(first.address.port);

    const pending = network.connect({ ownerId: 'client', host: '127.0.0.1', port: reused.address.port });
    pending.destroy();
    await expect(pending.connected).rejects.toMatchObject({ code: 'CANCELED' });
    network.dispose();
  });

  test('keeps Virtual Network local and rejects external raw TCP/TLS', async () => {
    const network = createVirtualNetworkAuthority();
    const externalTls = network.connect({ ownerId: 'client', host: 'example.test', port: 443, transport: 'tls' });
    await expect(externalTls.connected).rejects.toMatchObject({
      code: 'EXTERNAL_TRANSPORT_UNSUPPORTED',
      message: 'External raw TLS is unsupported: example.test:443'
    });
    const externalTcp = network.connect({ ownerId: 'client', host: 'example.test', port: 80 });
    await expect(externalTcp.connected).rejects.toMatchObject({
      code: 'EXTERNAL_TRANSPORT_UNSUPPORTED',
      message: 'External raw TCP is unsupported: example.test:80'
    });
    const loopbackMiss = network.connect({ ownerId: 'client', host: '127.0.0.1', port: 4199 });
    await expect(loopbackMiss.connected).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    const loopbackListener = await network.listen({ ownerId: 'server', host: '127.0.0.1', port: 4198 });
    const loopbackTls = network.connect({ ownerId: 'client', host: '127.0.0.1', port: 4198, transport: 'tls' });
    await expect(loopbackTls.connected).rejects.toMatchObject({ code: 'UNSUPPORTED' });
    await loopbackListener.close();
    network.dispose();
  });

  test('releases one owner and disposes the authority by closing its listeners and sockets', async () => {
    const network = createVirtualNetworkAuthority();
    const listener = await network.listen({ ownerId: 'server', host: '127.0.0.1', port: 4102 });
    const accepted = new Promise<Awaited<ReturnType<typeof network.connect>>>((resolve) => listener.onConnection(resolve));
    const client = network.connect({ ownerId: 'client', host: '127.0.0.1', port: 4102 });
    const server = await accepted;
    await network.releaseOwner('server');
    await Promise.all([listener.closed, client.closed, server.closed]);
    const replacement = await network.listen({ ownerId: 'replacement', host: '127.0.0.1', port: 4102 });
    const replacementClosed = replacement.closed;
    network.dispose();
    await replacementClosed;
    await expect(network.listen({ ownerId: 'later', host: '127.0.0.1', port: 4103 })).rejects.toMatchObject({
      code: 'VIRTUAL_NETWORK_CLOSED'
    });
  });

  test('exposes the same listener and duplex socket contract through the typed RPC', async () => {
    const pair = createPeerPair();
    const client = pair.client(createVirtualNetworkClient);
    const dispose = pair.serve();
    const listener = await client.listen({ ownerId: 'server', host: '127.0.0.1', port: 4104 });
    const accepted = new Promise<Awaited<ReturnType<typeof client.connect>>>((resolve) => listener.onConnection(resolve));
    const connecting = client.connect({ ownerId: 'client', host: '127.0.0.1', port: 4104 });
    const server = await accepted;
    await connecting.connected;
    const received = new Promise<Uint8Array>((resolve) => server.on('data', (event) => resolve(event.data)));

    connecting.write(new Uint8Array([4, 1, 0, 4]));
    expect(await received).toEqual(new Uint8Array([4, 1, 0, 4]));
    server.pause();
    let receivedAfterPause = 0;
    server.on('data', (event) => (receivedAfterPause += event.data.byteLength));
    const drained = new Promise<void>((resolve) => connecting.on('drain', resolve));
    expect(connecting.write(new Uint8Array(16 * 1024))).toBe(false);
    await Promise.resolve();
    expect(receivedAfterPause).toBe(0);
    server.resume();
    await drained;
    expect(receivedAfterPause).toBe(16 * 1024);
    await listener.close();
    const closedListener = client.connect({ ownerId: 'client', host: '127.0.0.1', port: 4104 });
    await expect(closedListener.connected).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });

    const missing = client.connect({ ownerId: 'client', host: '127.0.0.1', port: 4999 });
    await expect(missing.connected).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });

    client.close();
    dispose();
    pair.close();
  });

  test('preserves backpressure through a process-local proxy into the Runtime Host transport', async () => {
    const first = createPeerPair();
    const firstClient = first.client(createVirtualNetworkClient);
    const disposeRuntimeHost = first.serve();
    const serverProcess = createPeerPair();
    const serverClient = serverProcess.client(createVirtualNetworkClient);
    const disposeServerProxy = serverProcess.serve({ authority: firstClient });
    const clientProcess = createPeerPair();
    const clientClient = clientProcess.client(createVirtualNetworkClient);
    const disposeClientProxy = clientProcess.serve({ authority: firstClient });
    const listener = await serverClient.listen({ ownerId: 'server', host: '127.0.0.1', port: 4105 });
    const accepted = new Promise<Awaited<ReturnType<typeof clientClient.connect>>>((resolve) => listener.onConnection(resolve));
    const connecting = clientClient.connect({ ownerId: 'client', host: '127.0.0.1', port: 4105 });
    const server = await accepted;
    await connecting.connected;
    server.pause();
    let received = 0;
    server.on('data', (event) => (received += event.data.byteLength));
    const drained = new Promise<void>((resolve) => connecting.on('drain', resolve));

    expect(connecting.write(new Uint8Array(16 * 1024))).toBe(false);
    await Promise.resolve();
    expect(received).toBe(0);
    server.resume();
    await drained;
    await vi.waitFor(() => expect(received).toBe(16 * 1024));
    const missing = clientClient.connect({ ownerId: 'client', host: '127.0.0.1', port: 4999 });
    await expect(missing.connected).rejects.toMatchObject({ code: 'CONNECTION_REFUSED' });
    const cancelled = clientClient.connect({ ownerId: 'client', host: '127.0.0.1', port: 4105 });
    cancelled.destroy();
    await expect(cancelled.connected).rejects.toMatchObject({ code: 'CANCELED' });

    serverClient.close();
    clientClient.close();
    disposeServerProxy();
    disposeClientProxy();
    serverProcess.close();
    clientProcess.close();
    firstClient.close();
    disposeRuntimeHost();
    first.close();
  });
  test('a service bound to an owner cannot reach another owner\'s listeners and sockets', async () => {
    const authority = createVirtualNetworkAuthority();
    const events = { listenerConnection: () => undefined, socketEvent: () => undefined, listenerClosed: () => undefined };
    const victim = serveVirtualNetwork(events, { authority, ownerId: '7' });
    const attacker = serveVirtualNetwork(events, { authority, ownerId: '8' });
    const released = vi.spyOn(authority, 'releaseOwner');

    const listener = await victim.api.listen({ ownerId: 'ignored', host: '127.0.0.1', port: 4700 });
    expect(listener.ownerId).toBe('7');
    // The attacker names the victim everywhere; the host binds every call to the attacker.
    const own = await attacker.api.listen({ ownerId: '7', host: '127.0.0.1', port: 4701 });
    expect(own.ownerId).toBe('8');
    await attacker.api.releaseOwner('7');
    expect(released).toHaveBeenLastCalledWith('8');
    await expect(authority.listen({ ownerId: 'other', host: '127.0.0.1', port: 4700 })).rejects.toMatchObject({
      code: 'ADDRESS_IN_USE'
    });
    await expect(authority.listen({ ownerId: 'other', host: '127.0.0.1', port: 4701 })).resolves.toBeDefined();
    const socket = await attacker.api.connect({ ownerId: '7', host: '127.0.0.1', port: 4700 }, 'attacker-socket');
    expect(socket.id).toBe('attacker-socket');

    await victim.api.releaseOwner('8');
    expect(released).toHaveBeenLastCalledWith('7');
    await expect(authority.listen({ ownerId: 'other', host: '127.0.0.1', port: 4700 })).resolves.toBeDefined();
    victim.dispose();
    attacker.dispose();
    authority.dispose();
  });
});

// One context serves the authority; the other holds the client and receives its events.
function createPeerPair() {
  const channel = new MessageChannel();
  const clientSide: { network?: VirtualNetworkEvents } = {};
  const serverSide: { network?: VirtualNetworkApi } = {};
  const client = connectRpc<{ network: VirtualNetworkApi }>(channel.port2, clientSide);
  const server = connectRpc<{ network: VirtualNetworkEvents }>(channel.port1, serverSide);
  return {
    client(create: typeof createVirtualNetworkClient) {
      const created = create(client.remote.network);
      clientSide.network = created.events;
      return created;
    },
    serve(options?: Parameters<typeof serveVirtualNetwork>[1]) {
      const service = serveVirtualNetwork(server.notify.network, options);
      serverSide.network = service.api;
      return () => service.dispose();
    },
    close() {
      client.close();
      server.close();
    }
  };
}

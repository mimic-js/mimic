import { describe, expect, test } from 'vitest';

import {
  createPublishedEndpointClient,
  servePublishedEndpoints,
  type PublishedEndpointApi,
  type PublishedEndpointEvents,
  type PublishedEndpointIdentity,
  type PublishedEndpointLifecycleEvent
} from '../../src/runtime/modules/published-endpoint';
import {
  createPublishedEndpointAuthority
} from '../../src/runtime/modules/published-endpoint/authority';
import { connectRpc } from '../../src/runtime/modules/worker-transport';

describe('Published Endpoint authority', () => {
  test('issues a new opaque routeId when a virtual address is rebound', () => {
    const authority = createPublishedEndpointAuthority({ epochId: 'epoch-a' });
    const events: PublishedEndpointLifecycleEvent[] = [];
    authority.subscribe((event) => events.push(event));
    const request = {
      ownerId: 'process-1',
      protocol: 'http' as const,
      address: { host: '127.0.0.1', port: 5173 }
    };

    const first = authority.publish(request);
    authority.unpublish(request);
    const rebound = authority.publish({ ...request, ownerId: 'process-2' });

    expect(rebound).toEqual({ ...first, routeId: 'epoch-a:route-2' });
    expect(events).toEqual([
      { type: 'published', endpoint: first },
      { type: 'unpublished', endpoint: first },
      { type: 'published', endpoint: rebound }
    ]);
  });

  test('invalidates every active identity when the runtime epoch closes', () => {
    const authority = createPublishedEndpointAuthority({ epochId: 'epoch-b' });
    const events: PublishedEndpointLifecycleEvent[] = [];
    authority.subscribe((event) => events.push(event));
    const endpoint: PublishedEndpointIdentity = authority.publish({
      ownerId: 'process-1',
      protocol: 'http',
      address: { host: '0.0.0.0', port: 4173 }
    });

    authority.dispose();

    expect(events.at(-1)).toEqual({ type: 'unpublished', endpoint });
    expect(() =>
      authority.publish({
        ownerId: 'process-2',
        protocol: 'http',
        address: { host: '0.0.0.0', port: 4173 }
      })
    ).toThrow('Published Endpoint epoch is closed');
  });

  test('treats protocol as metadata rather than a second identity for one virtual address', () => {
    const authority = createPublishedEndpointAuthority({ epochId: 'epoch-protocol' });
    authority.publish({
      ownerId: 'process-1',
      protocol: 'http',
      address: { host: '127.0.0.1', port: 5173 }
    });

    expect(() =>
      authority.publish({
        ownerId: 'process-2',
        protocol: 'https',
        address: { host: '127.0.0.1', port: 5173 }
      })
    ).toThrow('cannot change protocol within one epoch');
  });

  test('projects stable host URLs through the transport lifecycle', async () => {
    const pair = createPeerPair();
    const disposeServer = pair.serve();
    const client = await pair.client({
      epochId: 'epoch-c',
      url: (endpoint) => `https://host.test/runtime/epoch-c/${encodeURIComponent(endpoint.routeId)}/${endpoint.address.port}/`
    });
    const published: string[] = [];
    client.on('published', (endpoint) => published.push(endpoint.url));
    const request = {
      ownerId: 'process-1',
      protocol: 'http' as const,
      address: { host: '127.0.0.1', port: 5173 }
    };

    const first = await client.publish(request);
    await client.unpublish(request);
    const rebound = await client.publish({ ...request, ownerId: 'process-2' });

    expect(rebound.routeId).not.toBe(first.routeId);
    expect(rebound.url).not.toBe(first.url);
    expect(client.current).toEqual([rebound]);
    expect(published).toEqual([first.url, rebound.url]);
    client.close();
    disposeServer();
    pair.close();
  });

  test('projects only active opaque routes in the document manifest', async () => {
    const pair = createPeerPair();
    const disposeServer = pair.serve();
    const client = await pair.client({
      epochId: 'epoch-manifest',
      url: (endpoint) => `https://host.test/runtime/epoch-manifest/${encodeURIComponent(endpoint.routeId)}/${endpoint.address.port}/`
    });
    const first = { ownerId: 'process-1', protocol: 'http' as const, address: { host: '127.0.0.1', port: 4173 } };
    const second = { ownerId: 'process-2', protocol: 'http' as const, address: { host: '127.0.0.1', port: 5173 } };

    expect(client.routeManifest).toEqual({ version: 1, epochId: 'epoch-manifest', routes: [] });

    const firstEndpoint = await client.publish(first);
    expect(client.routeManifest).toEqual({
      version: 1,
      epochId: 'epoch-manifest',
      routes: [firstEndpoint]
    });

    await client.publish({ ...first, ownerId: 'process-3' });
    expect(client.routeManifest.routes).toEqual([firstEndpoint]);

    const secondEndpoint = await client.publish(second);
    expect(client.routeManifest).toEqual({
      version: 1,
      epochId: 'epoch-manifest',
      routes: [firstEndpoint, secondEndpoint]
    });

    await client.unpublish({ ...first, ownerId: 'process-1' });
    await client.unpublish({ ...first, ownerId: 'process-3' });
    expect(client.routeManifest).toEqual({
      version: 1,
      epochId: 'epoch-manifest',
      routes: [secondEndpoint]
    });

    const rebound = await client.publish({ ...first, ownerId: 'process-4' });
    expect(rebound.routeId).not.toBe(firstEndpoint.routeId);
    expect(client.routeManifest).toEqual({
      version: 1,
      epochId: 'epoch-manifest',
      routes: [secondEndpoint, rebound]
    });

    client.close();
    expect(client.routeManifest).toEqual({ version: 1, epochId: 'epoch-manifest', routes: [] });
    client.close();
    expect(client.routeManifest.routes).toEqual([]);
    disposeServer();
    pair.close();
  });
});

function createPeerPair() {
  const channel = new MessageChannel();
  const clientSide: { endpoints?: PublishedEndpointEvents } = {};
  const serverSide: { endpoints?: PublishedEndpointApi } = {};
  const client = connectRpc<{ endpoints: PublishedEndpointApi }>(channel.port2, clientSide);
  const server = connectRpc<{ endpoints: PublishedEndpointEvents }>(channel.port1, serverSide);
  return {
    async client(options: Parameters<typeof createPublishedEndpointClient>[1]) {
      const created = await createPublishedEndpointClient(client.remote.endpoints, options);
      clientSide.endpoints = created.events;
      return created;
    },
    serve() {
      const service = servePublishedEndpoints(server.notify.endpoints);
      serverSide.endpoints = service.api;
      return () => service.dispose();
    },
    close() {
      client.close();
      server.close();
    }
  };
}

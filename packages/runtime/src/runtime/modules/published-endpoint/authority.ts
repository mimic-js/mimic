import type {
  PublishedEndpointAuthority,
  PublishedEndpointIdentity,
  PublishedEndpointLifecycleEvent,
  PublishedEndpointPublishRequest
} from './types';

type EndpointRecord = {
  readonly endpoint: PublishedEndpointIdentity;
  readonly owners: Set<string>;
};

export function createPublishedEndpointAuthority(options: { readonly epochId: string }): PublishedEndpointAuthority {
  const endpoints = new Map<string, EndpointRecord>();
  const listeners = new Set<(event: PublishedEndpointLifecycleEvent) => void>();
  let nextEndpointId = 0;
  let closed = false;

  const emit = (event: PublishedEndpointLifecycleEvent): void => {
    for (const listener of listeners) listener(event);
  };

  const assertOpen = (): void => {
    if (closed) throw new Error('Published Endpoint epoch is closed.');
  };

  const unpublishRecord = (key: string, record: EndpointRecord, ownerId: string): void => {
    if (!record.owners.delete(ownerId) || record.owners.size > 0) return;
    endpoints.delete(key);
    emit({ type: 'unpublished', endpoint: record.endpoint });
  };

  return {
    publish(request) {
      assertOpen();
      const key = endpointKey(request);
      let record = endpoints.get(key);
      if (!record) {
        record = {
          endpoint: {
            routeId: `${options.epochId}:route-${++nextEndpointId}`,
            protocol: request.protocol,
            address: { ...request.address }
          },
          owners: new Set()
        };
        endpoints.set(key, record);
      } else if (record.endpoint.protocol !== request.protocol) {
        throw new Error(
          `Published Endpoint ${request.address.host}:${request.address.port} cannot change protocol within one epoch.`
        );
      }
      const wasUnavailable = record.owners.size === 0;
      record.owners.add(request.ownerId);
      if (wasUnavailable) emit({ type: 'published', endpoint: record.endpoint });
      return record.endpoint;
    },
    unpublish(request) {
      assertOpen();
      const record = endpoints.get(endpointKey(request));
      if (record) unpublishRecord(endpointKey(request), record, request.ownerId);
    },
    releaseOwner(ownerId) {
      assertOpen();
      for (const [key, record] of endpoints) unpublishRecord(key, record, ownerId);
    },
    subscribe(listener) {
      assertOpen();
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      if (closed) return;
      closed = true;
      for (const record of endpoints.values()) {
        if (record.owners.size > 0) emit({ type: 'unpublished', endpoint: record.endpoint });
        record.owners.clear();
      }
      listeners.clear();
    }
  };
}

function endpointKey(request: Pick<PublishedEndpointPublishRequest, 'address'>): string {
  return `${request.address.host}:${request.address.port}`;
}

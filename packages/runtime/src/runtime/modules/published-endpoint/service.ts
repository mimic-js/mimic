import type { Notify } from '../worker-transport';
import { createPublishedEndpointAuthority } from './authority';
import type {
  PublishedEndpointApi,
  PublishedEndpointAuthority,
  PublishedEndpointEvents
} from './types';

export const PUBLISHED_ENDPOINT_SERVICE_WORKER_TOKEN =
  'mimic-published-endpoint-v3' as const;

export interface PublishedEndpointService {
  readonly api: PublishedEndpointApi;
  dispose(): void;
}

export function servePublishedEndpoints(
  events: Notify<PublishedEndpointEvents>
): PublishedEndpointService {
  let authority: PublishedEndpointAuthority | undefined;
  let unsubscribe: (() => void) | undefined;
  let disposed = false;

  const requireAuthority = (): PublishedEndpointAuthority => {
    if (!authority) throw new Error('Published Endpoint is not initialized.');
    return authority;
  };

  return {
    api: {
      initialize(epochId) {
        if (authority) throw new Error('Published Endpoint is already initialized.');
        authority = createPublishedEndpointAuthority({ epochId });
        unsubscribe = authority.subscribe((event) => events.lifecycle(event));
      },
      publish: (request) => requireAuthority().publish(request),
      unpublish: (request) => requireAuthority().unpublish(request),
      releaseOwner: (ownerId) => requireAuthority().releaseOwner(ownerId)
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe?.();
      authority?.dispose();
      authority = undefined;
    }
  };
}

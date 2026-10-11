import type {
  PublishedEndpointDocumentRoute,
  PublishedEndpointDocumentRouteManifest,
  PublishedEndpointDocumentRouteRequest
} from './types';

export function resolvePublishedEndpointDocumentRoute(
  manifest: PublishedEndpointDocumentRouteManifest,
  request: PublishedEndpointDocumentRouteRequest
): PublishedEndpointDocumentRoute | undefined {
  if (
    request.manifestVersion !== manifest.version ||
    request.instanceId !== manifest.epochId
  ) {
    return undefined;
  }
  return manifest.routes.find(
    (route) =>
      route.routeId === request.routeId &&
      route.address.port === request.port
  );
}

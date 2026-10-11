export { createVirtualNetworkAuthority, isLoopbackHost } from './authority';
export { createVirtualNetworkClient } from './client';
export { serveVirtualNetwork } from './service';
export { VirtualNetworkError } from './types';
export type {
  VirtualAddress,
  VirtualNetworkApi,
  VirtualNetworkAuthority,
  VirtualNetworkClient,
  VirtualNetworkConnectRequest,
  VirtualNetworkErrorCode,
  VirtualNetworkEvents,
  VirtualNetworkListener,
  VirtualNetworkListenRequest,
  VirtualNetworkSocket,
  VirtualNetworkSocketEvent
} from './types';
export type { ServeVirtualNetworkOptions, VirtualNetworkService } from './service';

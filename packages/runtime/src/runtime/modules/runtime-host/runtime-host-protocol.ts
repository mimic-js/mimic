import type { VirtualFileSystemApi } from '../virtual-file-system';
import type {
  ProcessExecutionApi,
  ProcessExecutionClientApi
} from '../process-execution';
import type { VirtualAddress } from '../virtual-network';
import type { SerializedError } from '../worker-transport';
import type {
  PublishedEndpointApi,
  PublishedEndpointEvents,
  PublishedEndpointProtocol
} from '../published-endpoint';
import type { RuntimeAssetManifest } from './runtime-assets';

/*
 * The connections of the Runtime Host worker (ADR-0033). The embedding page
 * speaks to it over a MessagePort the Runtime Host document transferred in;
 * the document itself, loaded from the origin that serves the endpoints,
 * speaks to it over the Worker it created. Every side imports this; only the
 * worker imports the Runtime Host composition.
 */

export type RuntimeHostAdapterFault = {
  readonly kind: 'invariant-violation';
  readonly adapter: 'published-endpoint-host' | 'runtime-program';
  readonly error: {
    readonly name: string;
    readonly message: string;
    readonly stack?: string;
  };
};

export class RuntimeHostAdapterInvariantError extends Error {
  readonly code = 'RUNTIME_HOST_ADAPTER_INVARIANT' as const;

  constructor(readonly fault: RuntimeHostAdapterFault) {
    super(
      `${fault.adapter} invariant failed: ${fault.error.message}`
    );
    this.name = 'RuntimeHostAdapterInvariantError';
  }
}

export type RuntimeHostFailure =
  | {
      readonly kind: 'adapter-invariant';
      readonly fault: RuntimeHostAdapterFault;
    }
  | {
      readonly kind: 'internal-failure';
      readonly error: SerializedError;
    };

export type RuntimeHostTerminalResult =
  | {
      readonly type: 'terminal-failure';
      readonly failure: RuntimeHostFailure;
      readonly cleanupFailures: readonly SerializedError[];
    }
  | {
      readonly type: 'teardown-failed';
      readonly cleanupFailures: readonly SerializedError[];
    };

export type RuntimeHostLifecycleResponse =
  | { readonly type: 'teardown-complete' }
  | RuntimeHostTerminalResult;

/** What the Runtime Host worker serves to the embedding page. */
export interface RuntimeHostWorkerApi {
  readonly runtimeHost: {
    /** Initializes the Virtual File System at `workdir` and starts Process Execution. */
    boot(workdir: string): Promise<void>;
    teardown(): Promise<RuntimeHostLifecycleResponse>;
    adapterFault(fault: RuntimeHostAdapterFault): void;
  };
  readonly fs: VirtualFileSystemApi;
  readonly endpoints: PublishedEndpointApi;
  readonly processes: ProcessExecutionApi;
}

/** What the embedding page serves to the Runtime Host worker. */
export interface RuntimeHostMainApi {
  readonly runtimeHost: {
    terminated(result: RuntimeHostTerminalResult): void;
  };
  readonly endpoints: PublishedEndpointEvents;
  readonly processes: ProcessExecutionClientApi;
}

/** What the Runtime Host worker serves to the Runtime Host document. */
export interface RuntimeHostDocumentWorkerApi {
  readonly runtimeHost: {
    adapterFault(fault: RuntimeHostAdapterFault): void;
    /** The document is unloading with the epoch active: the page removed its frame. */
    documentUnloaded(): void;
  };
  readonly endpoints: PublishedEndpointApi;
}

/**
 * What the Runtime Host document serves to the Runtime Host worker: the
 * Published Endpoint host it runs beside the Service Worker. A test that
 * connects one port serves this beside {@link RuntimeHostMainApi}.
 */
export interface RuntimeHostDocumentApi {
  readonly runtimeHost: {
    terminated(result: RuntimeHostTerminalResult): void;
    /** Teardown is ending: the document unpublishes its endpoints while the worker still answers. */
    closing(): Promise<void> | void;
  };
  readonly endpoints: PublishedEndpointEvents;
  readonly listeners: PublishedListenerRegistry;
}

/**
 * The listeners Runtime Processes publish. Each arrives with the port its
 * process worker serves it on, so published HTTP reaches that worker directly.
 */
export interface PublishedListenerRegistry {
  register(
    ownerId: string,
    listenerId: string,
    port: number,
    protocol: PublishedEndpointProtocol,
    address: VirtualAddress,
    endpoint: MessagePort
  ): void;
  /** Resolves once the listener is unpublished. */
  close(ownerId: string, port: number): Promise<void>;
  abort(listenerIds: readonly string[]): void;
}

/** The first message the Runtime Host document posts to the worker it created. */
export type RuntimeHostConnectMessage = {
  readonly type: 'runtime-host:connect';
  readonly assets: RuntimeAssetManifest;
};

export const RUNTIME_HOST_CONNECT_MESSAGE = 'runtime-host:connect';

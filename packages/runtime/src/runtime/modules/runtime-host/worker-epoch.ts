import {
  connectRpc,
  localRemote,
  normalizeError,
  serializeError,
  transfer,
  type RpcConnection,
  type RpcPort
} from '../worker-transport';
import {
  createAsyncVirtualFileSystemClient,
  normalizePath,
  serveVirtualFileSystem,
  type AsyncVirtualFileSystemClient,
  type ServeVirtualFileSystemOptions,
  type VirtualFileSystemService
} from '../virtual-file-system/index';
import {
  serveProcessExecution,
  type ProcessExecutionService,
  type RuntimeProgram
} from '../process-execution/index';
import {
  createVirtualNetworkAuthority,
  type VirtualNetworkAuthority
} from '../virtual-network/index';
import {
  servePublishedEndpoints,
  type PublishedEndpointService
} from '../published-endpoint/index';
import { version as babelVersion } from '@babel/core/package.json';
import {
  CONTENT_HASH_ALGORITHM,
  createRuntimeArtifactCompileService,
  RUNTIME_ARTIFACT_TRANSLATOR_REVISION,
  type CompiledArtifactStore,
  type RuntimeArtifactCompileRequest,
  type RuntimeArtifactCompileService
} from '../module-execution-engine/index';
import { openCompiledArtifactStore } from './compiled-artifact-store';
import { RUNTIME_ARTIFACT_COMPILE_SERVICE } from './process-worker-protocol';
import { createRuntimeArtifactCompilerWorker } from './runtime-assets';
import {
  createRuntimeArtifactCompilerPool,
  type RuntimeArtifactCompilerPool
} from './runtime-artifact-compiler-pool';
import {
  createRuntimeProgramHost,
  type RuntimeProgramAdapterContext,
  type RuntimeProgramHost
} from './runtime-program-host';
import {
  RuntimeHostAdapterInvariantError,
  type RuntimeHostAdapterFault,
  type RuntimeHostDocumentApi,
  type RuntimeHostDocumentWorkerApi,
  type RuntimeHostFailure,
  type RuntimeHostLifecycleResponse,
  type RuntimeHostMainApi,
  type RuntimeHostWorkerApi
} from './runtime-host-protocol';

export interface RuntimeHostEpoch {
  readonly closed: Promise<void>;
  /**
   * Serves this epoch to the embedding page over `page` and to the Runtime
   * Host document over `hostDocument` (ADR-0033). Without `hostDocument`, the
   * page connection serves the document's role too, as a test's single port
   * does. An epoch serves one page.
   */
  connect(page: RpcPort, hostDocument?: RpcPort): void;
  fail(reason: unknown): void;
}

export interface RuntimeHostWorkerAdapter {
  readonly page: RpcPort;
  readonly hostDocument?: RpcPort;
  closeWorker(): void;
  onUnhandledError(listener: (event: { readonly error: unknown; preventDefault(): void }) => void): void;
  onUnhandledRejection(listener: (event: { readonly reason: unknown; preventDefault(): void }) => void): void;
}

export function startRuntimeHostWorker(
  adapter: RuntimeHostWorkerAdapter,
  options: {
    readonly hardwareConcurrency?: number;
  } = {}
): RuntimeHostEpoch {
  const epoch = createRuntimeHostEpoch({
    closeWorker: adapter.closeWorker,
    hardwareConcurrency: options.hardwareConcurrency
  });
  adapter.onUnhandledError((event) => {
    event.preventDefault();
    epoch.fail(event.error);
  });
  adapter.onUnhandledRejection((event) => {
    event.preventDefault();
    epoch.fail(event.reason);
  });
  epoch.connect(adapter.page, adapter.hostDocument);
  return epoch;
}

export function createRuntimeHostEpoch(options: {
  readonly closeWorker: () => void;
  readonly executionCapacity?: number;
  readonly hardwareConcurrency?: number;
  /** Replaces the registered Runtime Programs; a test runs its own programs this way. */
  readonly runtimePrograms?: readonly RuntimeProgram<RuntimeProgramAdapterContext>[];
  readonly virtualFileSystem?: ServeVirtualFileSystemOptions;
}): RuntimeHostEpoch {
  let state: 'awaiting-connection' | 'active' | 'tearing-down' | 'terminal' =
    'awaiting-connection';
  let connection: RpcConnection<RuntimeHostMainApi> | undefined;
  let documentConnection: RpcConnection<RuntimeHostDocumentApi> | undefined;
  let virtualFileSystem: VirtualFileSystemService | undefined;
  let virtualNetwork: VirtualNetworkAuthority | undefined;
  let publishedEndpoints: PublishedEndpointService | undefined;
  let fileSystem: AsyncVirtualFileSystemClient | undefined;
  let programs: RuntimeProgramHost | undefined;
  let processes: ProcessExecutionService | undefined;
  let compilerPool: RuntimeArtifactCompilerPool | undefined;
  let compileService: RuntimeArtifactCompileService | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  /** The connections to notify: one when the page serves the document's role. */
  const peers = (): readonly RpcConnection<RuntimeHostMainApi | RuntimeHostDocumentApi>[] =>
    documentConnection && (documentConnection as unknown) !== connection
      ? [connection!, documentConnection]
      : connection
        ? [connection]
        : [];

  const cleanupResources = (): unknown[] => {
    const errors: unknown[] = [];
    const capture = (operation: (() => void) | undefined): void => {
      if (!operation) return;
      try {
        operation();
      } catch (error) {
        errors.push(error);
      }
    };
    const ownedPrograms = programs;
    programs = undefined;
    processes = undefined;
    capture(() => ownedPrograms?.dispose());
    const ownedFileSystem = fileSystem;
    fileSystem = undefined;
    capture(() => ownedFileSystem?.close());
    const ownedCompileService = compileService;
    const ownedCompilerPool = compilerPool;
    compileService = undefined;
    compilerPool = undefined;
    capture(() => ownedCompileService?.dispose());
    capture(() => ownedCompilerPool?.dispose());
    const ownedPublishedEndpoints = publishedEndpoints;
    publishedEndpoints = undefined;
    capture(() => ownedPublishedEndpoints?.dispose());
    const ownedVirtualNetwork = virtualNetwork;
    virtualNetwork = undefined;
    capture(() => ownedVirtualNetwork?.dispose());
    const ownedVirtualFileSystem = virtualFileSystem;
    virtualFileSystem = undefined;
    capture(() => ownedVirtualFileSystem?.dispose());
    return errors;
  };

  const finishEpoch = (): unknown[] => {
    if (state === 'terminal') return [];
    state = 'terminal';
    const errors = cleanupResources();
    try {
      options.closeWorker();
    } catch (error) {
      errors.push(error);
    } finally {
      const document = documentConnection;
      if (document && (document as unknown) !== connection) document.close();
      resolveClosed();
    }
    return errors;
  };

  const fail = (reason: unknown): void => {
    if (state === 'terminal') return;
    const failedPeers = peers();
    const cleanupErrors = finishEpoch();
    const result = {
      type: 'terminal-failure' as const,
      failure: serializeRuntimeHostFailure(reason),
      cleanupFailures: cleanupErrors.map((error) => serializeError(normalizeError(error)))
    };
    for (const peer of failedPeers) {
      peer.notify.runtimeHost.terminated(result);
      peer.close();
    }
  };

  const failAdapter = (
    adapter: RuntimeHostAdapterFault['adapter'],
    error: Error
  ): void =>
    fail(
      new RuntimeHostAdapterInvariantError({
        kind: 'invariant-violation',
        adapter,
        error: {
          name: error.name,
          message: error.message,
          ...(error.stack ? { stack: error.stack } : {})
        }
      })
    );

  const teardown = async (): Promise<RuntimeHostLifecycleResponse> => {
    if (state !== 'active') {
      throw new Error('The Runtime Host is not active.');
    }
    state = 'tearing-down';
    await programs?.shutdown('SIGKILL');
    await processes?.settled();
    // The document unpublishes what is left while the authorities still answer.
    await documentConnection?.remote.runtimeHost.closing().catch(() => undefined);
    const cleanupErrors = cleanupResources();
    if (cleanupErrors.length > 0) {
      return {
        type: 'teardown-failed',
        cleanupFailures: cleanupErrors.map((error) => serializeError(normalizeError(error)))
      };
    }
    return { type: 'teardown-complete' };
  };

  const adapterFault = (fault: RuntimeHostAdapterFault): void => {
    if (state !== 'active') {
      fail(new Error('The Runtime Host received an invalid adapter fault.'));
      return;
    }
    fail(new RuntimeHostAdapterInvariantError(fault));
  };

  const connect = (page: RpcPort, hostDocument?: RpcPort): void => {
    if (state !== 'awaiting-connection') {
      throw new Error('The Runtime Host epoch already serves a connection.');
    }
    state = 'active';
    const local: Partial<Record<keyof RuntimeHostWorkerApi, unknown>> = {};
    const opened = connectRpc<RuntimeHostMainApi>(page, local);
    connection = opened;
    const documentLocal: Partial<Record<keyof RuntimeHostDocumentWorkerApi, unknown>> = {};
    const document: RpcConnection<RuntimeHostDocumentApi> = hostDocument
      ? connectRpc<RuntimeHostDocumentApi>(hostDocument, documentLocal)
      : (opened as unknown as RpcConnection<RuntimeHostDocumentApi>);
    documentConnection = document;
    const pool = createRuntimeArtifactCompilerPool({
      createWorker: createRuntimeArtifactCompilerWorker,
      size: compilerPoolSize(options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency)
    });
    const service = createRuntimeArtifactCompileService({
      translate: (kind, source, priority) => pool.translate(kind, source, priority),
      store: deferredStore(
        openCompiledArtifactStore({
          version: `babel@${babelVersion}+translator@${RUNTIME_ARTIFACT_TRANSLATOR_REVISION}+key@${CONTENT_HASH_ALGORITHM}`
        })
      )
    });
    compilerPool = pool;
    compileService = service;
    const servedFileSystem = serveVirtualFileSystem({
      ...options.virtualFileSystem,
      mailboxHost: {
        ...options.virtualFileSystem?.mailboxHost,
        services: {
          [RUNTIME_ARTIFACT_COMPILE_SERVICE]: (request) =>
            service.serve(request as RuntimeArtifactCompileRequest)
        }
      }
    });
    virtualFileSystem = servedFileSystem;
    virtualNetwork = createVirtualNetworkAuthority();
    // The page projects the endpoints for the facade; the document routes them.
    publishedEndpoints = servePublishedEndpoints({
      lifecycle(event) {
        opened.notify.endpoints.lifecycle(event);
        if ((document as unknown) !== opened) document.notify.endpoints.lifecycle(event);
      }
    });
    let nextListenerId = 0;

    const boot = async (workdir: string): Promise<void> => {
      if (state !== 'active' || programs) {
        throw new Error('The Runtime Host is not awaiting boot.');
      }
      servedFileSystem.api.initialize(workdir);
      const bootedFileSystem = await createAsyncVirtualFileSystemClient(
        localRemote(servedFileSystem.api)
      );
      if (state !== 'active') {
        bootedFileSystem.close();
        throw new Error('The Runtime Host closed during boot.');
      }
      fileSystem = bootedFileSystem;
      const authority = () => {
        const owned = virtualFileSystem?.authority;
        if (!owned) {
          throw new Error(
            'Runtime Program resolution requires an initialized Virtual File System.'
          );
        }
        return owned;
      };
      const readFile = (path: string): Uint8Array => {
        const result = authority().readFile(path);
        if (result.status === 'rejected') {
          throw new Error(result.error.message);
        }
        return result.data;
      };
      programs = createRuntimeProgramHost({
        fileSystem: bootedFileSystem,
        fileSystemForProcess: (binding) => servedFileSystem.forOwner(binding),
        executableFileSystem: {
          normalizePath,
          isFile: (path) => {
            const result = virtualFileSystem?.authority?.stat(path, true);
            return result?.status === 'ok' && result.stat.kind === 'file';
          },
          realpath: (path) => {
            const result = authority().realpath(path);
            return result.status === 'ok' ? result.path : path;
          },
          readText: (path) => new TextDecoder().decode(readFile(path)),
          readBytes: (path) => readFile(path).slice()
        },
        network: virtualNetwork!,
        publishedEndpoints: {
          forOwner: (ownerId) => ({
            register(port, protocol, address, endpoint) {
              const listenerId = `published-listener-${++nextListenerId}`;
              document.notify.listeners.register(
                ownerId,
                listenerId,
                port,
                protocol,
                address,
                transfer(endpoint, [endpoint])
              );
              return listenerId;
            },
            close: (port) =>
              document.remote.listeners.close(ownerId, port).catch(() => undefined),
            abort(listenerIds) {
              if (listenerIds.length > 0) document.notify.listeners.abort(listenerIds);
            }
          })
        },
        onBackgroundFailure: (error) => failAdapter('runtime-program', error),
        // Packages a manager installed are compiled ahead of their first use.
        onPackagesInstalled: (cwd) => {
          void service.precompile(cwd, bootedFileSystem).catch(() => undefined);
        },
        capacity: options.executionCapacity,
        hardwareConcurrency:
          options.hardwareConcurrency ?? globalThis.navigator?.hardwareConcurrency,
        programs: options.runtimePrograms
      });
      const host = programs;
      processes = serveProcessExecution(
        (request, output) => host.spawn(request, output),
        { remote: opened.remote.processes, notify: opened.notify.processes }
      );
      local.processes = processes.api;
    };

    Object.assign(local, {
      runtimeHost: {
        boot,
        teardown,
        adapterFault
      },
      fs: servedFileSystem.api,
      endpoints: publishedEndpoints.api
    } satisfies Omit<RuntimeHostWorkerApi, 'processes'>);
    Object.assign(documentLocal, {
      runtimeHost: {
        adapterFault,
        documentUnloaded() {
          if (state === 'active') fail(new Error('The Runtime Host document unloaded.'));
        }
      },
      endpoints: publishedEndpoints.api
    } satisfies RuntimeHostDocumentWorkerApi);
    void opened.closed.then(() => {
      if (state === 'active') {
        fail(new Error('The Runtime Host connection closed unexpectedly.'));
        return;
      }
      if (state === 'tearing-down') finishEpoch();
    });
    if ((document as unknown) !== opened) {
      void document.closed.then(() => {
        if (state === 'active') {
          fail(new Error('The Runtime Host document connection closed unexpectedly.'));
        }
      });
    }
  };

  return {
    closed,
    connect,
    fail
  };
}

/** Up to four compiler workers, never more than half the machine. */
function compilerPoolSize(hardwareConcurrency: number | undefined): number {
  return Math.max(1, Math.min(4, Math.floor((hardwareConcurrency ?? 2) / 2)));
}

/** A store usable while it is still opening; until it has opened, nothing is persisted. */
function deferredStore(opening: Promise<CompiledArtifactStore | undefined>): CompiledArtifactStore {
  return {
    read: async (key) => (await opening)?.read(key),
    has: async (key) => (await (await opening)?.has(key)) ?? false,
    write: async (key, text) => (await opening)?.write(key, text)
  };
}

function serializeRuntimeHostFailure(
  reason: unknown
): RuntimeHostFailure {
  return reason instanceof RuntimeHostAdapterInvariantError
    ? { kind: 'adapter-invariant', fault: reason.fault }
    : {
        kind: 'internal-failure',
        error: serializeError(normalizeError(reason))
      };
}

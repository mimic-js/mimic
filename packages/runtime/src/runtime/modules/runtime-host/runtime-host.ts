import {
  connectRpc,
  normalizeError,
  reviveError,
  type RpcConnection
} from '../worker-transport';
import {
  createAsyncVirtualFileSystemClient,
  type AsyncVirtualFileSystemClient
} from '../virtual-file-system';
import {
  createProcessExecutionClient,
  type ProcessExecutionClient,
  type RuntimeProgramProcess,
  type RuntimeProgramRequest
} from '../process-execution';
import {
  createPublishedEndpointClient,
  createPublishedEndpointFetch,
  publishedEndpointLayout,
  publishedEndpointUrl,
  type PublishedEndpointClient,
  type PublishedEndpointFetch
} from '../published-endpoint';
import { openRuntimeHostDocument, type RuntimeHostDocumentFrame } from './host-document-frame';
import { pageRuntimeAssets } from './page-assets';
import {
  RuntimeHostAdapterInvariantError,
  type RuntimeHostFailure,
  type RuntimeHostMainApi,
  type RuntimeHostTerminalResult,
  type RuntimeHostWorkerApi
} from './runtime-host-protocol';

const TEARDOWN_TIMEOUT_MS = 10_000;

export class RuntimeEpochFailedError extends Error {
  readonly code = 'RUNTIME_EPOCH_FAILED' as const;

  constructor(cause: unknown) {
    const normalized = normalizeError(cause);
    super(`Runtime epoch failed: ${normalized.message}`, { cause });
    this.name = 'RuntimeEpochFailedError';
    if (normalized.stack) this.stack = normalized.stack;
  }
}

export interface RuntimeHost {
  readonly fs: AsyncVirtualFileSystemClient;
  readonly endpoints: PublishedEndpointClient;
  spawn(
    request: RuntimeProgramRequest
  ): Promise<RuntimeProgramProcess>;
  teardown(): Promise<void>;
}

let activeHost: RuntimeHostImplementation | undefined;
let bootInProgress = false;

export type RuntimeHostOptions = {
  /** The embedding page's `Cross-Origin-Embedder-Policy`, mirrored on endpoint documents. */
  readonly embedderPolicy?: 'require-corp' | 'credentialless';
  /**
   * The origin Published Endpoints are served from when it is not the page's
   * own (ADR-0032), or a wildcard origin that serves each endpoint from an
   * origin of its own (ADR-0044); already normalized by the facade. The
   * Runtime Host runs there too (ADR-0033).
   */
  readonly previewOrigin?: string;
};

export function bootRuntimeHost(
  workdir: string,
  onFailure?: (error: RuntimeEpochFailedError) => void,
  options: RuntimeHostOptions = {}
): Promise<RuntimeHost> {
  if (globalThis.crossOriginIsolated !== true) {
    return Promise.reject(
      new Error(
        'Mimic.boot() requires a cross-origin isolated page: serve the embedding page with the ' +
          '"Cross-Origin-Opener-Policy: same-origin" and "Cross-Origin-Embedder-Policy: require-corp" headers.'
      )
    );
  }
  if (activeHost?.isClosing === true) {
    return activeHost.whenClosed().then(() => bootRuntimeHost(workdir, onFailure, options));
  }
  if (activeHost || bootInProgress) {
    return Promise.reject(
      new Error('Only one Mimic instance can be booted at a time. Call teardown() before booting another runtime.')
    );
  }

  bootInProgress = true;
  let hostDocument: RuntimeHostDocumentFrame | undefined;
  let connection: RpcConnection<RuntimeHostWorkerApi> | undefined;
  let endpointFetch: PublishedEndpointFetch | undefined;
  let host: RuntimeHostImplementation | undefined;
  return (async () => {
    try {
      const epochId = crypto.randomUUID();
      const embedderPolicy = options.embedderPolicy ?? 'require-corp';
      hostDocument = await openRuntimeHostDocument({
        assets: pageRuntimeAssets(),
        previewOrigin: options.previewOrigin,
        epochId,
        embedderPolicy
      });
      let rejectBoot!: (error: Error) => void;
      const bootFailure = new Promise<never>((_resolve, reject) => {
        rejectBoot = reject;
      });
      void bootFailure.catch(() => undefined);
      const reportFailure = (error: Error): void => {
        if (host) void host.failInitialization(error);
        else rejectBoot(error);
      };
      void hostDocument.failed.catch((error: unknown) => reportFailure(normalizeError(error)));
      const local: Partial<RuntimeHostMainApi> = {
        runtimeHost: {
          terminated(result) {
            if (host) host.receiveTerminalResult(result);
            else if (result.type === 'terminal-failure') {
              rejectBoot(deserializeRuntimeHostFailure(result.failure));
            }
          }
        }
      };
      connection = connectRpc<RuntimeHostWorkerApi>(hostDocument.port, local);
      const remote = connection.remote;
      const processes = createProcessExecutionClient(remote.processes);
      Object.assign(local, { processes: processes.events });
      await Promise.race([remote.runtimeHost.boot(workdir), bootFailure]);
      const fs = await createAsyncVirtualFileSystemClient(remote.fs);
      // The endpoints live beside the Service Worker on the document's origin,
      // or each at the root of an origin of its own (ADR-0044).
      const layout = publishedEndpointLayout({
        previewOrigin: options.previewOrigin,
        serviceWorkerUrl: hostDocument.assets['service-worker.js']
      });
      endpointFetch = createPublishedEndpointFetch({ layout, epochId });
      const endpoints = await createPublishedEndpointClient(remote.endpoints, {
        epochId,
        url: (endpoint) => publishedEndpointUrl(layout, epochId, endpoint),
        fetch: (input, init) => endpointFetch!.fetch(input, init)
      });
      Object.assign(local, { endpoints: endpoints.events });
      host = new RuntimeHostImplementation(
        hostDocument,
        connection,
        fs,
        processes,
        endpoints,
        endpointFetch,
        onFailure,
        () => {
          if (activeHost === host) activeHost = undefined;
        }
      );
      activeHost = host;
      host.assertReady();
      return host;
    } catch (error) {
      if (host) {
        const initializationError = normalizeError(error);
        try {
          await host.failInitialization(initializationError);
        } catch (cleanupError) {
          throw new AggregateError(
            [initializationError, cleanupError],
            'Runtime Host initialization cleanup failed.'
          );
        }
      } else {
        endpointFetch?.dispose();
        connection?.close();
        hostDocument?.dispose();
      }
      throw error;
    } finally {
      bootInProgress = false;
    }
  })();
}

class RuntimeHostImplementation implements RuntimeHost {
  readonly fs: AsyncVirtualFileSystemClient;
  readonly endpoints: PublishedEndpointClient;

  readonly #closed: Promise<void>;
  readonly #failure: Promise<never>;
  readonly #endpointFetch: PublishedEndpointFetch;
  readonly #connection: RpcConnection<RuntimeHostWorkerApi>;
  readonly #processes: ProcessExecutionClient;
  readonly #onFailure: ((error: RuntimeEpochFailedError) => void) | undefined;
  readonly #releaseActiveClient: () => void;
  readonly #hostDocument: RuntimeHostDocumentFrame;
  readonly #rejectFailure: (error: RuntimeEpochFailedError) => void;
  readonly #resolveClosed: () => void;
  #cleanupPromise: Promise<void> | undefined;
  #failureReason: RuntimeEpochFailedError | undefined;
  #state: 'ready' | 'tearing-down' | 'failed' | 'closed' = 'ready';
  #runtimeHostCleanupFailures: Error[] = [];
  #teardownFailure: AggregateError | undefined;
  #teardownPromise: Promise<void> | undefined;

  constructor(
    hostDocument: RuntimeHostDocumentFrame,
    connection: RpcConnection<RuntimeHostWorkerApi>,
    fs: AsyncVirtualFileSystemClient,
    processes: ProcessExecutionClient,
    endpoints: PublishedEndpointClient,
    endpointFetch: PublishedEndpointFetch,
    onFailure: ((error: RuntimeEpochFailedError) => void) | undefined,
    releaseActiveClient: () => void
  ) {
    this.#hostDocument = hostDocument;
    this.#connection = connection;
    this.fs = fs;
    this.#processes = processes;
    this.endpoints = endpoints;
    this.#endpointFetch = endpointFetch;
    this.#onFailure = onFailure;
    this.#releaseActiveClient = releaseActiveClient;
    let resolveClosed!: () => void;
    this.#closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    this.#resolveClosed = resolveClosed;
    let rejectFailure!: (error: RuntimeEpochFailedError) => void;
    this.#failure = new Promise<never>((_resolve, reject) => {
      rejectFailure = reject;
    });
    this.#rejectFailure = rejectFailure;
    void this.#failure.catch(() => undefined);
    void connection.closed.then(() => {
      queueMicrotask(() => {
        if (this.#state === 'ready') {
          this.#handleFailure(
            new Error('The Runtime Host connection closed unexpectedly.')
          );
        }
      });
    });
  }

  get isClosing(): boolean {
    return this.#state !== 'ready';
  }

  whenClosed(): Promise<void> {
    return this.#closed;
  }

  spawn(request: RuntimeProgramRequest): Promise<RuntimeProgramProcess> {
    this.assertReady();
    return this.#processes.spawn(request);
  }

  assertReady(): void {
    if (this.#state === 'ready') return;
    throw (
      this.#failureReason ??
      new Error('Runtime Host closed during initialization.')
    );
  }

  failInitialization(error: Error): Promise<void> {
    return this.#handleFailure(error);
  }

  #beginTeardown(): void {
    if (this.#state === 'ready') this.#state = 'tearing-down';
  }

  teardown(): Promise<void> {
    if (this.#teardownPromise) return this.#teardownPromise;
    if (this.#failureReason) {
      this.#teardownPromise = this.#teardownAfterFailure(
        this.#failureReason
      );
      return this.#teardownPromise;
    }
    if (this.#state === 'closed') return this.#closed;
    this.#beginTeardown();
    this.#teardownPromise = this.#requestTeardown();
    return this.#teardownPromise;
  }

  async #requestTeardown(): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let terminalFailure: RuntimeEpochFailedError | undefined;
    try {
      const teardown = this.#connection.remote.runtimeHost.teardown();
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error('Runtime Host teardown timed out.')),
          TEARDOWN_TIMEOUT_MS
        );
      });
      const result = await Promise.race([
        teardown,
        this.#connection.closed.then(() => {
          throw new Error(
            'The Runtime Host connection closed before acknowledging teardown.'
          );
        }),
        timedOut
      ]);
      if (result.type !== 'teardown-complete') {
        this.receiveTerminalResult(result);
      }
    } catch (error) {
      if (!this.#teardownFailure) {
        terminalFailure =
          this.#failureReason ?? this.#toTerminalFailure(error);
        if (!this.#failureReason) this.#handleFailure(terminalFailure);
      }
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (this.#teardownFailure) {
      await this.#rejectTeardownAfterCleanup(this.#teardownFailure);
      return;
    }
    if (terminalFailure) {
      await this.#rejectAfterCleanup(terminalFailure);
      return;
    }
    await this.#cleanup();
  }

  #handleFailure(
    error: Error,
    runtimeHostCleanupFailures: readonly Error[] = []
  ): Promise<void> {
    if (this.#failureReason) return this.#cleanup();
    if (this.#state === 'closed') return Promise.resolve();
    const terminalFailure = this.#toTerminalFailure(error);
    this.#state = 'failed';
    this.#failureReason = terminalFailure;
    this.#runtimeHostCleanupFailures = [...runtimeHostCleanupFailures];
    this.#rejectFailure(terminalFailure);
    this.#onFailure?.(terminalFailure);
    const cleanup = this.#cleanup();
    void cleanup.catch(() => undefined);
    return cleanup;
  }

  #toTerminalFailure(error: unknown): RuntimeEpochFailedError {
    return error instanceof RuntimeEpochFailedError
      ? error
      : new RuntimeEpochFailedError(error);
  }

  #teardownAfterFailure(
    terminalFailure: RuntimeEpochFailedError
  ): Promise<void> {
    return this.#rejectAfterCleanup(terminalFailure);
  }

  async #rejectAfterCleanup(
    terminalFailure: RuntimeEpochFailedError
  ): Promise<never> {
    const cleanupFailures: unknown[] = [
      ...this.#runtimeHostCleanupFailures
    ];
    try {
      await this.#cleanup();
    } catch (cleanupError) {
      cleanupFailures.push(
        ...(cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError])
      );
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [terminalFailure, ...cleanupFailures],
        'Runtime epoch failure cleanup did not release every resource.',
        { cause: terminalFailure }
      );
    }
    throw terminalFailure;
  }

  async #rejectTeardownAfterCleanup(
    runtimeHostFailure: AggregateError
  ): Promise<never> {
    const cleanupFailures = [...runtimeHostFailure.errors];
    try {
      await this.#cleanup();
    } catch (cleanupError) {
      cleanupFailures.push(
        ...(cleanupError instanceof AggregateError
          ? cleanupError.errors
          : [cleanupError])
      );
    }
    throw new AggregateError(
      cleanupFailures,
      'Runtime Host teardown cleanup did not release every resource.'
    );
  }

  receiveTerminalResult(result: RuntimeHostTerminalResult): void {
    const cleanupFailures = result.cleanupFailures.map(reviveError);
    if (result.type === 'teardown-failed') {
      if (!this.#teardownFailure) {
        this.#teardownFailure = new AggregateError(
          cleanupFailures,
          'Runtime Host teardown cleanup failed.'
        );
      }
      return;
    }
    void this.#handleFailure(
      deserializeRuntimeHostFailure(result.failure),
      cleanupFailures
    );
  }

  #cleanup(): Promise<void> {
    if (this.#cleanupPromise) return this.#cleanupPromise;
    this.#cleanupPromise = (async () => {
      const cleanupErrors: unknown[] = [];
      const capture = (operation: () => void): void => {
        try {
          operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      const captureAsync = async (
        operation: () => Promise<void>
      ): Promise<void> => {
        try {
          await operation();
        } catch (error) {
          cleanupErrors.push(error);
        }
      };
      capture(() => {
        if (this.#failureReason) this.#processes.fail(this.#failureReason);
        else this.#processes.close();
      });
      capture(() => this.endpoints.close());
      capture(() => this.#endpointFetch.dispose());
      capture(() => this.fs.close());
      capture(() => this.#connection.close());
      await captureAsync(() => this.#connection.closed);
      // The document ends its worker with the epoch; removing the frame ends both.
      capture(() => this.#hostDocument.dispose());
      this.#state = 'closed';
      this.#releaseActiveClient();
      this.#resolveClosed();
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          cleanupErrors,
          'Runtime Host cleanup did not release every resource.'
        );
      }
    })();
    return this.#cleanupPromise;
  }
}

function deserializeRuntimeHostFailure(
  failure: RuntimeHostFailure
): Error {
  return failure.kind === 'adapter-invariant'
    ? new RuntimeHostAdapterInvariantError(failure.fault)
    : reviveError(failure.error);
}

/**
 * One typed RPC between two browser contexts. Both sides share an interface
 * type: the callee exposes an object implementing it, and the caller drives it
 * through a generic proxy. A call returns a promise; an error the callee
 * throws is serialised and rethrown at the call site, rejecting only that
 * call. A notification is the same call without a reply.
 */

/** A MessagePort, a Worker, or a dedicated worker's global scope. */
export interface RpcPort {
  postMessage(message: unknown, transfer: Transferable[]): void;
  addEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message' | 'messageerror', listener: (event: MessageEvent) => void): void;
  start?(): void;
}

/** The caller's view of an interface: every method returns a promise. */
export type Remote<Api> = {
  readonly [Key in keyof Api]: Api[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : Remote<Api[Key]>;
};

/** Fire-and-forget calls: no reply, so nothing to await or reject. */
export type Notify<Api> = {
  readonly [Key in keyof Api]: Api[Key] extends (...args: infer Args) => unknown
    ? (...args: Args) => void
    : Notify<Api[Key]>;
};

/** A callee-side implementation that may answer asynchronously. */
export type Implementation<Api> = {
  [Key in keyof Api]: Api[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Result | Promise<Awaited<Result>>
    : Implementation<Api[Key]>;
};

export interface RpcConnectionOptions {
  /**
   * Receives the failure of a notification, which has no call site to reject:
   * a method the local object does not implement, one that throws, or one
   * whose promise rejects. Without it the failure is logged. A malformed
   * frame is ignored either way; it never escapes the message listener.
   */
  onNotificationError?(error: unknown, path: readonly string[]): void;
}

export interface RpcConnection<RemoteApi> {
  readonly remote: Remote<RemoteApi>;
  readonly notify: Notify<RemoteApi>;
  /** Resolves once either side closes the connection; pending calls reject. */
  readonly closed: Promise<void>;
  close(): void;
}

/** One message stream: a connection whose only method is `receive`. */
export interface MessageStream<Message = unknown> {
  readonly closed: Promise<void>;
  send(message: Message, transfer?: readonly Transferable[]): void;
  subscribe(listener: (message: Message) => void): () => void;
  close(): void;
}

/**
 * An error as it crosses a context boundary: its name, message and stack,
 * and its own primitive properties (such as `code`).
 */
export type SerializedError = {
  readonly name: string;
  readonly message: string;
  readonly stack?: string;
  readonly properties: Record<string, unknown>;
};

// How an error crosses: `createWorkerTransport` calls these two, and the
// browser artifact source embeds them beside it.
export function serializeError(error: unknown): SerializedError {
  if (typeof error !== 'object' || error === null || !('message' in error)) {
    return { name: 'Error', message: String(error), properties: {} };
  }
  const record = error as Record<string, unknown>;
  const properties: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    const value = record[key];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      properties[key] = value;
    }
  }
  return {
    name: typeof record.name === 'string' ? record.name : 'Error',
    message: String(record.message),
    ...(typeof record.stack === 'string' ? { stack: record.stack } : {}),
    properties
  };
}

export function reviveError(serialized: SerializedError): Error {
  const error = new Error(String(serialized.message));
  const properties = serialized.properties;
  if (typeof properties === 'object' && properties !== null) {
    for (const key of Object.keys(properties)) {
      // An error's identity comes from its named fields, never from a property that crossed beside them.
      if (key === 'name' || key === 'message' || key === 'stack') continue;
      (error as unknown as Record<string, unknown>)[key] = properties[key];
    }
  }
  error.name = typeof serialized.name === 'string' ? serialized.name : 'Error';
  if (typeof serialized.stack === 'string') error.stack = serialized.stack;
  return error;
}

// Everything else lives in one self-contained factory so the Service Worker
// and the published document runtime can embed the same implementation as source.
function createWorkerTransport() {
  type RpcMessage =
    | {
        readonly kind: 'rpc:call';
        readonly id: number;
        readonly path: readonly string[];
        readonly args: readonly unknown[];
      }
    | { readonly kind: 'rpc:return'; readonly id: number; readonly value: unknown }
    | { readonly kind: 'rpc:throw'; readonly id: number; readonly error: SerializedError }
    | { readonly kind: 'rpc:close' };

  const transfers = new WeakMap<object, readonly Transferable[]>();

  function transfer<Value extends object>(
    value: Value,
    transferables: readonly Transferable[]
  ): Value {
    transfers.set(value, transferables);
    return value;
  }

  const transferablesOf = (values: readonly unknown[]): Transferable[] => {
    const found = new Set<Transferable>();
    for (const value of values) {
      if (typeof value !== 'object' || value === null) continue;
      for (const transferable of transfers.get(value) ?? []) found.add(transferable);
    }
    return [...found];
  };

  const closedError = (message: string): Error =>
    Object.assign(new Error(message), {
      name: 'RpcConnectionClosedError',
      code: 'RPC_CONNECTION_CLOSED'
    });

  const isCallId = (id: unknown): id is number =>
    typeof id === 'number' && Number.isInteger(id) && id >= 0;
  const isPath = (path: unknown): path is readonly string[] =>
    Array.isArray(path) && path.every((key) => typeof key === 'string');
  const isSerializedError = (error: unknown): error is SerializedError =>
    typeof error === 'object' && error !== null && typeof (error as SerializedError).message === 'string';
  const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function';

  function connectRpc<RemoteApi = Record<never, never>>(
    port: RpcPort,
    local: object = {},
    options: RpcConnectionOptions = {}
  ): RpcConnection<RemoteApi> {
    const pending = new Map<
      number,
      { readonly resolve: (value: unknown) => void; readonly reject: (error: unknown) => void }
    >();
    const proxies = new Map<string, unknown>();
    let nextId = 1;
    let open = true;
    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    const post = (message: RpcMessage, transferables: Transferable[] = []): void => {
      port.postMessage(message, transferables);
    };

    const finish = (reason: Error): void => {
      if (!open) return;
      open = false;
      port.removeEventListener('message', onMessage);
      port.removeEventListener('messageerror', onMessageError);
      for (const call of pending.values()) call.reject(reason);
      pending.clear();
      if (typeof MessagePort !== 'undefined' && port instanceof MessagePort) port.close();
      resolveClosed();
    };

    const resolveMethod = (
      path: readonly string[]
    ): { readonly receiver: unknown; readonly method: (...args: unknown[]) => unknown } | undefined => {
      let receiver: unknown;
      let target: unknown = local;
      for (const key of path) {
        if (typeof target !== 'object' || target === null) return undefined;
        // Only the exposed object's own vocabulary is callable, never Object.prototype.
        if (!(key in target) || key in Object.prototype) return undefined;
        receiver = target;
        target = (target as Record<string, unknown>)[key];
      }
      return typeof target === 'function'
        ? { receiver, method: target as (...args: unknown[]) => unknown }
        : undefined;
    };

    const respond = (id: number, value: unknown): void => {
      if (!open) return;
      try {
        post({ kind: 'rpc:return', id, value }, transferablesOf([value]));
      } catch (error) {
        respondError(id, error);
      }
    };

    const respondError = (id: number, error: unknown): void => {
      if (!open) return;
      post({ kind: 'rpc:throw', id, error: serializeError(error) });
    };

    const notificationFailed = (path: readonly string[], error: unknown): void => {
      if (options.onNotificationError) {
        options.onNotificationError(error, path);
        return;
      }
      console.error(`RPC notification ${path.join('.')} failed:`, error);
    };

    const receiveCall = (id: number, path: readonly string[], args: readonly unknown[]): void => {
      const resolved = resolveMethod(path);
      if (id === 0) {
        // A notification has no call site to reject; its failure is reported
        // here and never escapes the listener, where it would be the peer's
        // defect ending this whole context.
        try {
          if (!resolved) throw new TypeError(`RPC method ${path.join('.')} is not implemented.`);
          const result = resolved.method.apply(resolved.receiver, [...args]);
          if (isThenable(result)) {
            result.then(undefined, (error: unknown) => notificationFailed(path, error));
          }
        } catch (error) {
          notificationFailed(path, error);
        }
        return;
      }
      let result: unknown;
      try {
        if (!resolved) throw new TypeError(`RPC method ${path.join('.')} is not implemented.`);
        result = resolved.method.apply(resolved.receiver, [...args]);
      } catch (error) {
        respondError(id, error);
        return;
      }
      Promise.resolve(result).then(
        (value) => respond(id, value),
        (error: unknown) => respondError(id, error)
      );
    };

    const settle = (id: number, succeeded: boolean, value: unknown): void => {
      const call = pending.get(id);
      if (!call) return;
      pending.delete(id);
      if (succeeded) call.resolve(value);
      else call.reject(value);
    };

    // The peer may be a context running untrusted code, so a frame is checked
    // for shape before it is acted on; a malformed one is dropped.
    const onMessage = (event: MessageEvent): void => {
      const message = event.data as Partial<Record<string, unknown>> | null | undefined;
      if (typeof message !== 'object' || message === null) return;
      switch (message.kind) {
        case 'rpc:call':
          if (!isCallId(message.id) || !isPath(message.path) || !Array.isArray(message.args)) return;
          receiveCall(message.id, message.path, message.args);
          return;
        case 'rpc:return':
          if (!isCallId(message.id)) return;
          settle(message.id, true, message.value);
          return;
        case 'rpc:throw':
          if (!isCallId(message.id)) return;
          settle(
            message.id,
            false,
            reviveError(
              isSerializedError(message.error)
                ? message.error
                : { name: 'Error', message: 'The RPC peer rejected the call without an error.', properties: {} }
            )
          );
          return;
        case 'rpc:close':
          finish(closedError('The RPC peer closed the connection.'));
          return;
      }
    };

    const onMessageError = (): void => {
      finish(closedError('An RPC message could not be deserialized.'));
    };

    const invoke = (path: readonly string[], args: unknown[], reply: boolean): unknown => {
      if (!reply) {
        if (open) post({ kind: 'rpc:call', id: 0, path, args }, transferablesOf(args));
        return undefined;
      }
      if (!open) return Promise.reject(closedError('The RPC connection is closed.'));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          post({ kind: 'rpc:call', id, path, args }, transferablesOf(args));
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
    };

    const proxy = (path: readonly string[], reply: boolean): unknown => {
      const key = `${reply ? 'call' : 'notify'}\u0000${path.join('\u0000')}`;
      const cached = proxies.get(key);
      if (cached) return cached;
      const created = new Proxy(() => undefined, {
        get: (_target, property) =>
          typeof property === 'symbol' || property === 'then'
            ? undefined
            : proxy([...path, property], reply),
        apply: (_target, _receiver, args: unknown[]) => invoke(path, args, reply)
      });
      proxies.set(key, created);
      return created;
    };

    port.addEventListener('message', onMessage);
    port.addEventListener('messageerror', onMessageError);
    port.start?.();

    return {
      remote: proxy([], true) as Remote<RemoteApi>,
      notify: proxy([], false) as Notify<RemoteApi>,
      closed,
      close() {
        if (!open) return;
        try {
          post({ kind: 'rpc:close' });
        } catch {
          // The peer is already unreachable; local cleanup still completes.
        }
        finish(closedError('The RPC connection is closed.'));
      }
    };
  }

  function openMessageStream<Message = unknown>(port: RpcPort): MessageStream<Message> {
    const listeners = new Set<(message: Message) => void>();
    const connection = connectRpc<{ receive(message: Message): void }>(port, {
      receive(message: Message) {
        for (const listener of [...listeners]) listener(message);
      }
    });
    return {
      closed: connection.closed,
      send(message, transferList) {
        if (transferList?.length && typeof message === 'object' && message !== null) {
          transfer(message, transferList);
        }
        connection.notify.receive(message);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      close() {
        listeners.clear();
        connection.close();
      }
    };
  }

  return { connectRpc, transfer, openMessageStream };
}

export const { connectRpc, transfer, openMessageStream } = createWorkerTransport();

/**
 * The value a context throws or rejects with, as an `Error`: an error-shaped
 * object keeps its message, name and stack; anything else becomes its string.
 */
export function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (error && typeof error === 'object' && 'message' in error && typeof error.message === 'string') {
    const normalized = new Error(error.message);
    if ('name' in error && typeof error.name === 'string') normalized.name = error.name;
    if ('stack' in error && typeof error.stack === 'string') normalized.stack = error.stack;
    return normalized;
  }
  return new Error(String(error));
}

/**
 * Source text that defines `connectRpc`, `transfer`, and `openMessageStream`
 * for a context that cannot import package modules: the Service Worker and
 * documents served from a Published Endpoint.
 */
export function workerTransportBrowserArtifactSource(): string {
  // Transpilers that preserve function names call a `__name` helper.
  return [
    'const __name = (target) => target;',
    serializeError.toString(),
    reviveError.toString(),
    `const { connectRpc, transfer, openMessageStream } = (${createWorkerTransport.toString()})();`
  ].join('\n');
}

export type DiagnosticsChannelName = string | symbol;
export type DiagnosticsChannelSubscriber = (message: unknown, name: DiagnosticsChannelName) => void;

export class DiagnosticsChannel {
  private readonly subscribers = new Set<DiagnosticsChannelSubscriber>();

  constructor(readonly name: DiagnosticsChannelName) {}

  get hasSubscribers(): boolean {
    return this.subscribers.size > 0;
  }

  subscribe(subscriber: DiagnosticsChannelSubscriber): void {
    if (typeof subscriber !== 'function') throw new TypeError('The "subscription" argument must be of type function');
    this.subscribers.add(subscriber);
  }

  unsubscribe(subscriber: DiagnosticsChannelSubscriber): boolean {
    return this.subscribers.delete(subscriber);
  }

  publish(message: unknown): void {
    for (const subscriber of [...this.subscribers]) subscriber(message, this.name);
  }

  bindStore(): never {
    return unsupportedDiagnosticsStore('bindStore');
  }

  unbindStore(): never {
    return unsupportedDiagnosticsStore('unbindStore');
  }

  runStores<TResult, TArgs extends unknown[]>(
    context: unknown,
    callback: (...args: TArgs) => TResult,
    thisArg: unknown,
    ...args: TArgs
  ): TResult {
    this.publish(context);
    return callback.apply(thisArg, args);
  }
}

export type DiagnosticsChannelBuiltin = ReturnType<typeof createDiagnosticsChannelBuiltin>;

export function createDiagnosticsChannelBuiltin() {
  const channels = new Map<DiagnosticsChannelName, DiagnosticsChannel>();
  const channel = (name: DiagnosticsChannelName) => {
    const existing = channels.get(name);
    if (existing) return existing;
    const created = new DiagnosticsChannel(name);
    channels.set(name, created);
    return created;
  };
  const tracingChannel = (name: string) => {
    const channelsByPhase = {
      start: channel(`tracing:${name}:start`),
      end: channel(`tracing:${name}:end`),
      asyncStart: channel(`tracing:${name}:asyncStart`),
      asyncEnd: channel(`tracing:${name}:asyncEnd`),
      error: channel(`tracing:${name}:error`)
    };

    return {
      ...channelsByPhase,
      get hasSubscribers() {
        return Object.values(channelsByPhase).some((phase) => phase.hasSubscribers);
      }
    };
  };
  const diagnostics = {
    Channel: DiagnosticsChannel,
    channel,
    hasSubscribers: (name: DiagnosticsChannelName) => channel(name).hasSubscribers,
    subscribe: (name: DiagnosticsChannelName, subscriber: DiagnosticsChannelSubscriber) => channel(name).subscribe(subscriber),
    tracingChannel,
    unsubscribe: (name: DiagnosticsChannelName, subscriber: DiagnosticsChannelSubscriber) => channel(name).unsubscribe(subscriber)
  };

  return {
    ...diagnostics,
    default: diagnostics
  };
}

function unsupportedDiagnosticsStore(operation: string): never {
  const error = new Error(`node:diagnostics_channel ${operation} is not supported in the browser runtime`) as Error & {
    code: string;
  };
  error.code = 'ENOTSUP';
  throw error;
}

export type DnsLookupAddress = {
  readonly address: string;
  readonly family: 4 | 6;
};

export type DnsLookupOptions =
  | 4
  | 6
  | {
      readonly family?: 4 | 6;
      readonly all?: boolean;
      readonly verbatim?: boolean;
    };

export type DnsLookupCallback = (
  error: Error | null,
  address?: string | readonly DnsLookupAddress[],
  family?: 4 | 6
) => void;

export type DnsBuiltin = {
  readonly lookup: (hostname: string, options: DnsLookupOptions | DnsLookupCallback, callback?: DnsLookupCallback) => void;
  readonly promises: {
    readonly lookup: (hostname: string, options?: DnsLookupOptions) => Promise<DnsLookupAddress | readonly DnsLookupAddress[]>;
    readonly resolve: (...args: readonly unknown[]) => Promise<never>;
    readonly resolve4: (...args: readonly unknown[]) => Promise<never>;
    readonly resolve6: (...args: readonly unknown[]) => Promise<never>;
    readonly reverse: (...args: readonly unknown[]) => Promise<never>;
  };
  readonly resolve: (...args: readonly unknown[]) => void;
  readonly resolve4: (...args: readonly unknown[]) => void;
  readonly resolve6: (...args: readonly unknown[]) => void;
  readonly reverse: (...args: readonly unknown[]) => void;
  readonly lookupService: (...args: readonly unknown[]) => void;
  readonly default: Omit<DnsBuiltin, 'default'>;
};

/**
 * Creates the browser runtime's deterministic node:dns boundary. It resolves
 * only loopback names and addresses; real DNS needs a host-network capability.
 */
export function createDnsBuiltin(): DnsBuiltin {
  const lookup = (hostname: string, optionsOrCallback: DnsLookupOptions | DnsLookupCallback, callback?: DnsLookupCallback): void => {
    const resolvedCallback = typeof optionsOrCallback === 'function' ? optionsOrCallback : callback;
    if (!resolvedCallback) throw new TypeError('The "callback" argument must be of type function');
    const options = typeof optionsOrCallback === 'function' ? undefined : optionsOrCallback;
    queueMicrotask(() => {
      try {
        const result = lookupLoopback(hostname, options);
        if ('address' in result) resolvedCallback(null, result.address, result.family);
        else resolvedCallback(null, result);
      } catch (error) {
        resolvedCallback(asError(error));
      }
    });
  };
  const unsupported = (operation: string) => (...args: readonly unknown[]): void => {
    const callback = lastCallback(args);
    const error = unsupportedDns(operation);
    if (!callback) throw error;
    queueMicrotask(() => callback(error));
  };
  const rejectUnsupported = (operation: string) => async (..._args: readonly unknown[]): Promise<never> => {
    throw unsupportedDns(operation);
  };
  const promises = {
    lookup: async (hostname: string, options?: DnsLookupOptions): Promise<DnsLookupAddress | readonly DnsLookupAddress[]> =>
      lookupLoopback(hostname, options),
    resolve: rejectUnsupported('resolve'),
    resolve4: rejectUnsupported('resolve4'),
    resolve6: rejectUnsupported('resolve6'),
    reverse: rejectUnsupported('reverse')
  };
  const dns = {
    lookup,
    promises,
    resolve: unsupported('resolve'),
    resolve4: unsupported('resolve4'),
    resolve6: unsupported('resolve6'),
    reverse: unsupported('reverse'),
    lookupService: unsupported('lookupService')
  };
  return { ...dns, default: dns };
}

function lookupLoopback(hostname: string, options?: DnsLookupOptions): DnsLookupAddress | readonly DnsLookupAddress[] {
  const result = loopbackAddress(hostname, options);
  return typeof options === 'object' && options.all ? [result] : result;
}

function loopbackAddress(hostname: string, options?: DnsLookupOptions): DnsLookupAddress {
  if (typeof hostname !== 'string') throw new TypeError('The "hostname" argument must be of type string');
  const requested = typeof options === 'number' ? options : options?.family;
  if (requested !== undefined && requested !== 4 && requested !== 6) {
    throw new TypeError('The "family" option must be 4 or 6');
  }
  const normalized = hostname.toLowerCase();
  if (normalized === '::1') {
    if (requested === 4) throw unsupportedDns('lookup', hostname);
    return { address: '::1', family: 6 };
  }
  if (isIpv4Loopback(normalized)) {
    if (requested === 6) throw unsupportedDns('lookup', hostname);
    return { address: normalized, family: 4 };
  }
  if (normalized === 'localhost') {
    return requested === 6 ? { address: '::1', family: 6 } : { address: '127.0.0.1', family: 4 };
  }
  throw unsupportedDns('lookup', hostname);
}

function isIpv4Loopback(hostname: string): boolean {
  const octets = hostname.split('.');
  return octets.length === 4 && octets[0] === '127' && octets.every((octet) => /^(?:0|[1-9]\d{0,2})$/u.test(octet) && Number(octet) <= 255);
}

function unsupportedDns(operation: string, hostname?: string): Error & { code: 'ENOTSUP'; syscall: string; hostname?: string } {
  const target = hostname === undefined ? '' : ` for ${hostname}`;
  const error = Object.assign(
    new Error(`node:dns.${operation}()${target} is unavailable: this runtime only resolves loopback addresses.`),
    { code: 'ENOTSUP' as const, syscall: 'getaddrinfo', ...(hostname === undefined ? {} : { hostname }) }
  );
  error.name = 'NodeNetworkCapabilityError';
  return error;
}

function lastCallback(args: readonly unknown[]): ((error: Error) => void) | undefined {
  const candidate = args.at(-1);
  return typeof candidate === 'function' ? (candidate as (error: Error) => void) : undefined;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

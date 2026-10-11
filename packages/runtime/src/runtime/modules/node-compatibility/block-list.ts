type Family = 'ipv4' | 'ipv6';

type Rule =
  | { readonly kind: 'address'; readonly family: Family; readonly address: string; readonly value: bigint }
  | { readonly kind: 'range'; readonly family: Family; readonly start: string; readonly end: string; readonly from: bigint; readonly to: bigint }
  | { readonly kind: 'subnet'; readonly family: Family; readonly network: string; readonly prefix: number; readonly from: bigint; readonly to: bigint };

/**
 * `net.BlockList`: rules of addresses, ranges and subnets that `check()`
 * matches an address against. Programs build one to filter the interfaces or
 * peers they answer (dnssd-advertise, which Expo's dev server announces
 * itself through); the runtime's own sockets never consult it.
 */
export class BlockList {
  readonly #rules: Rule[] = [];

  static isBlockList(value: unknown): value is BlockList {
    return value instanceof BlockList;
  }

  addAddress(address: AddressInput, family?: string): void {
    const parsed = parseAddress(address, family);
    this.#rules.push({ kind: 'address', family: parsed.family, address: parsed.text, value: parsed.value });
  }

  addRange(start: AddressInput, end: AddressInput, family?: string): void {
    const from = parseAddress(start, family);
    const to = parseAddress(end, family ?? from.family);
    if (from.family !== to.family || from.value > to.value) {
      throw nodeError('ERR_INVALID_ARG_VALUE', 'The value of "start" must be less than or equal to "end"', RangeError);
    }
    this.#rules.push({ kind: 'range', family: from.family, start: from.text, end: to.text, from: from.value, to: to.value });
  }

  addSubnet(network: AddressInput, prefix: number, family?: string): void {
    const parsed = parseAddress(network, family);
    const bits = parsed.family === 'ipv4' ? 32 : 128;
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) {
      throw nodeError('ERR_OUT_OF_RANGE', `The value of "prefix" is out of range. It must be >= 0 && <= ${bits}. Received ${prefix}`, RangeError);
    }
    const host = (1n << BigInt(bits - prefix)) - 1n;
    const from = parsed.value & ~host & ((1n << BigInt(bits)) - 1n);
    this.#rules.push({ kind: 'subnet', family: parsed.family, network: parsed.text, prefix, from, to: from | host });
  }

  /** As Node's, false for an address that is not one of its family, or a family that is none. */
  check(address: AddressInput, family?: string): boolean {
    if (family !== undefined && typeof family !== 'string') {
      throw nodeError('ERR_INVALID_ARG_TYPE', 'The "family" argument must be of type string.', TypeError);
    }
    let parsed: ParsedAddress;
    try {
      parsed = parseAddress(address, family);
    } catch (error) {
      if ((error as { code?: unknown }).code === 'ERR_INVALID_ARG_TYPE') throw error;
      return false;
    }
    return this.#rules.some((rule) => matches(rule, parsed));
  }

  get rules(): string[] {
    return this.#rules
      .map((rule) => {
        const family = rule.family === 'ipv4' ? 'IPv4' : 'IPv6';
        if (rule.kind === 'address') return `Address: ${family} ${rule.address}`;
        if (rule.kind === 'range') return `Range: ${family} ${rule.start}-${rule.end}`;
        return `Subnet: ${family} ${rule.network}/${rule.prefix}`;
      })
      .reverse();
  }
}

type AddressInput = string | { readonly address: string; readonly family?: string };

type ParsedAddress = { readonly family: Family; readonly text: string; readonly value: bigint };

const IPV4_MAPPED_PREFIX = 0xffffn << 32n;

function matches(rule: Rule, address: ParsedAddress): boolean {
  const value = comparable(address, rule.family);
  if (value === undefined) return false;
  if (rule.kind === 'address') return value === rule.value;
  return value >= rule.from && value <= rule.to;
}

/** An address in the rule's family: an IPv4-mapped IPv6 address matches IPv4 rules and back. */
function comparable(address: ParsedAddress, family: Family): bigint | undefined {
  if (address.family === family) return address.value;
  if (family === 'ipv6') return IPV4_MAPPED_PREFIX | address.value;
  if (address.value >> 32n === 0xffffn) return address.value & 0xffffffffn;
  return undefined;
}

function parseAddress(input: AddressInput, family?: string): ParsedAddress {
  const text = typeof input === 'string' ? input : input?.address;
  const requested = (typeof input === 'string' ? family : (input?.family ?? family)) ?? 'ipv4';
  if (typeof text !== 'string') {
    throw nodeError('ERR_INVALID_ARG_TYPE', 'The "address" argument must be of type string or an instance of SocketAddress.', TypeError);
  }
  const normalized = String(requested).toLowerCase();
  if (normalized !== 'ipv4' && normalized !== 'ipv6') {
    throw nodeError('ERR_INVALID_ARG_VALUE', `The argument 'family' must be one of: 'ipv4', 'ipv6'. Received '${requested}'`, TypeError);
  }
  const value = normalized === 'ipv4' ? parseIPv4(text) : parseIPv6(text);
  if (value === undefined) {
    throw nodeError('ERR_INVALID_ADDRESS', `Invalid ${normalized === 'ipv4' ? 'IPv4' : 'IPv6'} address: ${text}`, Error);
  }
  return { family: normalized, text, value };
}

function parseIPv4(text: string): bigint | undefined {
  const parts = text.split('.');
  if (parts.length !== 4) return undefined;
  let value = 0n;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part) || Number(part) > 255) return undefined;
    value = (value << 8n) | BigInt(Number(part));
  }
  return value;
}

function parseIPv6(input: string): bigint | undefined {
  const text = input.replace(/%.*$/, '');
  const halves = text.split('::');
  if (halves.length > 2) return undefined;
  const groups = (half: string): bigint[] | undefined => {
    if (half === '') return [];
    const result: bigint[] = [];
    const parts = half.split(':');
    for (const [index, part] of parts.entries()) {
      if (index === parts.length - 1 && part.includes('.')) {
        const v4 = parseIPv4(part);
        if (v4 === undefined) return undefined;
        result.push(v4 >> 16n, v4 & 0xffffn);
      } else if (/^[0-9a-f]{1,4}$/i.test(part)) {
        result.push(BigInt(Number.parseInt(part, 16)));
      } else {
        return undefined;
      }
    }
    return result;
  };
  const head = groups(halves[0]!);
  const tail = halves.length === 2 ? groups(halves[1]!) : [];
  if (!head || !tail) return undefined;
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return undefined;
  return [...head, ...Array<bigint>(missing).fill(0n), ...tail].reduce((value, group) => (value << 16n) | group, 0n);
}

function nodeError(code: string, message: string, Constructor: ErrorConstructor | RangeErrorConstructor | TypeErrorConstructor): Error {
  return Object.assign(new Constructor(message), { code });
}

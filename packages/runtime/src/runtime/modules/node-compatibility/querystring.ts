import { BrowserBuffer } from './buffer';

export const escape = (input: string) => encodeURIComponent(String(input));

/** Decodes like `decodeURIComponent`, keeping a malformed escape as its text as Node does. */
export function unescape(input: string): string {
  const text = String(input).replace(/\+/g, ' ');
  try {
    return decodeURIComponent(text);
  } catch {
    return unescapeBuffer(text).toString();
  }
}

function unescapeBuffer(input: string): BrowserBuffer {
  const bytes: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const escaped = input[index] === '%' ? /^[0-9a-fA-F]{2}$/.exec(input.slice(index + 1, index + 3)) : null;
    if (escaped) {
      bytes.push(Number.parseInt(escaped[0], 16));
      index += 2;
    } else {
      bytes.push(...BrowserBuffer.from(input[index]));
    }
  }
  return BrowserBuffer.from(bytes);
}

/** Node writes only strings, finite numbers, bigints and booleans; any other value is empty. */
function stringifyPrimitive(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'bigint' || typeof value === 'boolean') return String(value);
  return '';
}

type ParseOptions = { maxKeys?: number; decodeURIComponent?: (input: string) => string };

/** Parses into a null-prototype object, reading at most `maxKeys` (1000) pairs as Node does. */
export function parse(input: string, sep = '&', eq = '=', options: ParseOptions = {}): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = Object.create(null);
  if (!input) return result;
  const maxKeys = options.maxKeys ?? 1000;
  const decode = options.decodeURIComponent ?? unescape;
  const parts = String(input).split(sep || '&');
  for (const part of maxKeys > 0 ? parts.slice(0, maxKeys) : parts) {
    if (!part) continue;
    const separator = eq || '=';
    const index = part.indexOf(separator);
    const rawKey = index === -1 ? part : part.slice(0, index);
    const rawValue = index === -1 ? '' : part.slice(index + separator.length);
    const key = decode(rawKey.replace(/\+/g, ' '));
    const value = decode(rawValue.replace(/\+/g, ' '));
    const previous = result[key];
    if (previous === undefined) result[key] = value;
    else if (Array.isArray(previous)) previous.push(value);
    else result[key] = [previous, value];
  }
  return result;
}

export function stringify(input: Record<string, unknown>, sep = '&', eq = '='): string {
  return Object.entries(input)
    .flatMap(([key, value]) => {
      const values = Array.isArray(value) ? value : [value];
      return values.map((entry) => `${escape(key)}${eq}${escape(stringifyPrimitive(entry))}`);
    })
    .join(sep);
}

export function createQuerystringBuiltin(): unknown {
  const querystring = {
    parse,
    decode: parse,
    stringify,
    encode: stringify,
    escape,
    unescape,
    unescapeBuffer: (input: string) => BrowserBuffer.from(unescape(input))
  };
  return {
    ...querystring,
    default: querystring
  };
}

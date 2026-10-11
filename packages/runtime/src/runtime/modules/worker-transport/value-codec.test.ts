import { describe, expect, test } from 'vitest';

import { decodeValue, encodeValue } from './value-codec';

describe('binary value encoding', () => {
  test('round-trips structured data with shared references, cycles, and raw bytes', () => {
    const shared = { label: 'shared' };
    const cyclic: Record<string, unknown> = { name: 'cycle' };
    cyclic.self = cyclic;
    const bytes = Uint8Array.from({ length: 10_000 }, (_, index) => index % 256);
    const value = {
      primitives: [undefined, null, true, false, 0, -0, 42, -1.5, Number.NaN, 2 ** 40, 12n],
      text: ['', 'ascii', 'длинный текст 🚀', 'x'.repeat(5_000)],
      collections: [new Map<unknown, unknown>([[1, shared], ['key', [shared]]]), new Set([shared, 'item'])],
      date: new Date(1_700_000_000_000),
      pattern: /a+b/giu,
      error: Object.assign(new TypeError('broken'), { stack: 'TypeError: broken\n    at test' }),
      buffers: [bytes, new Float64Array([1.5, -2]), new DataView(new Uint8Array([1, 2, 3]).buffer, 1, 2), new Uint8Array(4).buffer],
      cyclic,
      ['__proto__']: 'own key'
    };

    const encoded = encodeValue(value);
    expect(encoded.parts.length).toBeGreaterThan(1);
    const joined = new Uint8Array(encoded.byteLength);
    let offset = 0;
    for (const part of encoded.parts) {
      joined.set(part, offset);
      offset += part.byteLength;
    }
    const decoded = decodeValue(joined) as typeof value;

    expect(decoded.primitives).toEqual(value.primitives);
    expect(Object.is(decoded.primitives[5], -0)).toBe(true);
    expect(decoded.text).toEqual(value.text);
    const [map, set] = decoded.collections as [Map<unknown, unknown>, Set<unknown>];
    expect(map.get(1)).toBe((map.get('key') as unknown[])[0]);
    expect(set.has(map.get(1))).toBe(true);
    expect(decoded.date).toEqual(value.date);
    expect(decoded.pattern).toEqual(value.pattern);
    expect(decoded.error).toMatchObject({ name: 'TypeError', message: 'broken', stack: value.error.stack });
    expect(decoded.buffers[0]).toEqual(bytes);
    expect(decoded.buffers[1]).toEqual(new Float64Array([1.5, -2]));
    expect([...new Uint8Array((decoded.buffers[2] as DataView).buffer)]).toEqual([2, 3]);
    expect(decoded.buffers[3]).toBeInstanceOf(ArrayBuffer);
    expect(decoded.cyclic.self).toBe(decoded.cyclic);
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe('own key');
  });

  test('refuses what it cannot carry by content', () => {
    expect(() => encodeValue({ run() {} })).toThrowError(expect.objectContaining({ name: 'DataCloneError' }));
    expect(() => encodeValue(new Int32Array(new SharedArrayBuffer(4)))).toThrowError(
      expect.objectContaining({ name: 'DataCloneError' })
    );
  });
});

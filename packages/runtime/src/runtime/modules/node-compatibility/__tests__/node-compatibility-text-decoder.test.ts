import { describe, expect, test } from 'vitest';

import { nodeTextDecoder } from '../text-decoder';

describe('Node Compatibility TextDecoder', () => {
  test('a fatal decode of invalid input names ERR_ENCODING_INVALID_ENCODED_DATA, as Node does', () => {
    const NodeTextDecoder = nodeTextDecoder(globalThis.TextDecoder);
    const decoder = new NodeTextDecoder('utf-8', { fatal: true });

    expect(() => decoder.decode(new Uint8Array([0xff, 0xfe]))).toThrow(
      expect.objectContaining({ name: 'TypeError', code: 'ERR_ENCODING_INVALID_ENCODED_DATA' })
    );
    expect(new NodeTextDecoder().decode(new Uint8Array([0xff]))).toBe('�');
    expect(decoder.decode(new TextEncoder().encode('ok'))).toBe('ok');
    expect(decoder).toBeInstanceOf(globalThis.TextDecoder);
  });

  test('decodes a view of a SharedArrayBuffer, and is one class however often it is asked for', () => {
    const NodeTextDecoder = nodeTextDecoder(globalThis.TextDecoder);
    const shared = new Uint8Array(new SharedArrayBuffer(2));
    shared.set([0x68, 0x69]);

    expect(new NodeTextDecoder().decode(shared)).toBe('hi');
    expect(nodeTextDecoder(globalThis.TextDecoder)).toBe(NodeTextDecoder);
    expect(nodeTextDecoder(NodeTextDecoder)).toBe(NodeTextDecoder);
  });
});

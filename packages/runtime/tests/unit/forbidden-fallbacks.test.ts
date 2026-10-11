import { describe, expect, test } from 'vitest';

import {
  findForbiddenFallbacks,
  findNativeRolldownBindings,
  forbiddenFallbacks
} from '../e2e/forbidden-fallbacks';

describe('forbidden fallback evidence', () => {
  test('names every fallback a transcript mentions, in the order the fallbacks are declared', () => {
    expect(
      findForbiddenFallbacks(
        [
          'host Node',
          'falling back to registered command adapter',
          'https://esm.sh/react',
          'vfsPreviewFallback',
          'package-specific runtime branch',
          'silently substituted'
        ].join('\n')
      )
    ).toEqual(forbiddenFallbacks);
    expect(findForbiddenFallbacks('added 12 packages in 3s')).toEqual([]);
  });

  test('treats a Rolldown binding for another platform as a native substitution', () => {
    expect(findNativeRolldownBindings(['pluginutils', 'binding-wasm32-wasi', 'binding-linux-x64-gnu'])).toEqual([
      'binding-linux-x64-gnu'
    ]);
  });

  test('does not treat the approved Rolldown WASI binding as a native substitution', () => {
    expect(findNativeRolldownBindings(['pluginutils', 'binding-wasm32-wasi'])).toEqual([]);
  });
});

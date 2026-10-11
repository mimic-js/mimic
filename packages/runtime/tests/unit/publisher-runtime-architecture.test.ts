import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from 'vitest';

const forbiddenPublisherIdentities = [
  'lightningcss-wasm-1.32.0',
  'parcel/lightning css',
  '@rolldown/browser',
  'rolldown-browser-1.1.5',
  'rolldown-binding.wasm32-wasi.wasm',
  'rolldown/oxc',
  'oxc-parser-wasi-0.139.0',
  '@oxc-parser/binding-wasm32-wasi',
  '@rspack/binding-wasm32-wasi',
  'rspack-wasi-2.1.3',
  'rspack.wasm32-wasi.wasm'
] as const;

test('keeps compatibility publisher identities out of production runtime branches', () => {
  const productionSources = readSources('src').toLowerCase();

  for (const identity of forbiddenPublisherIdentities) {
    expect(productionSources, `production source contains publisher identity ${identity}`).not.toContain(identity);
  }
});

test('keeps Lightning CSS publisher replacement knowledge inside the replacement map', () => {
  const replacementMapPath =
    'src/runtime/modules/process-execution/package-manager/browser-package-replacements.ts';
  const replacementMapSource = readFileSync(replacementMapPath, 'utf8').toLowerCase();
  const productionWithoutReplacementMap = readSources('src', new Set([replacementMapPath])).toLowerCase();

  for (const identity of ['lightningcss-wasm']) {
    expect(replacementMapSource).toContain(identity);
    expect(productionWithoutReplacementMap, `production branch contains ${identity} outside the replacement map`).not.toContain(
      identity
    );
  }
});

function readSources(path: string, excludedPaths: ReadonlySet<string> = new Set()): string {
  return readdirSync(path, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = join(path, entry.name);
      if (excludedPaths.has(entryPath)) return [];
      if (entry.isDirectory()) return readSources(entryPath, excludedPaths);
      if (entry.name.includes('.test.')) return [];
      return /\.(?:ts|tsx|js|jsx)$/.test(entry.name) ? [readFileSync(entryPath, 'utf8')] : [];
    })
    .join('\n');
}

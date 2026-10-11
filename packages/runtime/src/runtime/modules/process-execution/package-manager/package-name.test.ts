import { expect, test } from 'vitest';

import { napiCompanions } from './browser-package-replacements';
import { InvalidPackageNameError, isValidPackageName } from './package-name';

test('accepts the names the npm registry publishes', () => {
  for (const name of ['rolldown', '@rollup/wasm-node', '@node-rs/crc32', 'lightningcss-wasm', 'a', 'x.y_z-1', `${'a'.repeat(200)}-wasm32-wasi`]) {
    expect(isValidPackageName(name), name).toBe(true);
  }
});

test('rejects names that would escape a registry URL, an install spec or a path', () => {
  for (const name of [
    '', '..', '../evil', 'a/..', '@scope/../x', 'a/b', '@a/b/c', '@/x', '@a/', 'Rolldown', '.hidden', '_private',
    '@.scope/x', 'a b', 'a%2fb', 'a?b', 'a#b', 'a:b', "a'b", 'a*b', 'a~b', `${'a'.repeat(215)}`
  ]) {
    expect(isValidPackageName(name), JSON.stringify(name)).toBe(false);
  }
});

test('napiCompanions refuses a binding name derived from invalid metadata', () => {
  const targets = ['wasm32-wasip1-threads'];

  expect(napiCompanions({ name: 'rolldown', napi: { packageName: '@rolldown/binding', targets } }))
    .toEqual(['@rolldown/binding-wasm32-wasi', '@rolldown/binding-wasm32-wasip1']);
  expect(() => napiCompanions({ name: 'evil', napi: { packageName: '../../.mimic/bin/esbuild', targets } }))
    .toThrow(InvalidPackageNameError);
  expect(() => napiCompanions({ name: 'evil', napi: { packageName: '@a/b/c', targets } }))
    .toThrow(/napi\.packageName metadata names "@a\/b\/c", which is not a valid npm package name/u);
  expect(() => napiCompanions({ name: 'Evil Name', napi: { targets } }))
    .toThrow(/package\.json "name" field names "Evil Name"/u);
  expect(() => napiCompanions({ name: 'a'.repeat(210), napi: { targets } })).toThrow(InvalidPackageNameError);
  // Without a WASI target, nothing is derived and nothing is checked.
  expect(napiCompanions({ name: 'evil', napi: { packageName: '../x', targets: ['x86_64-unknown-linux-gnu'] } })).toEqual([]);
});

import * as Rollup from '@rollup/browser';
const modules = { 'entry.js': "import { shared } from './shared.js'; export const answer = shared + 2; export async function loadLazy() { return import('./lazy.js'); }", 'admin.js': "import { shared } from './shared.js'; export const admin = shared + 5;", 'shared.js': 'export const shared = 40;', 'lazy.js': 'export const lazy = 7;' };
const plugins = [{ name: 'browser-virtual-config', resolveId(source) { return source.startsWith('./') ? source.slice(2) : source; }, load(id) { return modules[id] ?? null; } }];
const bundle = await Rollup.rollup({ input: { entry: 'entry.js', admin: 'admin.js' }, plugins });
try {
  const esm = await bundle.generate({ format: 'esm', dir: 'generated/esm', entryFileNames: '[name].js', chunkFileNames: 'chunks/[name]-[hash].js' });
  const cjs = await bundle.generate({ format: 'cjs', dir: 'generated/cjs', entryFileNames: '[name].cjs', chunkFileNames: 'chunks/[name]-[hash].cjs' });
  const names = (generated) => generated.output.map((chunk) => chunk.fileName);
  const esmNames = names(esm); const cjsNames = names(cjs);
  const hasSharedChunk = esmNames.some((name) => name.includes('shared')) && cjsNames.some((name) => name.includes('shared'));
  const hasDynamicChunk = esmNames.some((name) => name.includes('lazy')) && cjsNames.some((name) => name.includes('lazy'));
  globalThis.__rollup3Browser = { version: Rollup.VERSION, outputs: { esm: esmNames.length, cjs: cjsNames.length, hasSharedChunk, hasDynamicChunk } };
  document.body.textContent = 'Rollup 3 browser output: 42';
} finally { await bundle.close(); }
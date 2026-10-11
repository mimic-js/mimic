import type { ModuleFormat } from './runtime-artifact';

/**
 * The format Node gives a file from its name and the `type` of its package
 * scope. `detect` and `detect-typescript` mark JavaScript that neither settles,
 * whose source decides as in Node's syntax detection.
 */
export function moduleFormatFromPath(
  path: string,
  packageType: unknown
): Exclude<ModuleFormat, 'builtin'> | 'detect' | 'detect-typescript' {
  if (path.endsWith('.json')) return 'json';
  if (path.endsWith('.wasm')) return 'wasm';
  if (path.endsWith('.mts')) return 'module-typescript';
  if (path.endsWith('.cts')) return 'commonjs-typescript';
  if (path.endsWith('.tsx')) {
    throw new Error(`TypeScript JSX is unsupported in the browser runtime: ${path}`);
  }
  if (path.endsWith('.mjs')) return 'module';
  if (path.endsWith('.cjs')) return 'commonjs';
  const typeScript = path.endsWith('.ts');
  if (packageType === 'module') return typeScript ? 'module-typescript' : 'module';
  if (packageType === 'commonjs') return typeScript ? 'commonjs-typescript' : 'commonjs';
  if (/(?:\.(?:js|ts)|\/[^./]+)$/.test(path)) return typeScript ? 'detect-typescript' : 'detect';
  return typeScript ? 'commonjs-typescript' : 'commonjs';
}

export const forbiddenFallbacks = [
  'falling back to registered command adapter',
  'esm.sh',
  'vfsPreviewFallback',
  'host Node',
  'package-specific runtime branch',
  'silently substituted'
] as const;

export function findForbiddenFallbacks(evidence: string): readonly string[] {
  return forbiddenFallbacks.filter((fallback) => evidence.includes(fallback));
}

/** The Rolldown bindings among the entries of `node_modules/@rolldown` that are built for a platform other than the virtual one. */
export function findNativeRolldownBindings(scopeEntries: readonly string[]): readonly string[] {
  return scopeEntries.filter((name) => name.startsWith('binding-') && name !== 'binding-wasm32-wasi');
}

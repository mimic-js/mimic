/// <reference types="vite/client" />

// Babel publishes no types for these; the compiler uses this much of them
// (ADR-0034).
declare module '@babel/core' {
  export const version: string;
  export function transformSync(
    code: string,
    options: Record<string, unknown>
  ): { readonly code?: string | null } | null;
}

declare module '@babel/parser' {
  export function parse(code: string, options: Record<string, unknown>): unknown;
}

declare module '@babel/preset-typescript' {
  const preset: unknown;
  export default preset;
}

declare module '@babel/plugin-transform-export-namespace-from' {
  const plugin: unknown;
  export default plugin;
}

declare module '@babel/plugin-transform-modules-systemjs' {
  const plugin: unknown;
  export default plugin;
}

declare module 'brotli/decompress.js' {
  export default function decompress(input: Uint8Array): Uint8Array;
}

declare module 'node:zlib' {
  export function gunzipSync(input: Uint8Array): Uint8Array;
}

declare module 'node:crypto' {
  interface Hash {
    update(input: Uint8Array): Hash;
    digest(): Uint8Array;
  }

  export function createHash(algorithm: string): Hash;
}

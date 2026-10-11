import { fileURLToPath } from 'node:url';
import type { Alias } from 'vite';

const portDependency = (name: string) =>
  fileURLToPath(new URL(`./src/runtime/modules/node-compatibility/port-dependencies/${name}.ts`, import.meta.url));

/**
 * The adopted Node builtin ports (ADR-0026) name some of their own Node
 * dependencies by bare specifier. Each of those resolves to the runtime's
 * module instead of a second browser polyfill, so a port and the program
 * share one `Buffer`, one `EventEmitter` and one event loop. The package build,
 * the development server and the unit tests all apply these aliases.
 */
export const nodeCompatibilityPortAliases: Alias[] = [
  { find: /^buffer$/, replacement: portDependency('buffer') },
  { find: /^events$/, replacement: portDependency('events') },
  { find: /^process\/$/, replacement: portDependency('process') },
  { find: /^qs$/, replacement: portDependency('querystring') }
];

/**
 * The ports' entry points. A dependency optimizer bundles them up front: the
 * CommonJS ones so the aliases apply inside them, and all of them because a
 * development server would otherwise only discover them when a worker first
 * imports one, and reload while that worker starts.
 */
export const nodeCompatibilityPorts = [
  '@noble/hashes/hmac.js',
  '@noble/hashes/legacy.js',
  '@noble/hashes/pbkdf2.js',
  '@noble/hashes/sha2.js',
  '@noble/hashes/sha3.js',
  'events/events.js',
  'node-inspect-extracted',
  'path-browserify',
  'readable-stream/lib/stream.js',
  'string_decoder/lib/string_decoder.js',
  'url/url.js'
];

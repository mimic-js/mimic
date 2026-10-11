import punycode from 'punycode/punycode.es6.js';

/**
 * `node:punycode` is the `punycode` port, the library Node bundles as
 * `lib/punycode.js` (ADR-0026). Node deprecates the module but still serves it.
 */
export function createPunycodeBuiltin(): unknown {
  return { ...punycode, default: punycode };
}

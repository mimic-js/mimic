/**
 * `util.inspect` and `util.format`, which `console`, `util` and `assert`
 * share, are `node-inspect-extracted`: Node's own
 * `lib/internal/util/inspect.js` with only its `require` calls replaced
 * (ADR-0026).
 */
export {
  format,
  formatWithOptions,
  inspect,
  stripVTControlCharacters,
  type InspectOptions
} from 'node-inspect-extracted';

/**
 * `assert` as Babel's module transforms call it: `assert(condition, message)`
 * and nothing else. The compiler worker's build resolves Node's `assert` here
 * (ADR-0034); a program's `node:assert` is Node Compatibility's and unrelated.
 */
export default function assert(condition: unknown, message?: string): asserts condition {
  if (!condition) throw new Error(message ?? 'Assertion failed');
}

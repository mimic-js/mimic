/**
 * The runtime modules the adopted ports (ADR-0026) import by bare specifier,
 * held in one realm-wide slot. The bundler aliases those specifiers to the
 * modules beside this one, which read the slot, so a port shares the runtime's
 * `Buffer`, `EventEmitter` and Async Context even where a dependency optimizer
 * copies an alias target into the port's own chunk. `./provide` fills the slot
 * and every module that imports a port imports it first.
 */
export type PortDependencies = {
  readonly buffer: Readonly<Record<string, unknown>>;
  readonly events: unknown;
  readonly querystring: {
    parse(query: string): Record<string, string | string[]>;
    stringify(query: Record<string, unknown>): string;
  };
  nextTick(callback: (...args: unknown[]) => void, ...args: unknown[]): void;
};

const SLOT = Symbol.for('mimic.node-compatibility.port-dependencies');

type Slotted = { [SLOT]?: PortDependencies };

export function providePortDependencies(dependencies: PortDependencies): void {
  (globalThis as Slotted)[SLOT] ??= dependencies;
}

export function portDependencies(): PortDependencies {
  const dependencies = (globalThis as Slotted)[SLOT];
  if (!dependencies) throw new Error('A Node Compatibility port loaded before its dependencies were provided.');
  return dependencies;
}

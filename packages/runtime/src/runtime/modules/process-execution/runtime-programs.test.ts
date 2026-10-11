import { describe, expect, test } from 'vitest';

import {
  createRuntimeProgramRegistry,
  type RuntimeProgram
} from './runtime-programs';

describe('Process Execution Runtime Program registry', () => {
  test('resolves admitted program identities and declared command aliases', () => {
    const node: RuntimeProgram = {
      id: 'javascript',
      commands: ['node', '/usr/bin/node'],
      run: () => 0
    };
    const registry = createRuntimeProgramRegistry([node]);

    expect(registry.resolve('node')).toBe(node);
    expect(registry.resolve('/usr/bin/node')).toBe(node);
    expect(registry.resolve('javascript')).toBe(node);
    expect(registry.resolve('npm')).toBeUndefined();
    expect(registry.programs).toEqual([node]);
  });

  test('rejects duplicate command ownership', () => {
    expect(() =>
      createRuntimeProgramRegistry([
        { id: 'first', commands: ['node'], run: () => 0 },
        { id: 'second', commands: ['node'], run: () => 0 }
      ])
    ).toThrow('Runtime Program command "node" is already owned by "first".');
  });
});

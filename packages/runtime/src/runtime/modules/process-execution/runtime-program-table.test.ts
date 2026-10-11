import { describe, expect, test } from 'vitest';

import { createRuntimeProgramTable, type RuntimeProgramTableContext } from './runtime-program-table';
import type { CoreUtilityFileSystem } from './core-utilities';
import type { ProcessFileSystemClient } from './file-system-ports';

const programs = {
  javaScript: { id: 'javascript', commands: ['node', '/usr/bin/node'] },
  wasi: { id: 'wasi', inspect: () => ({ kind: 'unrecognized' as const }) }
};

function table(
  implementations: Parameters<typeof createRuntimeProgramTable<RuntimeProgramTableContext>>[0]['implementations']
) {
  return createRuntimeProgramTable<RuntimeProgramTableContext>({
    programs,
    implementations,
    files: () => ({}) as CoreUtilityFileSystem,
    fileSystem: {} as ProcessFileSystemClient,
    spawnChild: () => Promise.reject(new Error('not spawned')),
    replaceProgram: () => Promise.reject(new Error('not replaced'))
  });
}

describe('Process Execution Runtime Program table', () => {
  test('assembles the shell, the injected programs, the core utilities and the Command Proxies', () => {
    const { registry, resolution } = table([
      { id: 'javascript', handlesSignals: true, run: () => 0 },
      { id: 'wasi', run: () => 0 }
    ]);
    expect(
      ['sh', 'node', 'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'yarnpkg', '/.mimic/bin/esbuild', 'echo', 'which', 'wasi'].map(
        (command) => registry.resolve(command)?.id.replace(/@.*$/, '')
      )
    ).toEqual([
      'sh',
      'javascript',
      'toolchain:npm',
      'toolchain:npm',
      'toolchain:pnpm',
      'toolchain:pnpm',
      'toolchain:yarn',
      'toolchain:yarn',
      'browser-package-replacement:esbuild',
      'echo',
      'which',
      'wasi'
    ]);
    expect(registry.resolve('node')?.handlesSignals).toBe(true);
    expect(resolution.javaScript).toEqual({
      programId: 'javascript',
      interpreterNames: ['node'],
      interpreterPaths: ['/usr/bin/node']
    });
    expect(resolution.runtimePrograms.at(-1)).toMatchObject({ id: 'wasi', inspect: programs.wasi.inspect });
  });

  test('requires one implementation for each injected program', () => {
    expect(() => table([{ id: 'javascript', run: () => 0 }])).toThrow(
      'Runtime Program "wasi" has no implementation.'
    );
    expect(() =>
      table([
        { id: 'javascript', run: () => 0 },
        { id: 'wasi', run: () => 0 },
        { id: 'python', run: () => 0 }
      ])
    ).toThrow('Runtime Programs are not registered: python.');
  });
});

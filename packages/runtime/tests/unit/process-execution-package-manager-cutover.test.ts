import { existsSync, globSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

describe('Runtime Host toolchain composition cutover', () => {
  test('deletes the Package Installation and compound toolchain owners', () => {
    expect(existsSync(
      'src/runtime/modules/package-installation-program'
    )).toBe(false);
    expect(existsSync(
      'src/runtime/modules/toolchain-catalog-artifact-cache'
    )).toBe(false);
  });

  test('keeps migrated package and compatibility callers on target process and teardown contracts', () => {
    const callers = [
      'tests/e2e/mimic-eslint.spec.ts',
      'tests/e2e/mimic-npm-exact-workspace.spec.ts',
      'tests/e2e/mimic-pnpm-exact-workspace.spec.ts',
      'tests/e2e/mimic-prettier.spec.ts',
      'tests/e2e/mimic-typescript6.spec.ts',
      'tests/e2e/mimic-webpack5.spec.ts',
      'tests/e2e/mimic-yarn-node-modules-workspace.spec.ts',
      'tests/e2e/mimic-yarn-pnp-zipfs.spec.ts',
      'tests/e2e/express-compatibility.spec.ts',
      'tests/e2e/fastify-compatibility.spec.ts',
      'tests/e2e/publisher-artifact-harness.ts',
      'tests/e2e/ws-compatibility.spec.ts'
    ];

    for (const caller of callers) {
      const source = readFileSync(caller, 'utf8');
      expect(source, caller).not.toMatch(
        /\b(?:devServer|process|[A-Za-z][A-Za-z0-9]*Process)\.(?:input|output)\b/u
      );
      expect(source, caller).not.toMatch(
        /(?<!await )\b[A-Za-z][A-Za-z0-9]*\.teardown\(\);/u
      );
    }
  });

  test('keeps Mimic unaware of package-manager composition', () => {
    const mimic = readFileSync(
      'src/runtime/index.ts',
      'utf8'
    );

    for (const forbidden of [
      'PackageCache',
      'createDefaultPackageCache',
      'createToolchainCatalogArtifactCache',
      'defaultToolchainPrograms',
      'runRuntimeToolchainProgram',
      'runtimeProgramAdapters',
      'toolchainRuntimePrograms'
    ]) {
      expect(mimic).not.toContain(forbidden);
    }
  });

  test('does not expose production Runtime Program adapter injection', () => {
    const client = readFileSync(
      'src/runtime/modules/runtime-host/runtime-host.ts',
      'utf8'
    );
    const adapters = readFileSync(
      'src/runtime/modules/runtime-host/runtime-program-host.ts',
      'utf8'
    );

    expect(client).not.toContain('runtimeProgramAdapters?:');
    expect(adapters).not.toContain('extraPrograms:');
    expect(adapters).not.toContain('legacyProgramsByCommand');
  });

  test('keeps package-manager Command Proxies private beneath Process Execution', () => {
    const hostComposition = readFileSync(
      'src/runtime/modules/runtime-host/runtime-host.ts',
      'utf8'
    );
    const hostEntryPoint = readFileSync(
      'src/runtime/modules/runtime-host/index.ts',
      'utf8'
    );
    const processHost = readFileSync(
      'src/runtime/modules/runtime-host/runtime-program-host.ts',
      'utf8'
    );
    const commandProxies = readFileSync(
      'src/runtime/modules/process-execution/package-manager-command-proxies.ts',
      'utf8'
    );
    const processExecution = readFileSync(
      'src/runtime/modules/process-execution/process-execution.ts',
      'utf8'
    );

    for (const source of [hostComposition, hostEntryPoint]) {
      for (const forbidden of [
        'package-installation-program',
        'toolchain-catalog-artifact-cache',
        'createRuntimeHostToolchainPrograms',
        'createRuntimeToolchainAdapters'
      ]) {
        expect(source).not.toContain(forbidden);
      }
    }
    expect(processHost).not.toContain('createPackageManagerCommandProxies');
    for (const forbidden of [
      'class PackageManager',
      'createRuntimeToolchainAdapters',
      'createToolchainCatalogArtifactCache'
    ]) {
      expect(commandProxies).not.toContain(forbidden);
    }
    expect(processExecution).not.toContain('defaultToolchainPrograms');
    expect(processExecution).not.toMatch(/\.map\(\s*\(toolchain\)/u);
  });

  test('keeps the pinned CLIs and the replacement map beneath the Command Proxies', () => {
    const productionCallers = globSync('src/runtime/modules/**/*.ts')
      .filter((path) =>
        !path.endsWith('.test.ts') &&
        !path.includes('/process-execution/package-manager/')
      )
      .filter((path) => [...readFileSync(path, 'utf8').matchAll(
        /(?:\bfrom\s+|\bimport\s+(?:\(\s*)?)['"]([^'"]+)['"]/gu
      )].some(([, specifier]) =>
        specifier?.startsWith('./package-manager/')
      ));

    expect(productionCallers).toEqual([
      'src/runtime/modules/process-execution/package-manager-command-proxies.ts'
    ]);
    const processEntryPoint = readFileSync(
      'src/runtime/modules/process-execution/index.ts',
      'utf8'
    );
    expect(processEntryPoint).not.toContain('createPackageManagerCommandProxies');
    expect(
      readFileSync('src/runtime/modules/process-execution/runtime-program-table.ts', 'utf8')
    ).toContain('createPackageManagerCommandProxies');
  });
});

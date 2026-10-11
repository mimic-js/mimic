import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const maintainedVite6Fixtures = [
  ['vanillaVite6Package', 'vanillaVite6PackageLock', 'compatibility/fixtures/vanilla-vite-6.4.3'],
  ['typescriptPackage', 'typescriptPackageLock', 'compatibility/fixtures/typescript-vite-6.4.3'],
  ['reactPackage', 'reactPackageLock', 'compatibility/fixtures/react-18-vite-6.4.3'],
  ['vuePackage', 'vuePackageLock', 'compatibility/fixtures/vue-3-vite-6.4.3'],
  ['solidPackage', 'solidPackageLock', '../../apps/e2e-demo/src/demo-fixtures/solid'],
  ['sveltePackage', 'sveltePackageLock', 'compatibility/fixtures/svelte-5-vite-6.4.3']
] as const;

const maintainedVite6Specs = [
  'tests/e2e/mimic-typescript-vite6.spec.ts',
  'tests/e2e/mimic-vite6-config.spec.ts',
  'tests/e2e/mimic-vite6-optimizer.spec.ts',
  'tests/e2e/mimic-react18.spec.ts',
  'tests/e2e/mimic-vue3.spec.ts',
  'tests/e2e/mimic-solid1.spec.ts',
  'tests/e2e/mimic-svelte5.spec.ts'
] as const;

describe('Vite 6 compatibility matrix', () => {
  test('removes the superseded centralized authorities', () => {
    for (const deletedAuthority of [
      '../../compatibility/coverage.ts',
      '../../compatibility/manifest.ts',
      '../../compatibility/vite-lanes.ts',
      '../e2e/compatibility-cold-receipt.spec.ts',
      '../e2e/mimic-vite-lanes.spec.ts'
    ]) {
      expect(existsSync(new URL(deletedAuthority, import.meta.url)), deletedAuthority).toBe(false);
    }
  });

  test('keeps demo fixtures on their reviewed manifests and lockfiles', () => {
    const appSource = readFileSync(new URL('../../../../apps/e2e-demo/src/App.tsx', import.meta.url), 'utf8');

    for (const [packageVariable, lockVariable, fixturePath] of maintainedVite6Fixtures) {
      expect(appSource).toContain(`JSON.stringify(${packageVariable}, null, 2)`);
      expect(appSource).toContain(`JSON.stringify(${lockVariable})`);

      const packageManifest = parseJsonRecord(
        readFileSync(new URL(`../../${fixturePath}/package.json`, import.meta.url), 'utf8'),
        `${fixturePath} package manifest`
      );
      const packageLock = parseJsonRecord(
        readFileSync(new URL(`../../${fixturePath}/package-lock.json`, import.meta.url), 'utf8'),
        `${fixturePath} package lock`
      );
      const manifestDependencies = requireStringRecord(
        packageManifest.dependencies,
        `${fixturePath} manifest dependencies`
      );
      const lockfilePackages = requireRecord(packageLock.packages, `${fixturePath} lockfile packages`);
      const rootPackage = requireRecord(lockfilePackages[''], `${fixturePath} lockfile root package`);
      const lockfileDependencies = requireStringRecord(
        rootPackage.dependencies,
        `${fixturePath} lockfile root dependencies`
      );

      expect(lockfileDependencies).toEqual(manifestDependencies);
    }
  });

  test('uses the default bundle loader for every maintained Vite 6 fixture', () => {
    for (const [, , fixturePath] of maintainedVite6Fixtures) {
      const packageManifest = parseJsonRecord(
        readFileSync(new URL(`../../${fixturePath}/package.json`, import.meta.url), 'utf8'),
        `${fixturePath} package manifest`
      );
      const scripts = requireStringRecord(packageManifest.scripts, `${fixturePath} package scripts`);

      expect(scripts.dev, fixturePath).not.toMatch(/(?:^|\s)--configLoader(?:=|\s+)/u);
    }
  });

  test('selects the focused baseline directly without importing discoverable test files', () => {
    const packageManifest = parseJsonRecord(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
      'workspace package manifest'
    );
    const scripts = requireStringRecord(packageManifest.scripts, 'workspace package scripts');
    const baselineCommand = scripts['test:e2e:vite6-baseline'];

    expect(baselineCommand?.match(/tests\/e2e\/[^\s]+\.spec\.ts/gu)).toEqual(maintainedVite6Specs);
    expect(existsSync(new URL('../e2e/mimic-vite6-baseline.spec.ts', import.meta.url))).toBe(
      false
    );

    const e2eDirectory = new URL('../e2e/', import.meta.url);
    for (const testFile of readdirSync(e2eDirectory).filter((file) => file.endsWith('.spec.ts'))) {
      const source = readFileSync(new URL(testFile, e2eDirectory), 'utf8');
      expect(source, testFile).not.toMatch(/\bimport\s+(?:[^'"]+\s+from\s+)?['"][^'"]+\.spec(?:\.ts)?['"]/u);
    }
  });
});

function parseJsonRecord(source: string, description: string): Readonly<Record<string, unknown>> {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch (error) {
    throw new Error(`${description} must be valid JSON`, { cause: error });
  }
  return requireRecord(value, description);
}

function requireRecord(value: unknown, description: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireStringRecord(value: unknown, description: string): Readonly<Record<string, string>> {
  const record = requireRecord(value, description);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (typeof entry !== 'string') throw new Error(`${description}.${key} must be a string`);
      return [key, entry];
    })
  );
}

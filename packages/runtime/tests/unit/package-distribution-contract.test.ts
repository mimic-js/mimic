import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  PackageDistributionContractError,
  verifyPackageDistribution
} from '../../scripts/check-package-distribution';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('package distribution contract', () => {
  test('keeps the maintained browser witness on the built public package boundary', () => {
    const appSource = readFileSync('../../apps/e2e-demo/src/App.tsx', 'utf8');
    const playwrightConfig = readFileSync('playwright.config.ts', 'utf8');
    const packageManifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      scripts?: Record<string, string>;
    };

    expect(appSource).toContain("from '@mimic-js/mimic'");
    expect(appSource).not.toContain("from './runtime'");
    expect(playwrightConfig).toContain(
      "command: 'pnpm build:package && pnpm exec vite"
    );
    expect(packageManifest.scripts).not.toHaveProperty('architecture:check');
  });

  test('accepts one publishable Mimic facade with built, packed entries', () => {
    const root = createPackageFixture();

    expect(() => verifyPackageDistribution(root)).not.toThrow();
  });

  test('rejects a private or unnamed manifest', () => {
    const root = createPackageFixture({ private: true, name: '' });

    expectContractFailure(root, 'package.json must declare a non-empty package name');
    expectContractFailure(root, 'package.json must not set private to true');
  });

  test('requires matching top-level types and all public conditions', () => {
    const root = createPackageFixture({
      types: './dist/other.d.ts',
      exports: { '.': { types: './dist/index.d.ts', browser: './dist/index.js' } }
    });

    expectContractFailure(root, 'package.json exports["."].default must be a relative package target');
    expectContractFailure(root, 'package.json types must match package.json exports["."].types');
  });

  test('requires every public entry to exist and be declared for packing', () => {
    const root = createPackageFixture({ files: ['README.md'] });

    expectContractFailure(root, 'package.json files does not include the types entry: ./dist/index.d.ts');
    expectContractFailure(root, 'package.json files does not include the browser entry: ./dist/index.js');
    expectContractFailure(root, 'package.json files does not include the default entry: ./dist/index.js');
  });

  test('rejects public deep-module, plugin, and composition subpath exports', () => {
    const root = createPackageFixture({
      exports: {
        '.': { types: './dist/index.d.ts', browser: './dist/index.js', default: './dist/index.js' },
        './plugins': './dist/plugins.js',
        './composition/internal': './dist/composition.js'
      }
    });

    expectContractFailure(
      root,
      'package.json must not expose deep-module, plugin, or composition subpaths: ./plugins, ./composition/internal'
    );
  });

  test('accepts the bundler integration subpath when it is built and packed', () => {
    const exports = {
      '.': { types: './dist/index.d.ts', browser: './dist/index.js', default: './dist/index.js' },
      './vite': { types: './dist/vite/index.d.ts', default: './dist/vite/index.js' }
    };
    const root = createPackageFixture({ exports, peerDependencies: { vite: '>=5' } });
    mkdirSync(join(root, 'dist/vite'));
    writeFileSync(join(root, 'dist/vite/index.js'), 'export function mimic() {}\n');
    writeFileSync(
      join(root, 'dist/vite/index.d.ts'),
      "import type { Plugin } from 'vite';\nexport declare function mimic(): Plugin;\n"
    );

    expect(() => verifyPackageDistribution(root)).not.toThrow();

    rmSync(join(root, 'dist/vite/index.js'));
    expectContractFailure(root, 'built ./vite default entry does not exist: ./dist/vite/index.js');

    const unpacked = createPackageFixture({ exports, files: ['dist/index.js', 'dist/index.d.ts', 'dist/assets'] });
    expectContractFailure(
      unpacked,
      'package.json files does not include the ./vite types entry: ./dist/vite/index.d.ts'
    );
  });

  test('rejects a packed import of a package that is not a declared dependency', () => {
    const root = createPackageFixture();
    writeFileSync(
      join(root, 'dist/assets/runtime-worker.js'),
      [
        "import { transform } from '@babel/standalone';",
        "import './sibling.js';",
        "import 'node:fs';",
        "const lazy = () => import('fflate/browser');",
        'const text = "import ignored from \'not-an-import\'";'
      ].join('\n')
    );

    expectContractFailure(
      root,
      'packed file imports a package that is not a declared dependency: @babel/standalone in ./dist/assets/runtime-worker.js'
    );
    expectContractFailure(
      root,
      'packed file imports a package that is not a declared dependency: fflate in ./dist/assets/runtime-worker.js'
    );
    try {
      verifyPackageDistribution(root);
    } catch (error) {
      expect((error as PackageDistributionContractError).issues).toHaveLength(2);
    }
  });

  test('rejects a declared dependency that no packed file imports', () => {
    const root = createPackageFixture({
      dependencies: { react: '^18.3.1', fflate: '0.8.2' },
      devDependencies: { vite: '^6.0.7' }
    });
    writeFileSync(
      join(root, 'dist/assets/runtime-worker.js'),
      "import { unzipSync } from 'fflate';\nself.postMessage(typeof unzipSync);\n"
    );

    expectContractFailure(
      root,
      'package.json dependencies declares a package no packed file imports: react'
    );
    try {
      verifyPackageDistribution(root);
    } catch (error) {
      expect((error as PackageDistributionContractError).issues).toHaveLength(1);
    }
  });

  test('keeps the published manifest free of demo and build tooling', () => {
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as {
      dependencies?: Record<string, string>;
    };

    expect(Object.keys(manifest.dependencies ?? {})).toEqual([]);
  });

  test('rejects a missing built entry even when the metadata names it', () => {
    const root = createPackageFixture({
      exports: { '.': { types: './dist/index.d.ts', browser: './dist/missing.js', default: './dist/index.js' } }
    });

    expectContractFailure(root, 'built browser entry does not exist: ./dist/missing.js');
  });

  test('rejects a missing version-matched asset referenced by the browser entry', () => {
    const root = createPackageFixture();
    rmSync(join(root, 'dist/assets/runtime-worker.js'));

    expectContractFailure(
      root,
      'built browser entry references a missing package asset: ./dist/assets/runtime-worker.js'
    );
  });

  test('requires every version-matched asset reference to be packed', () => {
    const root = createPackageFixture({
      files: ['dist/index.js', 'dist/index.d.ts']
    });

    expectContractFailure(
      root,
      'package.json files does not include the referenced package asset: ./dist/assets/runtime-worker.js'
    );
  });
});

function createPackageFixture(overrides: Record<string, unknown> = {}): string {
  const root = mkdtempSync(join(tmpdir(), 'package-distribution-contract-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'dist/assets'), { recursive: true });
  writeFileSync(
    join(root, 'dist/index.js'),
    'new URL("assets/runtime-worker.js", import.meta.url);\nexport class Mimic {}\n'
  );
  writeFileSync(join(root, 'dist/index.d.ts'), 'export declare class Mimic {}\n');
  writeFileSync(join(root, 'dist/assets/runtime-worker.js'), 'self.postMessage("ready");\n');
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({
      name: '@mimic/runtime',
      version: '1.0.0',
      type: 'module',
      files: ['dist'],
      types: './dist/index.d.ts',
      exports: {
        '.': {
          types: './dist/index.d.ts',
          browser: './dist/index.js',
          default: './dist/index.js'
        }
      },
      ...overrides
    })
  );
  return root;
}

function expectContractFailure(root: string, expectedIssue: string): void {
  try {
    verifyPackageDistribution(root);
    throw new Error('Expected the package distribution contract to fail.');
  } catch (error) {
    expect(error).toBeInstanceOf(PackageDistributionContractError);
    expect((error as PackageDistributionContractError).issues).toContain(expectedIssue);
  }
}

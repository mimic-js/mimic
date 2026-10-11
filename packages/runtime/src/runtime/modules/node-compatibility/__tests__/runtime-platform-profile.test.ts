import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

import semver from 'semver';
import { describe, expect, test } from 'vitest';

import { VIRTUAL_PLATFORM, type VirtualPlatform } from '../runtime-platform-profile';

type NodeEngineDeclaration = Readonly<{
  packageName: string;
  range: string;
  source: string;
}>;

const { satisfies: satisfiesNodeEngine } = semver as Readonly<{
  satisfies(version: string, range: string): boolean;
}>;

describe('Runtime Platform Profile', () => {
  test('publishes compatibility platform identity through the declared owner entry point', () => {
    const platform: VirtualPlatform = VIRTUAL_PLATFORM;

    expect(platform).toEqual({
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3',
      runtimeVersion: '0.1.0'
    });
  });

  test.each([
    ['^22.20', true],
    ['^20.19.0 || ^22.13.0 || >=24', true],
    ['18 || 20 || >=22', true],
    ['>=23', false],
    ['^20.19', false]
  ])('evaluates Node 22.22.3 against %s', (range, compatible) => {
    expect(satisfiesNodeEngine(VIRTUAL_PLATFORM.nodeVersion, range)).toBe(compatible);
  });

  test('reports no incompatible Node engine declaration in maintained package graphs', () => {
    const declarations = maintainedGraphNodeEngines('compatibility/fixtures');
    const incompatible = declarations.flatMap((declaration) => {
      try {
        return satisfiesNodeEngine(VIRTUAL_PLATFORM.nodeVersion, declaration.range)
          ? []
          : [declaration];
      } catch (error) {
        return [{ ...declaration, range: `${declaration.range} (${String(error)})` }];
      }
    });

    expect(declarations.length).toBeGreaterThan(0);
    expect(incompatible).toEqual([]);
  });
});

function maintainedGraphNodeEngines(fixturesRoot: string): readonly NodeEngineDeclaration[] {
  const declarations: NodeEngineDeclaration[] = [];
  for (const path of filesUnder(fixturesRoot)) {
    if (path.endsWith('/package-lock.json')) {
      const lockfile = JSON.parse(readFileSync(path, 'utf8')) as {
        readonly packages?: Readonly<Record<string, {
          readonly name?: string;
          readonly engines?: { readonly node?: string };
          readonly os?: readonly string[];
          readonly cpu?: readonly string[];
        }>>;
      };
      for (const [location, entry] of Object.entries(lockfile.packages ?? {})) {
        // A package for another operating system or CPU is never installed here.
        const otherPlatform =
          (entry.os !== undefined && !entry.os.includes(VIRTUAL_PLATFORM.operatingSystem)) ||
          (entry.cpu !== undefined && !entry.cpu.includes(VIRTUAL_PLATFORM.architecture));
        if (entry.engines?.node && !otherPlatform) {
          declarations.push({
            packageName: entry.name ?? (location || '<root>'),
            range: entry.engines.node,
            source: relative('.', path)
          });
        }
      }
      continue;
    }
    if (path.endsWith('/package.json')) {
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
        readonly name?: string;
        readonly engines?: { readonly node?: string };
      };
      if (manifest.engines?.node) {
        declarations.push({
          packageName: manifest.name ?? '<workspace package>',
          range: manifest.engines.node,
          source: relative('.', path)
        });
      }
      continue;
    }
    if (path.endsWith('/pnpm-lock.yaml')) {
      const source = readFileSync(path, 'utf8');
      for (const match of source.matchAll(/engines:\s*\{node:\s*(['"])(.*?)\1\}/gu)) {
        declarations.push({
          packageName: `pnpm lock entry at offset ${match.index}`,
          range: match[2],
          source: relative('.', path)
        });
      }
    }
  }
  return declarations;
}

function filesUnder(root: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

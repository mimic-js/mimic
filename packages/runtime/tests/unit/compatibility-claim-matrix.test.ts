import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import {
  assertAdditiveCompatibilityEvidence,
  createCompatibilityClaimMatrix
} from '../../scripts/compatibility-claim-matrix';

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Compatibility Claim matrix', () => {
  test('assigns every co-located claim spec to exactly one bounded shard', () => {
    const repositoryRoot = new URL('../..', import.meta.url);
    const matrix = createCompatibilityClaimMatrix({ repositoryRoot, shardCount: 12 });
    const expectedSpecFiles = findClaimSpecFiles(repositoryRoot);
    const assignedSpecFiles = matrix.include.flatMap((entry) => entry.specs.split(' ')).sort();

    expect(matrix.include.length).toBeLessThanOrEqual(12);
    expect(assignedSpecFiles).toEqual(expectedSpecFiles);
    expect(new Set(matrix.include.flatMap((entry) => entry.claimIds.split(', '))).size).toBeGreaterThan(0);
    expect(matrix.include.every((entry) => entry.claimIds.length > 0)).toBe(true);
  });

  test('adds a new claim without dropping an existing assignment', () => {
    const repositoryRoot = temporaryRepository();
    writeClaim(repositoryRoot, 'alpha.spec.ts', 'alpha-claim', 'Alpha remains supported');
    const before = createCompatibilityClaimMatrix({ repositoryRoot, shardCount: 2 });

    writeClaim(repositoryRoot, 'beta.spec.ts', 'beta-claim', 'Beta is newly supported', true);
    const after = createCompatibilityClaimMatrix({ repositoryRoot, shardCount: 2 });

    expect(claimIds(before)).toEqual(['alpha-claim']);
    expect(claimIds(after)).toEqual(['alpha-claim', 'beta-claim']);
  });

  test('fails closed on duplicate ids or an unreadable claim declaration', () => {
    const repositoryRoot = temporaryRepository();
    writeClaim(repositoryRoot, 'alpha.spec.ts', 'duplicate', 'Alpha');
    writeClaim(repositoryRoot, 'beta.spec.ts', 'duplicate', 'Beta');

    expect(() => createCompatibilityClaimMatrix({ repositoryRoot, shardCount: 2 })).toThrow(
      'Duplicate Compatibility Claim id duplicate'
    );

    rmSync(new URL('tests/e2e/beta.spec.ts', repositoryRoot));
    writeFileSync(
      new URL('tests/e2e/broken.spec.ts', repositoryRoot),
      "defineCompatibilityClaim({ id: claimId, statement: 'Broken', target: { kind: 'runtime-capability', capability: 'broken' } });\n"
    );
    expect(() => createCompatibilityClaimMatrix({ repositoryRoot, shardCount: 2 })).toThrow(
      'must declare a static string id and statement'
    );
  });

  test('preserves every existing claim, Exact Graph target, and fixture while allowing additions', () => {
    const baselineRoot = temporaryRepository();
    const additiveRoot = temporaryRepository();
    writeExactClaim(baselineRoot, 'alpha.spec.ts', 'alpha-claim', '1.0.0');
    writeExactClaim(additiveRoot, 'alpha.spec.ts', 'alpha-claim', '1.0.0');
    writeExactClaim(additiveRoot, 'beta.spec.ts', 'beta-claim', '2.0.0');
    writeFixture(baselineRoot, 'alpha', 'alpha-lock');
    writeFixture(additiveRoot, 'alpha', 'alpha-lock');
    writeFixture(additiveRoot, 'beta', 'beta-lock');

    expect(() =>
      assertAdditiveCompatibilityEvidence({ baselineRoot, repositoryRoot: additiveRoot })
    ).not.toThrow();

    const refreshedRoot = temporaryRepository();
    writeExactClaim(refreshedRoot, 'alpha.spec.ts', 'alpha-claim', '1.0.1');
    writeFixture(refreshedRoot, 'alpha', 'alpha-lock');
    expect(() =>
      assertAdditiveCompatibilityEvidence({ baselineRoot, repositoryRoot: refreshedRoot })
    ).toThrow('An existing Exact Graph target was removed or refreshed');

    const changedFixtureRoot = temporaryRepository();
    writeExactClaim(changedFixtureRoot, 'alpha.spec.ts', 'alpha-claim', '1.0.0');
    writeFixture(changedFixtureRoot, 'alpha', 'changed-lock');
    expect(() =>
      assertAdditiveCompatibilityEvidence({ baselineRoot, repositoryRoot: changedFixtureRoot })
    ).toThrow('Existing Exact Graph fixture compatibility/fixtures/alpha/package-lock.json was refreshed');
  });
});

function temporaryRepository(): URL {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-matrix-'));
  temporaryRoots.push(root);
  mkdirSync(join(root, 'tests/e2e'), { recursive: true });
  mkdirSync(join(root, 'compatibility/fixtures'), { recursive: true });
  return new URL(`file://${root}/`);
}

function writeExactClaim(root: URL, file: string, id: string, version: string): void {
  writeFileSync(
    new URL(`tests/e2e/${file}`, root),
    `const target = { kind: 'exact-graph', packages: { alpha: '${version}' } };\ndefineCompatibilityClaim({ id: '${id}', statement: '${id} remains supported', target });\n`
  );
}

function writeFixture(root: URL, name: string, contents: string): void {
  mkdirSync(fileURLToPath(new URL(`compatibility/fixtures/${name}/`, root)), { recursive: true });
  writeFileSync(new URL(`compatibility/fixtures/${name}/package-lock.json`, root), contents);
}

function writeClaim(root: URL, file: string, id: string, statement: string, spaced = false): void {
  writeFileSync(
    new URL(`tests/e2e/${file}`, root),
    `defineCompatibilityClaim${spaced ? ' \n ' : ''}({ id: '${id}', statement: '${statement}', target: { kind: 'runtime-capability', capability: '${id}' } });\n`
  );
}

function claimIds(matrix: ReturnType<typeof createCompatibilityClaimMatrix>): string[] {
  return matrix.include.flatMap((entry) => entry.claimIds.split(', ')).sort();
}

function findClaimSpecFiles(repositoryRoot: URL): string[] {
  const directory = new URL('tests/e2e/', repositoryRoot);
  return readdirSync(directory)
    .filter((file) => file.endsWith('.spec.ts'))
    .filter((file) => /\bdefineCompatibilityClaim\s*\(/u.test(readFileSync(new URL(file, directory), 'utf8')))
    .map((file) => `tests/e2e/${file}`)
    .sort();
}

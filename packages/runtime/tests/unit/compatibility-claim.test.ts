import { describe, expect, test } from 'vitest';

import { defineCompatibilityClaim } from '../e2e/compatibility-claim';

const exactGraphTarget = {
  kind: 'exact-graph',
  packages: { webpack: '5.108.4' },
  packageManager: { name: 'npm', version: '11.18.0' },
  lockfile: {
    format: 'npm',
    version: 3,
    path: 'compatibility/fixtures/webpack-5.108.4/package-lock.json'
  },
  virtualPlatform: {
    operatingSystem: 'linux',
    architecture: 'wasm32',
    runtime: 'browser',
    nodeVersion: '22.22.3'
  },
  replacements: {},
  execution: { command: 'node', entrypoint: 'node_modules/webpack/bin/webpack.js' }
} as const;

const exactGraphClaim = {
  id: 'webpack-5-108-4',
  statement: 'Webpack 5.108.4 builds through Mimic from its tracked lockfile',
  target: exactGraphTarget
} as const;

const yarnExactGraphTarget = {
  ...exactGraphTarget,
  packageManager: { name: 'yarn', version: '4.17.1' },
  lockfile: {
    format: 'yarn',
    version: 10,
    path: 'compatibility/fixtures/yarn-node-modules-4.17.1/yarn.lock'
  }
} as const;

const pnpmExactGraphTarget = {
  ...exactGraphTarget,
  packageManager: { name: 'pnpm', version: '11.11.0' },
  lockfile: {
    format: 'pnpm',
    version: 9,
    path: 'compatibility/fixtures/pnpm-exact-workspace/pnpm-lock.yaml'
  }
} as const;

describe('defineCompatibilityClaim', () => {
  test('preserves an exact graph claim whose tracked lockfile is the graph authority', () => {
    expect(defineCompatibilityClaim(exactGraphClaim)).toBe(exactGraphClaim);
  });

  test.each([
    ['claim projection', { ...exactGraphClaim, projection: { kind: 'rendered' } }],
    [
      'exact graph outcome',
      { ...exactGraphClaim, target: { ...exactGraphTarget, expectedOutcome: 'module-error' } }
    ],
    [
      'runtime capability outcome',
      {
        id: 'loopback-http',
        statement: 'Loopback HTTP requests complete through Mimic',
        target: { kind: 'runtime-capability', capability: 'loopback-http', expectedOutcome: 'module-error' }
      }
    ]
  ])('rejects a retired %s field', (_description, claim) => {
    expect(() => defineCompatibilityClaim(claim)).toThrow('Invalid compatibility claim');
  });

  test('preserves a Yarn 4.17.1 node-modules exact graph claim', () => {
    const claim = {
      ...exactGraphClaim,
      id: 'yarn-node-modules-4-17-1',
      target: yarnExactGraphTarget
    } as const;

    expect(defineCompatibilityClaim(claim)).toBe(claim);
  });

  test('preserves a pnpm 11.11.0 exact graph claim', () => {
    const claim = {
      ...exactGraphClaim,
      id: 'pnpm-11-11-0-exact-workspace',
      target: pnpmExactGraphTarget
    } as const;

    expect(defineCompatibilityClaim(claim)).toBe(claim);
  });

  test('names each Browser Package Replacement by the exact package installed in its place', () => {
    const claim = {
      ...exactGraphClaim,
      target: { ...exactGraphTarget, replacements: { rollup: '@rollup/wasm-node@4.62.3' } }
    } as const;

    expect(defineCompatibilityClaim(claim)).toBe(claim);
    for (const replacement of ['@rollup/wasm-node', '@rollup/wasm-node@^4', '']) {
      expect(() => defineCompatibilityClaim({
        ...exactGraphClaim,
        target: { ...exactGraphTarget, replacements: { rollup: replacement } }
      })).toThrow('Invalid compatibility claim');
    }
  });

  test('rejects the retired Built-in-npm identity', () => {
    const claim = {
      ...exactGraphClaim,
      target: {
        ...exactGraphTarget,
        packageManager: { name: 'npm', version: 'mimic-npm-v1' }
      }
    } as const;

    expect(() => defineCompatibilityClaim(claim)).toThrow('Invalid compatibility claim');
  });

  test('accepts runtime capability targets without introducing a claim registry', () => {
    const claim = defineCompatibilityClaim({
      id: 'loopback-http',
      statement: 'Loopback HTTP requests complete through Mimic',
      target: {
        kind: 'runtime-capability',
        capability: 'loopback-http'
      }
    });

    expect(claim.target).toEqual({ kind: 'runtime-capability', capability: 'loopback-http' });
  });

  test.each([
    ['empty stable identity', { ...exactGraphClaim, id: '' }],
    ['empty statement', { ...exactGraphClaim, statement: '' }],
    [
      'unsupported package-manager identity',
      {
        ...exactGraphClaim,
        target: {
          ...exactGraphTarget,
          packageManager: { ...exactGraphTarget.packageManager, version: 'unversioned' }
        }
      }
    ],
    [
      'unsupported virtual platform',
      {
        ...exactGraphClaim,
        target: {
          ...exactGraphTarget,
          virtualPlatform: { ...exactGraphTarget.virtualPlatform, architecture: 'x64' }
        }
      }
    ]
  ])('fails closed for a %s', (_description, claim) => {
    expect(() => defineCompatibilityClaim(claim)).toThrow('Invalid compatibility claim');
  });

  test.each([
    [
      'missing Node identity',
      {
        operatingSystem: 'linux',
        architecture: 'wasm32',
        runtime: 'browser'
      }
    ],
    [
      'non-current Node profile identity',
      { ...exactGraphTarget.virtualPlatform, nodeVersion: '22.13.0' }
    ]
  ])('rejects an exact graph target with %s', (_description, virtualPlatform) => {
    const target = { ...exactGraphTarget, virtualPlatform };

    expect(() => defineCompatibilityClaim({ ...exactGraphClaim, target })).toThrow('Invalid compatibility claim');
  });

  test.each([
    '',
    '/tmp/package-lock.json',
    'compatibility/fixtures/../package-lock.json',
    'compatibility/fixtures/webpack-5.108.4/lock.json'
  ])('rejects untracked lockfile path %j', (path) => {
    const claim = {
      ...exactGraphClaim,
      target: {
        ...exactGraphTarget,
        lockfile: { ...exactGraphTarget.lockfile, path }
      }
    };

    expect(() => defineCompatibilityClaim(claim)).toThrow('Invalid compatibility claim');
  });

  test.each([
    [
      'npm manager with a Yarn lockfile',
      { ...exactGraphTarget, lockfile: yarnExactGraphTarget.lockfile }
    ],
    [
      'Yarn manager with an npm lockfile',
      { ...yarnExactGraphTarget, lockfile: exactGraphTarget.lockfile }
    ],
    [
      'pnpm manager with an npm lockfile',
      { ...pnpmExactGraphTarget, lockfile: exactGraphTarget.lockfile }
    ],
    [
      'npm manager with a pnpm lockfile',
      { ...exactGraphTarget, lockfile: pnpmExactGraphTarget.lockfile }
    ],
    [
      'Yarn 4.17.1 with unsupported lockfile metadata',
      {
        ...yarnExactGraphTarget,
        lockfile: { ...yarnExactGraphTarget.lockfile, version: 9 }
      }
    ],
    [
      'Yarn 4.17.1 with a package-lock path',
      {
        ...yarnExactGraphTarget,
        lockfile: {
          ...yarnExactGraphTarget.lockfile,
          path: 'compatibility/fixtures/yarn-node-modules-4.17.1/package-lock.json'
        }
      }
    ],
    [
      'pnpm 11.11.0 with unsupported lockfile metadata',
      {
        ...pnpmExactGraphTarget,
        lockfile: { ...pnpmExactGraphTarget.lockfile, version: 8 }
      }
    ],
    [
      'pnpm 11.11.0 with a package-lock path',
      {
        ...pnpmExactGraphTarget,
        lockfile: {
          ...pnpmExactGraphTarget.lockfile,
          path: 'compatibility/fixtures/pnpm-exact-workspace/package-lock.json'
        }
      }
    ]
  ])('rejects an exact graph target with %s', (_description, target) => {
    expect(() => defineCompatibilityClaim({ ...exactGraphClaim, target })).toThrow('Invalid compatibility claim');
  });

  test('rejects legacy graph summaries beside the tracked lockfile', () => {
    const claim = {
      ...exactGraphClaim,
      target: {
        ...exactGraphTarget,
        lockfile: {
          ...exactGraphTarget.lockfile,
          graphDigest: 'bb47fe6c704990396a6c520d6bab488f83985aad8863c728ea08a6b5dedbd640',
          packageCount: 596
        }
      }
    };

    expect(() => defineCompatibilityClaim(claim)).toThrow('Invalid compatibility claim');
  });
});

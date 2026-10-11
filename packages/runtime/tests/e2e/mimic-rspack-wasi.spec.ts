import { readFileSync } from 'node:fs';

import { expect, test } from './compatibility-test';
import { defineCompatibilityClaim } from './compatibility-claim';
import {
  PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY,
  runTrackedPublisherArtifactFixture,
  type PublisherProbe
} from './publisher-artifact-harness';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const rspackWasiPackageJson = readFileSync(
  new URL('../../compatibility/fixtures/rspack-wasi-2.1.3/package.json', import.meta.url),
  'utf8'
);
const rspackWasiPackageLock = readFileSync(
  new URL('../../compatibility/fixtures/rspack-wasi-2.1.3/package-lock.json', import.meta.url),
  'utf8'
);
const rspackWasiInstallFixture = prepareTrackedLockfileInstall({
  packageJson: rspackWasiPackageJson,
  lockfile: rspackWasiPackageLock,
  install: { command: 'npm', args: ['ci'] }
});

const rspackWasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'rspack-wasi-2-1-3',
  statement: 'Rspack WASI 2.1.3 installs and executes its exact publisher graph through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { '@rspack/binding-wasm32-wasi': '2.1.3', vite: '6.4.3' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/rspack-wasi-2.1.3/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const rspackWasiPublisherFixture = {
  id: 'rspack-wasi-2.1.3',
  artifacts: [
    {
      path: 'node_modules/@rspack/binding-wasm32-wasi/rspack.wasm32-wasi.wasm',
      role: 'wasm',
      sha256: 'cd9a926ef89bce47f9f30cd1aaa4f02cca6dced00d4fbc3aa4278e2347b3a005'
    },
    {
      path: 'node_modules/@rspack/binding-wasm32-wasi/wasi-worker-browser.mjs',
      role: 'worker',
      sha256: '2b20f14f81a5797bf4e150faec8197ab41d5852529729b0b801855d437f81be9'
    }
  ],
  forbiddenFallbacks: ['registered-command-adapter', 'cdn-dependency-rewrite', 'host-node-execution'],
  lifecycle: { execute: ['npm', 'run', 'dev'] }
} as const;

type RspackWasiProbe = PublisherProbe &
  Readonly<{
    outputs?: readonly number[];
    expectedError?: string;
    error?: string;
  }>;

test(rspackWasiCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(600_000);
  const result = await runTrackedPublisherArtifactFixture<RspackWasiProbe>(
    page,
    rspackWasiPublisherFixture,
    rspackWasiInstallFixture,
    rspackWasiWorkloadSource(),
    '__rspackWasiProbe',
    'Rspack WASI publisher probe',
    process.env.GITHUB_SHA ?? 'local',
    Object.keys(rspackWasiCompatibilityClaim.target.replacements)
  );

  expect(result.install.exitCode, result.install.output).toBe(0);
  expect(result.lockfile).toEqual({ mountedBeforeInstall: true, unchangedAfterInstall: true });
  expect(result.identity.evidence).toEqual({ runner: 'playwright', publicMimicApi: true });
  expect(result.security.contentSecurityPolicy).toBe(PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY);
  expect(result.identity.replacements).toEqual(rspackWasiCompatibilityClaim.target.replacements);
  expect(result.installation.materializedPackages).toEqual(
    expect.arrayContaining(['@rspack/binding-wasm32-wasi@2.1.3', 'vite@6.4.3'])
  );
  expect(result.probe).toMatchObject({
    outcome: 'success',
    outputs: [42, 7],
    expectedError: expect.stringContaining('key must be a string')
  });
  expect(result.diagnostics.workerUrls.length).toBeGreaterThan(0);
  await expect.poll(() => result.diagnostics.closedWorkerUrls, { timeout: 10_000 }).toHaveLength(
    result.diagnostics.workerUrls.length
  );

  const publisherArtifacts = result.artifacts.map((artifact) => ({
    ...artifact,
    servedFromVfs:
      artifact.servedFromVfs ||
      (artifact.role === 'worker' &&
        result.diagnostics.workerUrls.some((url) => url.includes(`/${artifact.path}`)))
  }));
  expect(publisherArtifacts).toEqual([
    {
      path: rspackWasiPublisherFixture.artifacts[0].path,
      role: 'wasm',
      expectedSha256: rspackWasiPublisherFixture.artifacts[0].sha256,
      actualSha256: rspackWasiPublisherFixture.artifacts[0].sha256,
      servedSha256: rspackWasiPublisherFixture.artifacts[0].sha256,
      servedFromVfs: true
    },
    {
      path: rspackWasiPublisherFixture.artifacts[1].path,
      role: 'worker',
      expectedSha256: rspackWasiPublisherFixture.artifacts[1].sha256,
      actualSha256: rspackWasiPublisherFixture.artifacts[1].sha256,
      servedSha256: rspackWasiPublisherFixture.artifacts[1].sha256,
      servedFromVfs: true
    }
  ]);
  expect(result.fallbackScan.observed).toEqual([]);
  expect(result.teardown).toEqual({ completed: true });
  expect(result.reboot).toEqual({ completed: true });
  expect(result.diagnostics.artifactResponses).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^200 application\/wasm .*rspack\.wasm32-wasi\.wasm$/),
      expect.stringMatching(/^200 (?:text|application)\/javascript .*wasi-worker-browser\.mjs$/)
    ])
  );
  expect(result.runtimeErrors).toEqual([]);
  expect(result.diagnostics.pageErrors).toEqual([]);
  expect(result.diagnostics.failedRequests).toEqual([]);
});

function rspackWasiWorkloadSource(): string {
  return String.raw`
const result = document.querySelector('#result');
try {
  const { transform } = await withDeadline(import('@rspack/binding-wasm32-wasi'), 120_000, 'Rspack WASI import');
  const sources = [
    'function answer() { return 40 + 2; }',
    'function second() { return 3 + 4; }'
  ];
  const transformed = await Promise.all(sources.map((source) => transform(source, '{}')));
  const outputs = transformed.map((output, index) => {
    const name = index === 0 ? 'answer' : 'second';
    return Function(output.code + '\nreturn ' + name + '();')();
  });
  let expectedError = 'NO ERROR';
  try {
    await transform('function broken() {}', '{not-json');
  } catch (error) {
    expectedError = error instanceof Error ? error.name + ': ' + error.message : String(error);
  }
  globalThis.__rspackWasiProbe = { outcome: 'success', outputs, expectedError };
} catch (error) {
  globalThis.__rspackWasiProbe = { outcome: 'failure', error: error instanceof Error ? error.stack || error.message : String(error) };
}
result.textContent = JSON.stringify(globalThis.__rspackWasiProbe);

function withDeadline(promise, timeout, label) {
  let deadline;
  return Promise.race([
    promise,
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(label + ' timed out')), timeout); })
  ]).finally(() => clearTimeout(deadline));
}
`;
}

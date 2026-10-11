import { readFileSync } from 'node:fs';

import { expect, test } from './compatibility-test';
import { defineCompatibilityClaim } from './compatibility-claim';
import {
  PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY,
  runTrackedPublisherArtifactFixture,
  type PublisherProbe
} from './publisher-artifact-harness';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const rolldownPackageJson = readFileSync(
  new URL('../../compatibility/fixtures/rolldown-browser-1.1.5/package.json', import.meta.url),
  'utf8'
);
const rolldownPackageLock = readFileSync(
  new URL('../../compatibility/fixtures/rolldown-browser-1.1.5/package-lock.json', import.meta.url),
  'utf8'
);
const rolldownInstallFixture = prepareTrackedLockfileInstall({
  packageJson: rolldownPackageJson,
  lockfile: rolldownPackageLock,
  install: { command: 'npm', args: ['ci'] }
});

const rolldownCompatibilityClaim = defineCompatibilityClaim({
  id: 'rolldown-browser-1-1-5',
  statement: 'Rolldown Browser 1.1.5 installs and executes its exact NAPI-RS/emnapi publisher graph through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { '@rolldown/browser': '1.1.5', vite: '6.4.3' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/rolldown-browser-1.1.5/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const rolldownPublisherFixture = {
  id: 'rolldown-browser-1.1.5',
  artifacts: [
    {
      path: 'node_modules/@rolldown/browser/dist/rolldown-binding.wasm32-wasi.wasm',
      role: 'wasm',
      sha256: '76380fa3f831b46548fb332f961c5b0d21a57c2ad51495ad9c0da123ffac48ce'
    },
    {
      path: 'node_modules/@rolldown/browser/dist/wasi-worker-browser.mjs',
      role: 'worker',
      sha256: '9ab6d5481fff22d102d014a13eab3ad2411aeba7fde21682ec136bf4f305fdca'
    }
  ],
  forbiddenFallbacks: ['registered-command-adapter', 'cdn-dependency-rewrite', 'host-node-execution'],
  lifecycle: { execute: ['npm', 'run', 'dev'] }
} as const;

type RolldownProbe = PublisherProbe &
  Readonly<{
    outputs?: readonly string[];
    expectedError?: string;
    closedBundles?: number;
    error?: string;
  }>;

test(rolldownCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(600_000);
  const result = await runTrackedPublisherArtifactFixture<RolldownProbe>(
    page,
    rolldownPublisherFixture,
    rolldownInstallFixture,
    rolldownWorkloadSource(),
    '__rolldownBrowserProbe',
    'Rolldown publisher probe',
    process.env.GITHUB_SHA ?? 'local',
    Object.keys(rolldownCompatibilityClaim.target.replacements)
  );

  expect(result.install.exitCode, result.install.output).toBe(0);
  expect(result.lockfile).toEqual({ mountedBeforeInstall: true, unchangedAfterInstall: true });
  expect(result.identity.evidence).toEqual({ runner: 'playwright', publicMimicApi: true });
  expect(result.security.contentSecurityPolicy).toBe(PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY);
  expect(result.identity.replacements).toEqual(rolldownCompatibilityClaim.target.replacements);
  expect(result.installation.materializedPackages).toEqual(
    expect.arrayContaining(['@rolldown/browser@1.1.5', 'vite@6.4.3'])
  );
  expect(result.probe, JSON.stringify(result.probe)).toMatchObject({
    outcome: 'success',
    outputs: [expect.stringContaining('answer = 42'), expect.stringContaining('second = 7')],
    expectedError: expect.stringContaining('expected publisher error'),
    closedBundles: 3
  });
  // The exact publisher configures a four-worker async work pool independently of its three bundle lifecycles.
  expect(result.diagnostics.workerUrls).toHaveLength(4);
  await expect.poll(() => result.diagnostics.closedWorkerUrls, { timeout: 10_000 }).toHaveLength(4);

  const [wasmArtifact, workerArtifact] = result.artifacts;
  expect(wasmArtifact).toEqual({
    path: rolldownPublisherFixture.artifacts[0].path,
    role: 'wasm',
    expectedSha256: rolldownPublisherFixture.artifacts[0].sha256,
    actualSha256: rolldownPublisherFixture.artifacts[0].sha256,
    servedSha256: rolldownPublisherFixture.artifacts[0].sha256,
    servedFromVfs: true
  });
  expect(workerArtifact).toMatchObject({
    path: rolldownPublisherFixture.artifacts[1].path,
    role: 'worker',
    expectedSha256: rolldownPublisherFixture.artifacts[1].sha256,
    actualSha256: rolldownPublisherFixture.artifacts[1].sha256,
    servedSha256: rolldownPublisherFixture.artifacts[1].sha256
  });
  expect(
    workerArtifact.servedFromVfs ||
      result.diagnostics.workerUrls.some((url) => url.includes(`/${rolldownPublisherFixture.artifacts[1].path}`))
  ).toBe(true);
  expect(result.fallbackScan.observed).toEqual([]);
  expect(
    result.teardown.completed &&
      result.diagnostics.closedWorkerUrls.some((url) => url.includes(`/${rolldownPublisherFixture.artifacts[1].path}`))
  ).toBe(true);
  expect(result.reboot).toEqual({ completed: true });
  expect(result.diagnostics.artifactResponses).toEqual(
    expect.arrayContaining([
      expect.stringMatching(/^200 application\/wasm .*rolldown-binding\.wasm32-wasi\.wasm$/),
      expect.stringMatching(/^200 (?:text|application)\/javascript .*wasi-worker-browser\.mjs$/)
    ])
  );
  expect(result.runtimeErrors).toEqual([]);
  expect(result.diagnostics.pageErrors).toEqual([]);
  expect(result.diagnostics.failedRequests).toEqual([]);
});

function rolldownWorkloadSource(): string {
  return String.raw`
const result = document.querySelector('#result');
let closedBundles = 0;
try {
  const { rolldown } = await withDeadline(import('@rolldown/browser'), 30_000, 'Rolldown import');
  const createBundle = (name, value) => rolldown({ cwd: '/', input: name + '.js', plugins: [{
      name: 'virtual-' + name,
      resolveId(id) { return id === name + '.js' ? id : null; },
      load(id) { return id === name + '.js' ? 'export const ' + name + ' = ' + value : null; }
    }] });
  const generateBundle = async (instance) => {
    try {
      const generated = await instance.generate({ format: 'esm' });
      return generated.output[0].code.trim();
    } finally {
      await instance.close();
      closedBundles += 1;
    }
  };
  const bundles = await Promise.all([createBundle('answer', 42), createBundle('second', 7)]);
  // The publisher shares initialization across this pair; bound generation and closure instead of running both builds at once.
  const outputs = [];
  for (const bundle of bundles) outputs.push(await generateBundle(bundle));
  let expectedError = 'NO ERROR';
  let brokenBundle;
  try {
    brokenBundle = await rolldown({ cwd: '/', input: 'broken.js', plugins: [{
      name: 'expected-error',
      resolveId(id) { return id === 'broken.js' ? id : null; },
      load() { throw new Error('expected publisher error'); }
    }] });
    await brokenBundle.generate({ format: 'esm' });
  } catch (error) {
    expectedError = error instanceof Error ? error.name + ': ' + error.message : String(error);
  } finally {
    if (brokenBundle) {
      await brokenBundle.close();
      closedBundles += 1;
    }
  }
  globalThis.__rolldownBrowserProbe = { outcome: 'success', outputs, expectedError, closedBundles };
} catch (error) {
  globalThis.__rolldownBrowserProbe = { outcome: 'failure', error: error instanceof Error ? error.stack || error.message : String(error), closedBundles };
}
result.textContent = JSON.stringify(globalThis.__rolldownBrowserProbe);

function withDeadline(promise, timeout, label) {
  let deadline;
  return Promise.race([
    promise,
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(label + ' timed out')), timeout); })
  ]).finally(() => clearTimeout(deadline));
}
`;
}

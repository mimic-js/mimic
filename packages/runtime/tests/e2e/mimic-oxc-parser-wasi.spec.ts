import { readFileSync } from 'node:fs';

import { expect, test } from './compatibility-test';
import { defineCompatibilityClaim } from './compatibility-claim';
import {
  PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY,
  runTrackedPublisherArtifactFixture,
  type PublisherProbe
} from './publisher-artifact-harness';
import { prepareTrackedLockfileInstall } from './tracked-lockfile-install';

const oxcParser0139WasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'oxc-parser-wasi-0-139-0',
  statement: 'Oxc parser 0.139.0 installs and executes its exact WASI publisher graph through Mimic',
  target: {
    kind: 'exact-graph',
    packages: { 'oxc-parser': '0.139.0', vite: '6.4.3' },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/oxc-parser-wasi-0.139.0/package-lock.json'
    },
    virtualPlatform: { operatingSystem: 'linux', architecture: 'wasm32', runtime: 'browser', nodeVersion: '22.22.3' },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.3'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const oxcParser0142WasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'oxc-parser-wasi-0-142-0',
  statement: 'Oxc parser 0.142.0 installs and executes its exact WASI publisher graph through Mimic',
  target: {
    kind: 'exact-graph',
    packages: {
      'oxc-parser': '0.142.0',
      '@oxc-parser/binding-wasm32-wasi': '0.142.0',
      vite: '6.4.3'
    },
    packageManager: { name: 'npm', version: '11.18.0' },
    lockfile: {
      format: 'npm',
      version: 3,
      path: 'compatibility/fixtures/oxc-parser-wasi-0.142.0/package-lock.json'
    },
    virtualPlatform: {
      operatingSystem: 'linux',
      architecture: 'wasm32',
      runtime: 'browser',
      nodeVersion: '22.22.3'
    },
    replacements: {
      rollup: '@rollup/wasm-node@4.62.4'
    },
    execution: { command: 'npm', entrypoint: 'run dev' }
  }
});

const oxcParserLines = [
  {
    claim: oxcParser0139WasiCompatibilityClaim,
    version: '0.139.0',
    lockfileSha256: '165e1f53767451d872e7f3dbcef13af1b517c9286c7a23e93f4edb670084dee0',
    bindingIntegrity: 'sha512-rNU0pO+/CVPC2qZ+xtX5R2cOje9Q75q3UkfgwUCPlplqxMv6Iffd5tMPGVMCLGnPINxPlmi0WPsW94HltbYvfQ==',
    wasmSha256: 'f4b28c767cf4985a8bfcdf1c9eb1b26b627e53e91cfd5ee967a11861bd32a0d7',
    workerSha256: '9e8064c5af1619769984b28fe66e5400cdf8b46ab4678f45cdb4f1b5a2441f47'
  },
  {
    claim: oxcParser0142WasiCompatibilityClaim,
    version: '0.142.0',
    lockfileSha256: '4ad6617e232b6a47069b30462695d4299e36c6bf1070d71d5976bf9877c047e0',
    bindingIntegrity: 'sha512-3pLDyY3+oogW73RM5uehNgAiR/Xfb7fvO2Q1Z1gIqZ2+50XDVQmBVlRkHXZTU4gKnQHpwETNsYQVsJ3joVB2iA==',
    wasmSha256: '281863fe8b3f9dc2c67de5f4dd48045371bbad3faa7bd47ee10becfc348a0942',
    workerSha256: '9e8064c5af1619769984b28fe66e5400cdf8b46ab4678f45cdb4f1b5a2441f47'
  }
] as const;

type OxcParserWasiProbe = PublisherProbe &
  Readonly<{
    bodyLengths?: readonly number[];
    errorCount?: number;
    malformedDiagnostic?: Readonly<{
      codeframe?: string;
      end?: number;
      message?: string;
      severity?: string;
      start?: number;
    }>;
    terminatedWorkers?: number;
    error?: string;
  }>;

for (const line of oxcParserLines) registerOxcParserClaim(line);

function registerOxcParserClaim(line: (typeof oxcParserLines)[number]): void {
  const fixtureRoot = new URL(`../../compatibility/fixtures/oxc-parser-wasi-${line.version}/`, import.meta.url);
  const packageJson = readFileSync(new URL('package.json', fixtureRoot), 'utf8');
  const packageLock = readFileSync(new URL('package-lock.json', fixtureRoot), 'utf8');
  const installFixture = prepareTrackedLockfileInstall({
    packageJson,
    lockfile: packageLock,
    install: { command: 'npm', args: ['ci'] }
  });
  const publisherFixture = {
    id: `oxc-parser-wasi-${line.version}`,
    artifacts: [
      {
        path: 'node_modules/@oxc-parser/binding-wasm32-wasi/parser.wasm32-wasi.wasm',
        role: 'wasm',
        sha256: line.wasmSha256
      },
      {
        path: 'node_modules/@oxc-parser/binding-wasm32-wasi/wasi-worker-browser.mjs',
        role: 'worker',
        sha256: line.workerSha256
      }
    ],
    packageEvidence: [
      {
        path: 'node_modules/@oxc-parser/binding-wasm32-wasi',
        materializedScope: 'node_modules/@oxc-parser'
      }
    ],
    forbiddenFallbacks: ['registered-command-adapter', 'cdn-dependency-rewrite', 'host-node-execution'],
    lifecycle: { execute: ['npm', 'run', 'dev'] }
  } as const;

  test(line.claim.statement, async ({ page }) => {
    test.setTimeout(600_000);
    const result = await runTrackedPublisherArtifactFixture<OxcParserWasiProbe>(
      page,
      publisherFixture,
      installFixture,
      oxcParserWasiWorkloadSource(),
      '__oxcParserWasiProbe',
      'Oxc parser WASI publisher probe',
      process.env.GITHUB_SHA ?? 'local',
      Object.keys(line.claim.target.replacements)
    );

    expect(result.install.exitCode, result.install.output).toBe(0);
    expect(result.lockfile).toEqual({
      mountedBeforeInstall: true,
      unchangedAfterInstall: true
    });
    expect(result.identity.evidence).toEqual({
      runner: 'playwright',
      publicMimicApi: true
    });
    expect(result.security.contentSecurityPolicy).toBe(PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY);
    expect(result.identity.replacements).toEqual(line.claim.target.replacements);
    expect(result.identity.lockfile).toEqual({
      byteLength: new TextEncoder().encode(packageLock).byteLength,
      digest: `sha256:${line.lockfileSha256}`
    });
    expect(result.installation.materializedPackages).toEqual(
      expect.arrayContaining([
        `oxc-parser@${line.version}`,
        `@oxc-parser/binding-wasm32-wasi@${line.version}`,
        'vite@6.4.3'
      ])
    );
    expect(result.installation.packageEvidence).toEqual([
      {
        path: 'node_modules/@oxc-parser/binding-wasm32-wasi',
        identity: {
          name: '@oxc-parser/binding-wasm32-wasi',
          version: line.version
        },
        lockfileIntegrity: line.bindingIntegrity,
        materializedScope: {
          path: 'node_modules/@oxc-parser',
          entries: ['binding-wasm32-wasi']
        }
      }
    ]);
    expect(result.probe).toMatchObject({
      outcome: 'success',
      bodyLengths: [1, 1],
      errorCount: expect.any(Number),
      terminatedWorkers: expect.any(Number)
    });
    expect(result.probe.errorCount).toBeGreaterThan(0);
    expect(result.probe.malformedDiagnostic).toEqual({
      codeframe: expect.stringContaining('broken.js:1:14'),
      end: 14,
      message: 'Unexpected token',
      severity: 'Error',
      start: 13
    });
    expect(result.probe.terminatedWorkers ?? 0).toBeGreaterThan(0);
    expect(result.diagnostics.workerUrls.length).toBeGreaterThan(0);
    await expect
      .poll(() => result.diagnostics.closedWorkerUrls, { timeout: 10_000 })
      .toHaveLength(result.diagnostics.workerUrls.length);

    expect(result.artifacts).toEqual([
      {
        path: publisherFixture.artifacts[0].path,
        role: 'wasm',
        expectedSha256: publisherFixture.artifacts[0].sha256,
        actualSha256: publisherFixture.artifacts[0].sha256,
        servedSha256: publisherFixture.artifacts[0].sha256,
        servedFromVfs: true
      },
      {
        path: publisherFixture.artifacts[1].path,
        role: 'worker',
        expectedSha256: publisherFixture.artifacts[1].sha256,
        actualSha256: publisherFixture.artifacts[1].sha256,
        servedSha256: publisherFixture.artifacts[1].sha256,
        servedFromVfs: true
      }
    ]);
    expect(result.fallbackScan.observed).toEqual([]);
    expect(result.teardown).toEqual({ completed: true });
    expect(result.reboot).toEqual({ completed: true });
    expect(result.diagnostics.artifactResponses).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^200 application\/wasm .*parser\.wasm32-wasi\.wasm$/),
        expect.stringMatching(/^200 (?:text|application)\/javascript .*wasi-worker-browser\.mjs$/)
      ])
    );
    expect(result.runtimeErrors).toEqual([]);
    expect(result.diagnostics.pageErrors).toEqual([]);
    expect(result.diagnostics.failedRequests).toEqual([]);
  });
}

function oxcParserWasiWorkloadSource(): string {
  return String.raw`
const result = document.querySelector('#result');
const PublisherWorker = globalThis.Worker;
const publisherWorkers = [];
globalThis.Worker = class extends PublisherWorker {
  constructor(url, options) {
    super(url, options);
    publisherWorkers.push(this);
  }
};
try {
  const { parse } = await withDeadline(import('oxc-parser'), 120_000, 'Oxc parser WASI import');
  const parsed = await Promise.all([
    parse('answer.js', 'export const answer = 40 + 2;'),
    parse('typed.ts', 'export const second: number = 3 + 4;')
  ]);
  const invalid = await parse('broken.js', 'export const = ;');
  const bodyLengths = parsed.map((entry) => entry.program.body.length);
  const errorCount = invalid.errors.length;
  const malformedError = invalid.errors[0];
  const malformedLabel = malformedError?.labels?.[0];
  const malformedDiagnostic = {
    codeframe: malformedError?.codeframe,
    end: malformedLabel?.end,
    message: malformedError?.message,
    severity: malformedError?.severity,
    start: malformedLabel?.start
  };
  terminatePublisherWorkers();
  await new Promise(requestAnimationFrame);
  globalThis.__oxcParserWasiProbe = { outcome: 'success', bodyLengths, errorCount, malformedDiagnostic, terminatedWorkers: publisherWorkers.length };
} catch (error) {
  terminatePublisherWorkers();
  globalThis.__oxcParserWasiProbe = { outcome: 'failure', error: error instanceof Error ? error.stack || error.message : String(error) };
}
result.textContent = JSON.stringify(globalThis.__oxcParserWasiProbe);

function terminatePublisherWorkers() {
  for (const worker of publisherWorkers) worker.terminate();
}

function withDeadline(promise, timeout, label) {
  let deadline;
  return Promise.race([
    promise,
    new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(label + ' timed out')), timeout); })
  ]).finally(() => clearTimeout(deadline));
}
`;
}

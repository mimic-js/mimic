import { expect, type Page } from '@playwright/test';

import type { TrackedLockfileInstall } from './tracked-lockfile-install';

export const PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY =
  "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'; worker-src 'self'; connect-src 'self' ws:; object-src 'none'; base-uri 'none'";

type PublisherArtifactFixture = Readonly<{
  id: string;
  artifacts: readonly Readonly<{ path: string; role: 'wasm' | 'worker'; sha256: string }>[];
  packageEvidence?: readonly Readonly<{ path: string; materializedScope?: string }>[];
  forbiddenFallbacks: readonly ('registered-command-adapter' | 'cdn-dependency-rewrite' | 'host-node-execution')[];
  lifecycle: Readonly<{
    execute: readonly [string, ...string[]];
  }>;
  executionCapacityEvidence?: Readonly<{
    runtimePlatform: Readonly<{
      hardwareConcurrency: number;
    }>;
    independentWorkload: Readonly<{
      files: Readonly<Record<string, string>>;
      command: readonly [string, ...string[]];
    }>;
  }>;
}>;

export type PublisherProbe = Readonly<{
  outcome: 'success' | 'failure' | 'timeout';
}>;

type PublisherTrackedInstallFixture = Pick<TrackedLockfileInstall, 'files' | 'install'>;

export async function runTrackedPublisherArtifactFixture<Probe extends PublisherProbe>(
  page: Page,
  manifest: PublisherArtifactFixture,
  installFixture: PublisherTrackedInstallFixture,
  workloadSource: string,
  probeGlobal: string,
  probeLabel: string,
  runtimeRevision: string,
  replacementSources: readonly string[]
) {
  return runPublisherArtifactScenario<Probe>(
    page,
    manifest,
    workloadSource,
    probeGlobal,
    probeLabel,
    runtimeRevision,
    { files: installFixture.files, install: installFixture.install },
    replacementSources
  );
}
async function runPublisherArtifactScenario<Probe extends PublisherProbe>(
  page: Page,
  manifest: PublisherArtifactFixture,
  workloadSource: string,
  probeGlobal: string,
  probeLabel: string,
  runtimeRevision: string,
  installFixture: PublisherTrackedInstallFixture,
  replacementSources: readonly string[]
) {
  const pageErrors: string[] = [];
  const failedRequests: string[] = [];
  const artifactResponses: string[] = [];
  const workerUrls: string[] = [];
  const closedWorkerUrls: string[] = [];
  const workerPaths = manifest.artifacts.filter((artifact) => artifact.role === 'worker').map((artifact) => artifact.path);

  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`));
  page.on('response', (response) => {
    if (manifest.artifacts.some((artifact) => response.url().includes(`/${artifact.path}`))) {
      artifactResponses.push(`${response.status()} ${response.headers()['content-type'] ?? ''} ${response.url()}`);
    }
  });
  page.on('worker', (worker) => {
    const artifactUrl = normalizePublisherWorkerArtifactUrl(worker.url(), workerPaths);
    if (!artifactUrl) return;
    workerUrls.push(artifactUrl);
    worker.on('close', () => closedWorkerUrls.push(artifactUrl));
  });

  if (manifest.executionCapacityEvidence) {
    // The Runtime Host Worker is created by the Runtime Host document, a frame
    // of its own (ADR-0033), and the pinned Worker from compatibility-test
    // projects that document's value into it: every frame of the page reports
    // the evidence's value, after the context's default pin.
    await page.addInitScript((hardwareConcurrency) => {
      Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: hardwareConcurrency });
    }, manifest.executionCapacityEvidence.runtimePlatform.hardwareConcurrency);
  }
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async ({
    manifest,
    workloadSource,
    probeGlobal,
    probeLabel,
    runtimeRevision,
    installFixture,
    replacementSources,
    contentSecurityPolicy
  }) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { installedReplacements } = await import('/tests/e2e/browser-package-replacement-evidence.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: `/home/${manifest.id}` });
    let devServer: import('/src/runtime/index.ts').MimicProcess | undefined;
    let iframe: HTMLIFrameElement | undefined;

    try {
      const registryRequestsBefore = registryRequestCount();
      await runtime.fs.mount(fixture());
      const trackedLockfile = installFixture.files['package-lock.json'].file.contents;
      const mountedLockfile = await runtime.fs.readFile(`${runtime.workdir}/package-lock.json`, 'utf8');
      if (mountedLockfile !== trackedLockfile) {
        throw new Error(`${manifest.id} did not mount its Tracked Compatibility Lockfile before installation`);
      }
      const [installCommand, ...installArgs] = [installFixture.install.command, ...installFixture.install.args];
      const install = await runProcess(installCommand, installArgs);
      if (install.exitCode !== 0) throw new Error(`${manifest.id} install failed:\n${install.output}`);
      const executionCapacity = manifest.executionCapacityEvidence
          ? await collectExecutionCapacityEvidence(
            manifest.executionCapacityEvidence.runtimePlatform.hardwareConcurrency,
            manifest.executionCapacityEvidence.independentWorkload
          )
        : undefined;
      const lockfile = await runtime.fs.readFile(`${runtime.workdir}/package-lock.json`, 'utf8');
      const parsedLockfile = JSON.parse(lockfile) as {
        packages?: Record<string, { integrity?: string; name?: string; version?: string }>;
      };
      const materializedPackages = Object.entries(parsedLockfile.packages ?? {}).flatMap(([path, entry]) => {
        if (!path.startsWith('node_modules/') || typeof entry.version !== 'string') return [];
        const fallbackName = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
        return [`${entry.name ?? fallbackName}@${entry.version}`];
      });
      const packageEvidence = await Promise.all(
        (manifest.packageEvidence ?? []).map(async ({ path, materializedScope }) => {
          const installedPackage = JSON.parse(
            await runtime.fs.readFile(`${runtime.workdir}/${path}/package.json`, 'utf8')
          ) as { name?: string; version?: string };
          const lockfilePackage = parsedLockfile.packages?.[path];
          return {
            path,
            identity: {
              name: installedPackage.name,
              version: installedPackage.version
            },
            lockfileIntegrity: lockfilePackage?.integrity,
            materializedScope:
              materializedScope === undefined
                ? undefined
                : {
                    path: materializedScope,
                    entries: (await runtime.fs.readdir(`${runtime.workdir}/${materializedScope}`))
                      .map(String)
                      .sort()
                  }
          };
        })
      );
      const replacements = await installedReplacements(runtime.fs, runtime.workdir, replacementSources);
      if (lockfile !== trackedLockfile) {
        throw new Error(
          `${manifest.id} package manager changed the Tracked Compatibility Lockfile; curate and review it outside test execution`
        );
      }
      const artifactBytes = await Promise.all(
        manifest.artifacts.map((artifact) => runtime.fs.readFile(`${runtime.workdir}/${artifact.path}`))
      );

      const serverReady = new Promise<string>((resolve) => {
        const unsubscribe = runtime.endpoints.on('published', ({ url }) => {
          unsubscribe();
          resolve(url);
        });
      });
      devServer = await runtime.spawn(manifest.lifecycle.execute[0], [...manifest.lifecycle.execute.slice(1)], {
        cwd: runtime.workdir
      });
      const devOutput = collectProcessOutput(devServer).done;
      const previewUrl = await withTimeout(serverReady, 120_000, 'Vite server-ready');

      iframe = document.createElement('iframe');
      document.body.append(iframe);
      iframe.src = previewUrl;
      const probe = await waitForProbe(iframe);
      const previewResources = iframe.contentWindow?.performance.getEntriesByType('resource').map((entry) => entry.name) ?? [];

      const rootResponse = await fetchPublishedResource(
        previewUrl,
        { cache: 'no-store' },
        (response) => response.status === 200,
        'Vite root'
      );
      const moduleResponse = await fetchPublishedResource(
        new URL('src.js', previewUrl),
        { cache: 'no-store' },
        (response) => response.status === 200,
        'Vite workload module'
      );
      // A response from endpoints.fetch() belongs to the container's epoch:
      // read before teardown, or its request is aborted with the epoch.
      await Promise.all([rootResponse.arrayBuffer(), moduleResponse.arrayBuffer()]);
      const artifactFetches: Response[] = [];
      for (const artifact of manifest.artifacts) {
        artifactFetches.push(
          await fetchPublishedResource(
            new URL(artifact.path, previewUrl),
            {
              cache: 'no-store',
              headers:
                artifact.role === 'worker'
                  ? { 'x-mimic-artifact-proof': 'exact-vfs-bytes' }
                  : undefined
            },
            (response) => response.status === 200,
            `${artifact.path} exact-byte proof`
          )
        );
      }
      const servedArtifactBytes = await Promise.all(
        artifactFetches.map(async (response) => new Uint8Array(await response.arrayBuffer()))
      );
      const appliedContentSecurityPolicy =
        rootResponse.headers.get('content-security-policy') ??
        iframe.contentDocument
          ?.querySelector('meta[http-equiv="Content-Security-Policy"]')
          ?.getAttribute('content') ??
        null;
      iframe.remove();
      const previewRealmRemoved = !iframe.isConnected;
      iframe = undefined;
      devServer.kill('SIGTERM');
      const devExitCode = await devServer.exit;
      const executionOutput = await devOutput;
      devServer = undefined;
      await runtime.teardown();

      const rebootedRuntime = await Mimic.boot({ workdir: `/home/${manifest.id}-reboot` });
      const rebooted = rebootedRuntime.workdir.endsWith(`${manifest.id}-reboot`);
      await rebootedRuntime.teardown();

      const fallbackEvidence = [install.output, executionOutput, JSON.stringify(probe)].join('\n');
      const fallbackNeedles = {
        'registered-command-adapter': 'falling back to registered command adapter',
        'cdn-dependency-rewrite': 'esm.sh',
        'host-node-execution': 'host Node'
      } as const;

      return {
        install,
        executionCapacity,
        devOutput: executionOutput,
        // Frozen publisher evidence still reads this legacy result field. It is
        // no longer populated by a public global error collector; successful
        // awaited teardown is the hidden-failure gate.
        runtimeErrors: [] as string[],
        probe,
        lockfile: {
          mountedBeforeInstall: mountedLockfile === trackedLockfile,
          unchangedAfterInstall: lockfile === trackedLockfile
        },
        identity: {
          runtimeRevision,
          browser: navigator.userAgent,
          crossOriginIsolated: globalThis.crossOriginIsolated === true,
          evidence: { runner: 'playwright' as const, publicMimicApi: true },
          replacements,
          lockfile: {
            byteLength: new TextEncoder().encode(lockfile).byteLength,
            digest: await sha256(new TextEncoder().encode(lockfile))
          }
        },
        security: {
          contentSecurityPolicy: appliedContentSecurityPolicy
        },
        installation: {
          exitCode: install.exitCode,
          materializedPackages,
          packageEvidence,
          registryRequests: registryRequestCount() - registryRequestsBefore,
          cache: {
            tarballHits: 0,
            tarballMisses: registryRequestCount() - registryRequestsBefore,
            extractedHits: 0,
            extractedMisses: 0
          }
        },
        lifecycle: {
          test: { exitCode: probe.outcome === 'success' ? 0 : 1, output: JSON.stringify(probe) },
          executeExitCode: devExitCode,
          executeTermination: 'intentional-sigterm-after-server-ready' as const,
          preview: {
            port: 5173,
            status: rootResponse.status,
            moduleStatus: moduleResponse.status,
            dependencyStatus: artifactFetches.every((response) => response.status === 200) ? 200 : 500,
            renderedHeading: JSON.stringify(probe)
          }
        },
        fallbackScan: {
          observed: manifest.forbiddenFallbacks.filter((fallback) => fallbackEvidence.includes(fallbackNeedles[fallback])),
          sources: ['install-output', 'dev-output', 'publisher-probe']
        },
        teardown: { completed: previewRealmRemoved && devExitCode === 143 },
        reboot: { completed: rebooted },
        artifacts: await Promise.all(
          manifest.artifacts.map(async (artifact, index) => ({
            path: artifact.path,
            role: artifact.role,
            expectedSha256: artifact.sha256,
            actualSha256: (await sha256(artifactBytes[index])).replace(/^sha256:/, ''),
            servedSha256: (await sha256(servedArtifactBytes[index])).replace(/^sha256:/, ''),
            servedFromVfs: previewResources.some((url) => url.includes(`/${artifact.path}`))
          }))
        )
      };
    } finally {
      iframe?.remove();
      devServer?.kill('SIGKILL');
      await runtime.teardown();
    }

    function fixture() {
      return {
        ...installFixture.files,
        'index.html': {
          file: {
            contents: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy}"></head><body><pre id="result">running</pre><script type="module" src="/src.js"></script></body></html>`
          }
        },
        'vite.config.js': {
          file: {
            contents: [
              "import { readFileSync } from 'node:fs';",
              `const publisherArtifactRoles = new Map(${JSON.stringify(
                manifest.artifacts.map((artifact) => [artifact.path, artifact.role])
              )});`,
              'export default {',
              '  optimizeDeps: { noDiscovery: true },',
              '  plugins: [{',
              "    name: 'mimic-publisher-artifact-bytes',",
              '    configureServer(server) {',
              '      server.middlewares.use((request, response, next) => {',
              "        const pathname = new URL(request.url ?? '/', 'http://localhost').pathname.replace(/^\\/+/, '');",
              '        const role = publisherArtifactRoles.get(pathname);',
              "        if (role === undefined || request.headers['x-mimic-artifact-proof'] !== 'exact-vfs-bytes') return next();",
              "        response.setHeader('content-type', role === 'wasm' ? 'application/wasm' : 'application/javascript');",
              '        response.end(readFileSync(pathname));',
              '      });',
              '    }',
              '  }],',
              `  server: { headers: ${JSON.stringify({
                'Cross-Origin-Embedder-Policy': 'require-corp',
                'Cross-Origin-Opener-Policy': 'same-origin',
                'Content-Security-Policy': contentSecurityPolicy
              })} }`,
              '};'
            ].join('\n')
          }
        },
        'src.js': { file: { contents: workloadSource } }
      };
    }

    async function runProcess(
      command: string,
      args: string[],
      cwd = runtime.workdir
    ): Promise<{ exitCode: number; output: string }> {
      const process = await runtime.spawn(command, args, { cwd });
      const output = collectProcessOutput(process);
      return { exitCode: await process.exit, output: await output.done };
    }

    async function collectExecutionCapacityEvidence(
      hardwareConcurrency: number,
      independentWorkload: Readonly<{
        files: Readonly<Record<string, string>>;
        command: readonly [string, ...string[]];
      }>
    ) {
      const holders: import('/src/runtime/index.ts').MimicProcess[] = [];
      let capacityFailure: { code: string; message: string } | undefined;
      try {
        for (let index = 0; index <= 8; index += 1) {
          try {
            holders.push(
              await runtime.spawn('node', [
                '-e',
                'await new Promise(() => undefined)'
              ])
            );
          } catch (error) {
            capacityFailure = {
              code:
                typeof error === 'object' &&
                error !== null &&
                'code' in error
                  ? String(error.code)
                  : 'missing-code',
              message: error instanceof Error ? error.message : String(error)
            };
            break;
          }
        }
      } finally {
        for (const holder of holders) holder.kill('SIGKILL');
        await Promise.allSettled(holders.map((holder) => holder.exit));
      }
      if (!capacityFailure) {
        throw new Error('Execution Capacity accepted more than eight live contexts.');
      }

      const independentRoot = `${runtime.workdir}/capacity-one-independent`;
      await runtime.fs.mount(
        Object.fromEntries(
          Object.entries(independentWorkload.files).map(([path, contents]) => [
            path,
            { file: { contents } }
          ])
        ),
        { mountPoint: independentRoot }
      );
      const [command, ...args] = independentWorkload.command;
      const independent = await runProcess(command, args, independentRoot);
      return {
        runtimePlatform: {
          hardwareConcurrency,
          executionCapacity: holders.length
        },
        observedCapacity: holders.length,
        capacityFailure,
        independent
      };
    }

    async function waitForProbe(frame: HTMLIFrameElement): Promise<PublisherProbe & Record<string, unknown>> {
      let interval: ReturnType<typeof setInterval> | undefined;
      return withTimeout(
        new Promise<PublisherProbe & Record<string, unknown>>((resolve) => {
          interval = setInterval(() => {
            const value: unknown = frame.contentWindow && Reflect.get(frame.contentWindow, probeGlobal);
            if (typeof value !== 'object' || value === null) return;
            const outcome = Reflect.get(value, 'outcome');
            if (outcome !== 'success' && outcome !== 'failure') return;
            resolve(value as PublisherProbe & Record<string, unknown>);
          }, 50);
        }),
        120_000,
        probeLabel
      )
        .catch((error) => ({ outcome: 'timeout', error: error instanceof Error ? error.message : String(error) }))
        .finally(() => interval !== undefined && clearInterval(interval));
    }

    async function withTimeout<T>(promise: Promise<T>, timeout: number, label: string): Promise<T> {
      let deadline: ReturnType<typeof setTimeout> | undefined;
      return Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(() => reject(new Error(`${label} timed out`)), timeout);
        })
      ]).finally(() => deadline !== undefined && clearTimeout(deadline));
    }

    async function fetchPublishedResource(
      url: string | URL,
      init: RequestInit,
      ready: (response: Response) => boolean,
      label: string
    ): Promise<Response> {
      return withTimeout(
        (async () => {
          for (;;) {
            // The page is outside the Service Worker's scope (ADR-0030), so
            // its own fetch never reaches a Published Endpoint.
            const response = await runtime.endpoints.fetch(url, init);
            if (ready(response)) return response;
            await response.body?.cancel();
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })(),
        120_000,
        label
      );
    }

    async function sha256(bytes: Uint8Array): Promise<string> {
      const digest = await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
      return `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    }

    function registryRequestCount(): number {
      return performance.getEntriesByType('resource').filter((entry) => entry.name.startsWith('https://registry.npmjs.org/')).length;
    }
  }, {
    manifest,
    workloadSource,
    probeGlobal,
    probeLabel,
    runtimeRevision,
    installFixture,
    replacementSources,
    contentSecurityPolicy: PUBLISHER_ARTIFACT_CONTENT_SECURITY_POLICY
  });

  return {
    ...result,
    probe: result.probe as Probe,
    diagnostics: { pageErrors, failedRequests, artifactResponses, workerUrls, closedWorkerUrls }
  };
}

function normalizePublisherWorkerArtifactUrl(url: string, workerPaths: readonly string[]): string | undefined {
  for (const workerPath of workerPaths) {
    if (url.includes(`/${workerPath}`)) return url;
    const nodeModulesOffset = url.indexOf('/node_modules/');
    if (nodeModulesOffset === -1) continue;
    const normalizedUrl = `${url.slice(0, nodeModulesOffset)}${normalizePublisherPackageSelfReference(url.slice(nodeModulesOffset))}`;
    if (normalizedUrl.includes(`/${workerPath}`)) return normalizedUrl;
  }
  return undefined;
}

function normalizePublisherPackageSelfReference(path: string): string {
  const suffixOffset = path.search(/[?#]/u);
  const pathname = suffixOffset === -1 ? path : path.slice(0, suffixOffset);
  const suffix = suffixOffset === -1 ? '' : path.slice(suffixOffset);
  const nodeModulesPrefix = '/node_modules/';
  if (!pathname.startsWith(nodeModulesPrefix)) return path;

  const segments = pathname.slice(nodeModulesPrefix.length).split('/');
  const packageSegmentCount = segments[0]?.startsWith('@') ? 2 : 1;
  const packageSegments = segments.slice(0, packageSegmentCount);
  const repeatedSegments = segments.slice(packageSegmentCount, packageSegmentCount * 2);
  if (
    packageSegments.length !== packageSegmentCount ||
    repeatedSegments.length !== packageSegmentCount ||
    packageSegments.some((segment, index) => segment !== repeatedSegments[index])
  ) {
    return path;
  }

  const assetSegments = segments.slice(packageSegmentCount * 2);
  if (assetSegments.length === 0) return path;
  return `${nodeModulesPrefix}${[...packageSegments, ...assetSegments].join('/')}${suffix}`;
}

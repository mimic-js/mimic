import type { FrameLocator } from '@playwright/test';

import {
  ESBUILD_REPLACEMENT_LAUNCHER,
  preparedEsbuildBinaryPath
} from './browser-package-replacement-evidence';
import type {
  CompatibilityClaim,
  NpmExactGraphCompatibilityTarget
} from './compatibility-claim';
import { readApplication } from './fixture-application';
import { documentId, expect, test, type Stack, type StackServer } from './stack-scenario';
import {
  runViteDependencyOptimizerLifecycle,
  type ViteDependencyOptimizerLifecycle
} from './vite-dependency-optimizer-workflow';
import {
  installViteDevelopmentWorkflowProbe,
  runViteDevelopmentWorkflow,
  withHeading,
  type ViteDevelopmentWorkflow
} from './vite-development-workflow';
import {
  assertDefaultViteConfigLoader,
  findUnexpectedViteRequestFailures,
  isAllowedOptimizerReloadAbort
} from './vite-dev-suite-policy';
import { expectRendered } from './vite-render';

type ViteDevExactGraphClaim = Omit<CompatibilityClaim, 'target'> & Readonly<{
  target: NpmExactGraphCompatibilityTarget;
}>;

export type ViteDevVersionInputs = Readonly<{
  viteVersion: string;
  /** The `name@version` the install leaves in each directory of `node_modules`. */
  installed: Readonly<Record<string, string>>;
  /**
   * The esbuild version whose binary the graph runs through the esbuild
   * Browser Package Replacement launcher.
   */
  esbuild?: Readonly<{ version: string }>;
}>;

type ViteDevDriverInputs = Readonly<{
  expectedHeading: string;
  framework: string;
  resourcePath: string;
  optimizedDependencyPaths: readonly string[];
  optimizedResponseProof?: 'vite-produced-files';
  expectedResourcePaths?: readonly string[];
}>;

type ViteDevDriverMode =
  | Readonly<{ workflow: ViteDevelopmentWorkflow; optimizerLifecycle?: never }>
  | Readonly<{ workflow: null; optimizerLifecycle: ViteDependencyOptimizerLifecycle }>
  | Readonly<{ workflow: null; optimizerLifecycle?: never }>;

export type ViteDevDriver = ViteDevDriverInputs & ViteDevDriverMode;

export type ViteDevCase = Readonly<{
  /** The claim's lockfile names the fixture whose application and frozen graph the case runs. */
  claim: ViteDevExactGraphClaim;
  driver: ViteDevDriver;
  /** The application under the fixture's `apps/`, when the graph serves several. */
  app?: string;
  /**
   * `workflow` repeats install, serving and an update in the rebooted
   * container, for a claim whose statement names the reboot. Every other case
   * proves only that the reboot starts clean.
   */
  reboot?: 'workflow';
}>;

/**
 * The development claims of one Vite line. A case is a stack scenario of its
 * fixture's application: it installs the frozen graph, serves the application
 * with `npm run dev`, and drives it through its development workflow or the
 * dependency optimizer's lifecycle.
 */
export class ViteDevSuite {
  constructor(private readonly version: ViteDevVersionInputs) {}

  register(claimCase: ViteDevCase): void {
    const { claim, app } = claimCase;
    const fixture = claim.target.lockfile.path.split('/')[2];
    assertDefaultViteConfigLoader(readApplication(fixture, app)['package.json'], claim.id);
    if (/\breboot\b/u.test(claim.statement) !== repeatsRebootWorkflow(claimCase)) {
      throw new Error(`${claim.id} must repeat its workflow after the reboot exactly when its statement names the reboot`);
    }
    test.describe(() => {
      test.use({ fixture, app });
      test(claim.statement, async ({ stack }) => {
        test.setTimeout(600_000);
        await runViteDevCase(this.version, claimCase, stack);
      });
    });
  }
}

function repeatsRebootWorkflow(claimCase: ViteDevCase): boolean {
  return claimCase.reboot === 'workflow' && claimCase.driver.workflow !== null;
}

async function runViteDevCase(version: ViteDevVersionInputs, claimCase: ViteDevCase, stack: Stack): Promise<void> {
  const { driver } = claimCase;
  const { target } = claimCase.claim;
  const rendered = {
    heading: driver.expectedHeading,
    framework: driver.framework,
    resourcePaths: [...(driver.expectedResourcePaths ?? [driver.resourcePath]), ...driver.optimizedDependencyPaths]
  };
  expect(target.packages.vite).toBe(version.viteVersion);
  if (driver.workflow !== null) await installViteDevelopmentWorkflowProbe(stack.page);

  await stack.install();
  expect((await stack.run('npm --version')).output.trim()).toBe(target.packageManager.version);
  await stack.expectInstalled({ ...target.replacements, ...version.installed });
  if (version.esbuild !== undefined) {
    expect(await preparedEsbuildBinaryPath({ readFile: (path) => stack.readFile(path) }, 'node_modules/esbuild')).toBe(
      ESBUILD_REPLACEMENT_LAUNCHER
    );
  }

  // The frozen graph carries no optimized dependencies; the server writes them when it first serves the application.
  expect(await stack.exists('node_modules/.vite/deps')).toBe(false);
  const server = await stack.start('npm run dev');
  expect(server.port).toBe(5173);
  const app = await server.open();
  const resourceUrls = await expectRendered(app, rendered);
  await server.waitForOutput(`VITE v${version.viteVersion}`);
  expect(await stack.readdir('node_modules/.vite/deps')).toEqual(
    expect.arrayContaining(['_metadata.json', ...driver.optimizedDependencyPaths.map((path) => path.split('/').at(-1))])
  );
  if (driver.optimizedResponseProof === 'vite-produced-files') {
    await expectViteProducedResponses(stack, app, resourceUrls, driver.optimizedDependencyPaths);
  }
  if (version.esbuild !== undefined) {
    const wasm = `/.mimic/replacements/@esbuild/wasi-preview1/${version.esbuild.version}/esbuild.wasm`;
    expect((await stack.digest(wasm)).byteLength).toBeGreaterThan(1_000_000);
  }

  // A case with neither leaves its server running: the teardown every scenario asserts ends it.
  let optimizer: Awaited<ReturnType<typeof runViteDependencyOptimizerLifecycle>> | null = null;
  if (driver.optimizerLifecycle !== undefined) {
    optimizer = await runViteDependencyOptimizerLifecycle(stack, server, app, driver, driver.optimizerLifecycle);
  } else if (driver.workflow !== null) {
    await runViteDevelopmentWorkflow(stack, server, app, driver, driver.workflow);
  }
  expectViteDiagnostics(stack, server, driver, optimizer);

  if (repeatsRebootWorkflow(claimCase) && driver.workflow !== null) {
    await stack.reboot();
    await stack.install();
    const rebooted = await stack.start('npm run dev');
    expect(rebooted.port).toBe(5173);
    const rebootedApp = await rebooted.open();
    await expectRendered(rebootedApp, rendered);
    const document = await documentId(rebootedApp);
    await stack.writeFile(
      driver.workflow.appPath,
      withHeading(await stack.readFile(driver.workflow.appPath), driver.expectedHeading, driver.workflow.sourceHeading)
    );
    await expectRendered(rebootedApp, { ...rendered, heading: driver.workflow.sourceHeading });
    expect(await documentId(rebootedApp)).toBe(document);
    expect(await rebooted.stop()).toBe(143);
  }
}

/**
 * Proves the optimized dependencies the document loaded are the files Vite
 * wrote: each response is its file, apart from the version Vite adds to the
 * imports between them and the source map it appends.
 */
async function expectViteProducedResponses(
  stack: Stack,
  app: FrameLocator,
  resourceUrls: readonly string[],
  optimizedDependencyPaths: readonly string[]
): Promise<void> {
  const optimizedUrls = [...new Set(resourceUrls)].filter((url) => {
    const path = new URL(url).pathname;
    return path.includes('/node_modules/.vite/deps/') && path.endsWith('.js');
  });
  for (const dependencyPath of optimizedDependencyPaths) {
    expect(optimizedUrls.some((url) => url.includes(dependencyPath)), dependencyPath).toBe(true);
  }
  for (const url of optimizedUrls) {
    const response = await app.locator('html').evaluate(async (_html, address) => {
      const answer = await fetch(address);
      return { status: answer.status, body: await answer.text() };
    }, url);
    const file = await stack.readFile(new URL(url).pathname.slice(1));
    expect(response.status, url).toBe(200);
    expect(response.body.length, url).toBeGreaterThan(0);
    expect(
      [response.body, withoutResponseAnnotations(response.body)],
      `${url} is not the file Vite produced`
    ).toContain(file);
  }
}

function withoutResponseAnnotations(body: string): string {
  return body
    .replace(
      /(\b(?:from\s+|import\s*))(["'])\/node_modules\/\.vite\/deps\/([^"'/?]+\.js)\?v=[a-f0-9]+(["'])/gu,
      '$1$2./$3$4'
    )
    .replace(/\r?\n\/\/# sourceMappingURL=data:application\/json;base64,[A-Za-z0-9+/=]+\s*$/u, '');
}

/**
 * Answers for what the test page reported while the server ran: the only
 * failures are the ones the workflow provokes with its transform error, and
 * the document Vite may abandon when a late dependency reloads the preview.
 */
function expectViteDiagnostics(
  stack: Stack,
  server: StackServer,
  driver: ViteDevDriver,
  optimizer: Awaited<ReturnType<typeof runViteDependencyOptimizerLifecycle>> | null
): void {
  const { consoleErrors, network } = stack.takeDiagnostics();
  const { workflow } = driver;
  const previewUrl = optimizer?.previewUrl ?? server.url;
  const lateDiscovery =
    driver.optimizerLifecycle?.allowReloadDuringLateDiscovery === true ? (optimizer?.lateDiscovery ?? null) : null;

  const transformErrors = network.filter(
    (event) =>
      workflow !== null &&
      event.kind === 'response' &&
      event.status === 500 &&
      new URL(event.url).pathname === driver.resourcePath
  );
  const transformErrorUrls = new Set(transformErrors.map((event) => event.url));
  const respondsToTransformError = workflow !== null && workflow.transformErrorHttpResponse !== 'absent';
  if (workflow !== null) expect(transformErrors.length > 0).toBe(respondsToTransformError);

  const reloadAborts = network.filter((event) => isAllowedOptimizerReloadAbort(event, previewUrl, lateDiscovery));
  expect(reloadAborts.length).toBeLessThanOrEqual(1);
  const previewStart = network.findIndex((event) => event.kind === 'response' && event.url === server.url);
  expect(previewStart).toBeGreaterThanOrEqual(0);
  expect(
    network
      .slice(previewStart)
      .filter(
        (event) =>
          (event.kind === 'request-failed' || event.status >= 400) &&
          !transformErrorUrls.has(event.url) &&
          !reloadAborts.includes(event)
      )
  ).toEqual([]);
  expect(findUnexpectedViteRequestFailures(network, transformErrorUrls, previewUrl, lateDiscovery)).toEqual([]);

  const reloadErrors = respondsToTransformError
    ? (workflow.transformErrorReloadPaths ?? [driver.resourcePath]).map(
        (path) =>
          `[vite] Failed to reload ${path}. This could be due to syntax errors or importing non-existent modules. (see errors above)`
      )
    : [];
  if (workflow?.transformErrorDocument === 'replace') {
    expect(consoleErrors).toEqual(expect.arrayContaining(reloadErrors));
    expect(consoleErrors.filter((message) => !reloadErrors.includes(message))).toEqual([]);
  } else {
    expect(consoleErrors).toEqual(reloadErrors);
  }
}

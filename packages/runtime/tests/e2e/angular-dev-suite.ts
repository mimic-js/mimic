import type { FrameLocator } from '@playwright/test';

import {
  ESBUILD_REPLACEMENT_LAUNCHER,
  preparedEsbuildBinaryPath
} from './browser-package-replacement-evidence';
import type {
  CompatibilityClaim,
  NpmExactGraphCompatibilityTarget
} from './compatibility-claim';
import {
  documentId,
  eventually,
  expect,
  resourceUrls,
  styleOf,
  test,
  textOf,
  type Stack,
  type StackServer
} from './stack-scenario';

type AngularDevExactGraphClaim = Omit<CompatibilityClaim, 'target'> & Readonly<{
  target: NpmExactGraphCompatibilityTarget;
}>;

export type AngularDevVersionInputs = Readonly<{
  framework: string;
  /**
   * The `name@version` the install leaves in each directory of `node_modules`.
   * The claim's target names each by that directory, with `>` for a nested one.
   */
  installed: Readonly<Record<string, string>>;
  projectName: string;
  /** An element whose text a click changes and hot updates must keep. */
  preservedState?: Readonly<{
    selector: string;
    initial: string;
    updated: string;
  }>;
  styles: Readonly<{
    componentColor: string;
    bodyBackground: string;
  }>;
}>;

export type AngularDevCase = Readonly<{
  /** The claim's lockfile names the fixture whose workspace and frozen graph the case runs. */
  claim: AngularDevExactGraphClaim;
  expectedHeading: string;
}>;

type ErrorRecovery = Readonly<{ startedAtMs: number; completedAtMs: number }>;

const template = 'src/app/app.html';
const componentStyle = 'src/app/app.scss';
const globalStyle = 'src/styles.scss';
// Angular turns its persistent cache off where `process.versions.webcontainer`
// is set (ADR-0045); the fixtures enable it in angular.json, so a warm start
// from the cache a cold one left stays part of the claim.
const cache = '.angular/cache';
const serve = 'npm run start -- --host 0.0.0.0';
const forbiddenPackages = [
  '@angular/router',
  '@angular/ssr',
  '@angular/platform-server',
  '@angular/service-worker',
  '@angular/localize',
  'webpack'
];

/**
 * The development claim of one Angular line. The case is a stack scenario of
 * its fixture's workspace: it serves the application with the local Angular
 * CLI from a cold cache, from the cache that run left, and from a pristine
 * container.
 */
export class AngularDevSuite {
  constructor(private readonly version: AngularDevVersionInputs) {}

  register(claimCase: AngularDevCase): void {
    test.describe(() => {
      test.use({ fixture: claimCase.claim.target.lockfile.path.split('/')[2] });
      test(claimCase.claim.statement, async ({ stack }) => {
        test.setTimeout(1_500_000);
        await runAngularDevCase(this.version, claimCase, stack);
      });
    });
  }
}

async function runAngularDevCase(version: AngularDevVersionInputs, claimCase: AngularDevCase, stack: Stack): Promise<void> {
  const { target } = claimCase.claim;
  const heading = claimCase.expectedHeading;
  const recoveredHeading = `${heading} after template recovery`;
  const warmHeading = `${heading} after warm cache HMR`;
  const pristineHeading = `${heading} after pristine HMR`;

  // The workspace is what `ng new` leaves, without a router, overrides or a bundler of its own.
  const manifest = JSON.parse(await stack.readFile('package.json'));
  for (const property of ['overrides', 'resolutions', 'dependencies.@angular/router', 'dependencies.vite']) {
    expect(manifest).not.toHaveProperty(property);
  }
  expect(JSON.parse(await stack.readFile('angular.json'))).toMatchObject({
    cli: { packageManager: 'npm' },
    projects: {
      [version.projectName]: {
        architect: {
          build: {
            builder: '@angular/build:application',
            options: { inlineStyleLanguage: 'scss', styles: ['src/styles.scss'] }
          },
          serve: { builder: '@angular/build:dev-server' }
        }
      }
    }
  });

  expect(await stack.exists('node_modules')).toBe(false);
  await stack.install();
  await stack.expectInstalled({ ...target.replacements, ...version.installed });
  for (const [directory, identity] of Object.entries(version.installed)) {
    expect(target.packages[directory.replaceAll('/node_modules/', '>')], directory).toBe(
      identity.slice(identity.lastIndexOf('@') + 1)
    );
  }
  expect(await preparedEsbuildBinaryPath({ readFile: (path) => stack.readFile(path) }, 'node_modules/esbuild')).toBe(
    ESBUILD_REPLACEMENT_LAUNCHER
  );
  for (const name of forbiddenPackages) {
    expect(await stack.exists(`node_modules/${name}/package.json`), name).toBe(false);
  }
  const environment = await stack.run(['node', '-e', 'console.log(JSON.stringify({ ci: process.env.CI ?? null }))']);
  expect(JSON.parse(environment.output)).toEqual({ ci: null });

  // Cold: the first server builds into an empty cache and takes the whole development workflow.
  expect(await stack.exists(cache)).toBe(false);
  const cold = await startAngular(stack, version, heading);
  await cold.server.waitForOutput('Local:');
  expect(await styleOf(cold.app.locator('main'), 'color')).toBe(version.styles.componentColor);
  expect(await styleOf(cold.app.locator('body'), 'background-color')).toBe(version.styles.bodyBackground);
  expect((await resourceUrls(cold.app)).some((url) => url.includes('/@vite/client'))).toBe(true);
  const endpointEvents = await stack.endpointEvents();
  const errorRecovery = await runDevelopmentWorkflow(stack, cold.server, cold.app, version, heading);
  expect(await stack.readdir(cache)).not.toEqual([]);
  expect(await stack.endpointEvents()).toEqual(endpointEvents);
  await expect(stack.page.locator('iframe[data-stack-preview]')).toHaveAttribute('src', cold.server.url);
  await expectHardReload(cold.app, version, recoveredHeading);
  await stopAngular(stack, cold.server);

  // Warm: a second server starts from the cache the first one left.
  expect(await stack.readdir(cache)).not.toEqual([]);
  const warm = await startAngular(stack, version, recoveredHeading);
  await expectTemplateHmr(stack, warm.app, recoveredHeading, warmHeading);
  await expectHardReload(warm.app, version, warmHeading);
  await stopAngular(stack, warm.server);
  expectAngularDiagnostics(stack, cold.server.url, errorRecovery);

  // Pristine: a container booted after the teardown repeats the cold start from nothing.
  await stack.reboot();
  expect(await stack.exists('node_modules')).toBe(false);
  await stack.install();
  expect(await stack.exists(cache)).toBe(false);
  const pristine = await startAngular(stack, version, heading);
  expect(pristine.server.url).not.toBe(cold.server.url);
  await expectTemplateHmr(stack, pristine.app, heading, pristineHeading);
  await expectHardReload(pristine.app, version, pristineHeading);
  expect(await stack.readdir(cache)).not.toEqual([]);
  await stopAngular(stack, pristine.server);
  expectAngularDiagnostics(stack, pristine.server.url, null);
}

async function startAngular(
  stack: Stack,
  version: AngularDevVersionInputs,
  heading: string
): Promise<Readonly<{ server: StackServer; app: FrameLocator }>> {
  const server = await stack.start(serve, { timeoutMs: 180_000 });
  expect(server.port).toBe(4200);
  const app = await server.open();
  await eventually(() => textOf(app.locator('h1'))).toBe(heading);
  await expect(app.locator('main')).toHaveAttribute('data-framework', version.framework);
  return { server, app };
}

/** Stops the server and proves it left neither a listener nor a worker behind. */
async function stopAngular(stack: Stack, server: StackServer): Promise<void> {
  expect(await server.stop()).toBe(143);
  expect(await stack.endpoints()).toEqual([]);
  await eventually(() => stack.runtimeWorkers()).toEqual([]);
}

/** Rewrites the heading in the template and proves the open document shows it. */
async function expectTemplateHmr(stack: Stack, app: FrameLocator, heading: string, next: string): Promise<void> {
  const document = await documentId(app);
  const source = await stack.readFile(template);
  expect(source).toContain(heading);
  await stack.writeFile(template, source.replace(heading, next));
  await eventually(() => textOf(app.locator('h1'))).toBe(next);
  expect(await documentId(app)).toBe(document);
}

async function expectHardReload(app: FrameLocator, version: AngularDevVersionInputs, heading: string): Promise<void> {
  const document = await documentId(app);
  await app
    .locator('html')
    .evaluate(() => location.reload())
    .catch(() => undefined);
  await eventually(() => documentId(app).catch(() => document)).not.toBe(document);
  await eventually(() => textOf(app.locator('h1'))).toBe(heading);
  await expect(app.locator('main')).toHaveAttribute('data-framework', version.framework);
}

/**
 * Drives the cold server through a template update, a component style update
 * and a global style update, each in the open document and keeping its state,
 * then through a template error and a style error and the recovery from each.
 * Answers when the errors and recoveries ran.
 */
async function runDevelopmentWorkflow(
  stack: Stack,
  server: StackServer,
  app: FrameLocator,
  version: AngularDevVersionInputs,
  heading: string
): Promise<ErrorRecovery> {
  const main = app.locator('main');
  const document = await documentId(app);
  const state = version.preservedState;
  const expectPreserved = async (): Promise<void> => {
    expect(await documentId(app)).toBe(document);
    if (state) expect(await textOf(app.locator(state.selector))).toBe(state.updated);
  };
  const diagnostics = async (pattern: RegExp): Promise<number> =>
    ((await server.output()).replace(/\u001b\[[0-9;]*m/g, '').match(new RegExp(pattern.source, 'gi')) ?? []).length;
  const expectDiagnostic = async (pattern: RegExp, write: () => Promise<void>): Promise<void> => {
    const before = await diagnostics(pattern);
    await write();
    await server.waitForOutput(pattern, { count: before + 1, timeoutMs: 120_000 });
  };
  if (state) {
    expect(await textOf(app.locator(state.selector))).toBe(state.initial);
    await app.locator(state.selector).click();
    await eventually(() => textOf(app.locator(state.selector))).toBe(state.updated);
  }

  await expectTemplateHmr(stack, app, heading, `${heading} after template HMR`);
  await expectPreserved();
  const updatedTemplate = await stack.readFile(template);

  const updatedComponentStyle = (await stack.readFile(componentStyle)).replace(/color:\s*[^;]+;/, 'color: #047857;');
  expect(updatedComponentStyle).toContain('color: #047857;');
  await stack.writeFile(componentStyle, updatedComponentStyle);
  await eventually(() => styleOf(main, 'color')).toBe('rgb(4, 120, 87)');
  await expectPreserved();

  const updatedGlobalStyle = (await stack.readFile(globalStyle)).replace(/background:\s*[^;]+;/, 'background: #e0f2fe;');
  expect(updatedGlobalStyle).toContain('background: #e0f2fe;');
  await stack.writeFile(globalStyle, updatedGlobalStyle);
  await eventually(() => styleOf(app.locator('body'), 'background-color')).toBe('rgb(224, 242, 254)');
  await expectPreserved();

  const startedAtMs = Date.now();
  await expectDiagnostic(/NG5002|Parser Error/i, () =>
    stack.writeFile(template, `<main data-framework="${version.framework}"><h1>{{ 1 + }}</h1></main>`)
  );
  await stack.writeFile(
    template,
    updatedTemplate.replace(`${heading} after template HMR`, `${heading} after template recovery`)
  );
  await eventually(() => textOf(app.locator('h1'))).toBe(`${heading} after template recovery`);

  await expectDiagnostic(/Undefined variable|SassError/i, () =>
    stack.writeFile(componentStyle, 'main { color: $missing-angular-color; }')
  );
  await stack.writeFile(componentStyle, updatedComponentStyle.replace('#047857', '#c2410c'));
  await eventually(() => styleOf(main, 'color')).toBe('rgb(194, 65, 12)');
  return { startedAtMs, completedAtMs: Date.now() };
}

/**
 * Answers for what the test page reported while the servers ran: no error, no
 * failed response, and no failed request other than a component update a newer
 * one superseded and the document the CLI may abandon while it recovers.
 */
function expectAngularDiagnostics(stack: Stack, previewUrl: string, errorRecovery: ErrorRecovery | null): void {
  const { consoleErrors, network } = stack.takeDiagnostics();
  const componentKey = (url: string): string | undefined => {
    const parsed = new URL(url);
    return parsed.pathname === '/@ng/component' ? (parsed.searchParams.get('c') ?? '') : undefined;
  };
  const supersededUpdate = (event: (typeof network)[number]): boolean =>
    event.kind === 'request-failed' &&
    event.error === 'net::ERR_ABORTED' &&
    componentKey(event.url) !== undefined &&
    network.some(
      (candidate) =>
        candidate.kind === 'response' &&
        candidate.status === 200 &&
        componentKey(candidate.url) === componentKey(event.url) &&
        candidate.occurredAtMs <= event.occurredAtMs &&
        event.occurredAtMs - candidate.occurredAtMs <= 1_000
    );
  const recoveryReloads = network.filter(
    (event) =>
      errorRecovery !== null &&
      event.kind === 'request-failed' &&
      event.error === 'net::ERR_ABORTED' &&
      event.url === previewUrl &&
      event.occurredAtMs >= errorRecovery.startedAtMs &&
      event.occurredAtMs <= errorRecovery.completedAtMs
  );
  expect(consoleErrors).toEqual([]);
  expect(recoveryReloads.length).toBeLessThanOrEqual(1);
  expect(
    network.filter(
      (event) =>
        (event.kind === 'request-failed' || event.status >= 400) &&
        !recoveryReloads.includes(event) &&
        !supersededUpdate(event)
    )
  ).toEqual([]);
}

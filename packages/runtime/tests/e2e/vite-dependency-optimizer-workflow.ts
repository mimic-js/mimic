import type { FrameLocator } from '@playwright/test';

import { eventually, expect, textOf, type Stack, type StackServer } from './stack-scenario';
import type { LateDiscovery } from './vite-dev-suite-policy';
import { expectRendered, expectSettled } from './vite-render';

/**
 * What an optimizer case says. Its application follows the suite's
 * conventions: `src/App.js` imports picocolors, and `src/App.late.js` is the
 * next version of that file, which also imports `nanoid/non-secure` and shows
 * an identifier it generates in `[data-late-dependency]`.
 */
export type ViteDependencyOptimizerLifecycle = Readonly<{
  lateHeading: string;
  /** Whether Vite may load the document again while it discovers the late dependency. */
  allowReloadDuringLateDiscovery?: boolean;
}>;


type OptimizerMetadataEntry = Readonly<{ file: string; fileHash?: string }>;

type OptimizerGeneration = Readonly<{
  hash: string;
  browserHash: string;
  optimized: Readonly<Record<string, OptimizerMetadataEntry>>;
  chunks: Readonly<Record<string, OptimizerMetadataEntry>>;
  /** The SHA-256 of every file of the generation. */
  files: Readonly<Record<string, string>>;
}>;

const cachePath = 'node_modules/.vite/deps';
const sourcePath = 'src/App.js';
const lateSourcePath = 'src/App.late.js';
const initial = { specifier: 'picocolors', path: '/node_modules/.vite/deps/picocolors.js' };
const late = { specifier: 'nanoid/non-secure', path: '/node_modules/.vite/deps/nanoid_non-secure.js' };

/**
 * Restarts the server `app` was opened from and proves it serves the
 * generation of optimized dependencies the first server wrote, then adds a
 * bare import and proves Vite extends that generation in the running server.
 * Answers the address of the restarted server and when the late discovery ran.
 */
export async function runViteDependencyOptimizerLifecycle(
  stack: Stack,
  server: StackServer,
  app: FrameLocator,
  scenario: Readonly<{ expectedHeading: string; framework: string; resourcePath: string }>,
  lifecycle: ViteDependencyOptimizerLifecycle
): Promise<Readonly<{ previewUrl: string; lateDiscovery: LateDiscovery }>> {
  await expectSettled(app);
  const initialGeneration = await optimizerGeneration(stack);
  expect(initialGeneration.optimized).toHaveProperty([initial.specifier]);
  expect(initialGeneration.optimized).not.toHaveProperty([late.specifier]);
  expectGenerationFilesComplete(initialGeneration);
  expect(await server.stop()).toBe(143);

  // Rebinding a virtual address issues a new opaque route on the same origin,
  // so the restarted server keeps its port but not the retired URL.
  const warm = await stack.start('npm run dev');
  expect(warm.port).toBe(server.port);
  expect(warm.url).not.toBe(server.url);
  expect(new URL(warm.url).origin).toBe(new URL(server.url).origin);
  const warmApp = await warm.open();
  const rendered = { framework: scenario.framework, resourcePaths: [scenario.resourcePath, initial.path] };
  const warmUrls = await expectRendered(warmApp, { ...rendered, heading: scenario.expectedHeading });
  await expectSettled(warmApp);
  expect(await optimizerGeneration(stack)).toEqual(initialGeneration);
  expect(optimizedVersion(warmUrls, initial.path)).toBe(initialGeneration.browserHash);

  const endpointEvents = await stack.endpointEvents();
  const startedAtMs = Date.now();
  await stack.writeFile(sourcePath, await stack.readFile(lateSourcePath));
  const lateUrls = await expectRendered(warmApp, {
    framework: scenario.framework,
    heading: lifecycle.lateHeading,
    resourcePaths: [...rendered.resourcePaths, late.path]
  });
  await eventually(() => textOf(warmApp.locator('[data-late-dependency]'))).toMatch(/^[A-Za-z0-9_-]{8}$/u);
  await expectSettled(warmApp);
  const lateGeneration = await optimizerGeneration(stack);
  const completedAtMs = Date.now();
  expect(await stack.endpointEvents()).toEqual(endpointEvents);

  expect(lateGeneration.hash).toBe(initialGeneration.hash);
  expect(lateGeneration.files['_metadata.json']).not.toBe(initialGeneration.files['_metadata.json']);
  expect(lateGeneration.browserHash).not.toBe(initialGeneration.browserHash);
  expect(lateGeneration.optimized).toHaveProperty([initial.specifier]);
  expect(lateGeneration.optimized).toHaveProperty([late.specifier]);
  expectGenerationFilesComplete(lateGeneration);
  const lateVersion = optimizedVersion(lateUrls, late.path);
  expect(lateVersion).toMatch(/^[a-f0-9]+$/u);
  expect(lateVersion).not.toBe(initialGeneration.browserHash);
  expect(await warm.stop()).toBe(143);

  return { previewUrl: warm.url, lateDiscovery: { startedAtMs, completedAtMs } };
}

async function optimizerGeneration(stack: Stack): Promise<OptimizerGeneration> {
  const metadata = JSON.parse(await stack.readFile(`${cachePath}/_metadata.json`));
  const names = (await stack.readdir(cachePath)).sort();
  const digests = await Promise.all(names.map((name) => stack.digest(`${cachePath}/${name}`)));
  return {
    hash: metadata.hash,
    browserHash: metadata.browserHash,
    optimized: metadata.optimized,
    chunks: metadata.chunks,
    files: Object.fromEntries(names.map((name, index) => [name, digests[index].sha256]))
  };
}

/** Proves the generation holds its metadata and every file the metadata names. */
function expectGenerationFilesComplete(generation: OptimizerGeneration): void {
  expect(generation.files).toHaveProperty(['_metadata.json']);
  for (const entry of [...Object.values(generation.optimized), ...Object.values(generation.chunks)]) {
    expect(generation.files).toHaveProperty([entry.file.split('/').at(-1) ?? '']);
    if (entry.fileHash !== undefined) expect(entry.fileHash).not.toBe('');
  }
}

/** The generation an optimized dependency was requested from: the `v` of its address. */
function optimizedVersion(resourceUrls: readonly string[], dependencyPath: string): string | null {
  const resourceUrl = resourceUrls.find((url) => url.includes(dependencyPath));
  if (resourceUrl === undefined) throw new Error(`The document did not load ${dependencyPath}`);
  return new URL(resourceUrl).searchParams.get('v');
}

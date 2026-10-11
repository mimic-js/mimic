import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BrowserContext, Route } from '@playwright/test';

/**
 * The host half of install layers. A layer is the `node_modules` a frozen
 * install produced, stored under a key of everything the install read. Runs
 * that must prove the install itself set COMPATIBILITY_INSTALL_LAYERS=0.
 */

const layerDirectory = process.env.COMPATIBILITY_INSTALL_LAYER_CACHE ?? '.cache/install-layers';
const layerRoute = /\/__install-layer\/([0-9a-f]{64})$/;
// Bump when a runtime change makes stored layers stale.
const layerFormat = 'install-layer-v1';

export const installLayersEnabled = process.env.COMPATIBILITY_INSTALL_LAYERS !== '0';

/** The address of the layer for these install inputs, or null when layers are off. */
export function installLayerUrl(
  packageJson: string,
  lockfile: string,
  install: Readonly<{ command: string; args: readonly string[] }>
): string | null {
  if (!installLayersEnabled) return null;
  const hash = createHash('sha256');
  for (const part of [layerFormat, install.command, ...install.args, packageJson, lockfile]) {
    hash.update(part).update('\0');
  }
  return `/__install-layer/${hash.digest('hex')}`;
}

type TrackedInstall = Readonly<{
  files: Readonly<Record<string, Readonly<{ file: Readonly<{ contents: string }> }>>>;
  install: Readonly<{ command: string; args: readonly string[] }>;
}>;

/**
 * The frozen install of a tracked fixture, carrying the address of its layer.
 * A claim about installation passes `fixture.install` instead and always installs.
 */
export function layeredInstall(
  fixture: TrackedInstall
): Readonly<{ command: string; args: readonly string[]; layer: string | null }> {
  const lockfile = Object.entries(fixture.files).find(([name]) => name !== 'package.json')?.[1];
  if (lockfile === undefined) throw new Error('A tracked install fixture must carry its lockfile');
  return {
    command: fixture.install.command,
    args: fixture.install.args,
    layer: installLayerUrl(fixture.files['package.json'].file.contents, lockfile.file.contents, fixture.install)
  };
}

export async function serveInstallLayers(context: Pick<BrowserContext, 'route'>): Promise<void> {
  await context.route(layerRoute, serveInstallLayer);
}

async function serveInstallLayer(route: Route): Promise<void> {
  const request = route.request();
  const key = layerRoute.exec(new URL(request.url()).pathname)?.[1];
  if (key === undefined) return route.fallback();
  const path = join(layerDirectory, `${key}.tar.gz`);
  if (request.method() === 'PUT') {
    const body = request.postDataBuffer();
    if (body === null) return route.fulfill({ status: 400 });
    await mkdir(layerDirectory, { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, body);
    await rename(temporary, path);
    return route.fulfill({ status: 200, body: 'stored', contentType: 'text/plain' });
  }
  // A miss is a 200 that is not an archive. The browser reports a 404 as a
  // console error and a fulfilled response without a body as a failed request,
  // and claims assert that there are neither.
  const layer = await readFile(path).catch(() => undefined);
  return layer === undefined
    ? route.fulfill({ status: 200, body: 'miss', contentType: 'text/plain' })
    : route.fulfill({ status: 200, body: layer, contentType: 'application/gzip' });
}

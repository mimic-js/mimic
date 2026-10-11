import type { Mimic } from '../../src/runtime';
import { collectProcessOutput } from './process-output';

/**
 * The in-page half of install layers: a frozen install whose `node_modules`
 * is stored on the host the first time and mounted from there afterwards.
 * `install-layer-store.ts` names the layer and serves it.
 */

/** A frozen install, with the address of its stored layer when layers are on. */
export type FrozenInstall = Readonly<{ command: string; args: readonly string[]; layer?: string | null }>;
export type InstallOutcome = Readonly<{ exitCode: number; output: string; restored: boolean }>;

// A larger layer does not survive the round trip through one in-page buffer.
const maxLayerBytes = 64 * 2 ** 20;

/**
 * Runs `install` in `runtime`, or mounts its stored layer in its place. An
 * install without a `layer` always runs.
 */
export async function installOrRestore(
  runtime: Mimic,
  install: FrozenInstall,
  timeoutMs = 480_000
): Promise<InstallOutcome> {
  const layerUrl = install.layer ?? null;
  const modules = `${runtime.workdir}/node_modules`;
  if (layerUrl !== null && (await restoreLayer(runtime, layerUrl, modules))) {
    return { exitCode: 0, output: `restored ${modules} from an install layer\n`, restored: true };
  }
  const process = await runtime.spawn(install.command, [...install.args], { cwd: runtime.workdir });
  const output = collectProcessOutput(process);
  const timeout = setTimeout(() => process.kill('SIGTERM'), timeoutMs);
  try {
    const exitCode = await process.exit;
    if (exitCode === 0 && layerUrl !== null) await saveLayer(runtime, layerUrl, modules);
    return { exitCode, output: await output.done, restored: false };
  } finally {
    clearTimeout(timeout);
  }
}

async function restoreLayer(runtime: Mimic, url: string, mountPoint: string): Promise<boolean> {
  const response = await fetch(url, { cache: 'no-store' });
  const compressed = await response.blob();
  if (response.headers.get('content-type') !== 'application/gzip') return false;
  const archive = await new Response(compressed.stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  try {
    await runtime.fs.mount(archive, { mountPoint });
    return true;
  } catch {
    // The archive cannot be mounted; the install runs instead.
    await runtime.fs.rm(mountPoint, { recursive: true, force: true });
    return false;
  }
}

async function saveLayer(runtime: Mimic, url: string, path: string): Promise<void> {
  const archive = await runtime.fs.export(path, { format: 'tar' });
  const compressed = await new Response(
    new Blob([archive]).stream().pipeThrough(new CompressionStream('gzip'))
  ).arrayBuffer();
  if (compressed.byteLength > maxLayerBytes) return;
  // A layer that cannot be stored costs the next run an install, nothing else.
  await fetch(url, { method: 'PUT', body: compressed }).then((response) => response.text(), () => undefined);
}

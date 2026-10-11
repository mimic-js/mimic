import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The files of an application that a compatibility test mounts.
 *
 * An application lives in `compatibility/fixtures/<fixture>` (or
 * `compatibility/probes/<fixture>` while its stack has no claim), next to its
 * manifest and tracked lockfile. A fixture whose graph serves several
 * applications keeps each in `apps/<name>`; a test then names the one it runs,
 * and gets the fixture's top-level files with that application over them.
 */

// Claimed applications live in `fixtures`; applications still being probed live in `probes`.
const roots = ['fixtures', 'probes'].map((directory) =>
  fileURLToPath(new URL(`../../compatibility/${directory}/`, import.meta.url))
);

/** Paths relative to the working directory, mapped to file contents. */
export type ApplicationFiles = Readonly<Record<string, string>>;

export function readApplication(fixture: string, app?: string): ApplicationFiles {
  const directory = roots.map((root) => join(root, fixture)).find((path) => existsSync(path));
  if (directory === undefined) throw new Error(`No application directory compatibility/{fixtures,probes}/${fixture}`);
  if (app === undefined) return readDirectory(directory, '', new Set(['node_modules', 'apps']));
  const appDirectory = join(directory, 'apps', app);
  if (!existsSync(appDirectory)) throw new Error(`${fixture} has no application apps/${app}`);
  return { ...readTopLevelFiles(directory), ...readDirectory(appDirectory, '', new Set(['node_modules'])) };
}

function readTopLevelFiles(directory: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => [entry.name, readFileSync(join(directory, entry.name), 'utf8')])
  );
}

function readDirectory(directory: string, prefix: string, skipped: ReadonlySet<string>): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (prefix === '' && skipped.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) Object.assign(files, readDirectory(path, `${prefix}${entry.name}/`, skipped));
    else if (entry.isFile()) files[`${prefix}${entry.name}`] = readFileSync(path, 'utf8');
  }
  return files;
}

/**
 * In-page evidence of the Browser Package Replacements an install applied,
 * read from the installed files themselves.
 */
type EvidenceFileSystem = Readonly<{
  readFile(path: string, encoding: 'utf8'): Promise<string>;
}>;

export const ESBUILD_REPLACEMENT_LAUNCHER = '/.mimic/bin/esbuild';

/** The `name@version` installed at `node_modules/<source>` for each source package. */
export async function installedReplacements(
  fs: EvidenceFileSystem,
  projectRoot: string,
  sources: readonly string[]
): Promise<Record<string, string>> {
  const installed: Record<string, string> = {};
  for (const source of sources) {
    const manifest = JSON.parse(
      await fs.readFile(`${projectRoot}/node_modules/${source}/package.json`, 'utf8')
    ) as { name?: unknown; version?: unknown };
    installed[source] = `${String(manifest.name)}@${String(manifest.version)}`;
  }
  return installed;
}

/**
 * The binary path esbuild's own install script recorded in the installed
 * package, or `undefined` when the script did not record one.
 */
export async function preparedEsbuildBinaryPath(
  fs: EvidenceFileSystem,
  packageRoot: string
): Promise<string | undefined> {
  const main = await fs.readFile(`${packageRoot}/lib/main.js`, 'utf8');
  const recorded = /^var ESBUILD_BINARY_PATH = ("[^"]*");$/mu.exec(main.split('\n', 1)[0] ?? '');
  return recorded ? (JSON.parse(recorded[1]!) as string) : undefined;
}

type Vite6ExactGraphEvidence = Readonly<{
  replacements: Readonly<Record<string, string>>;
  esbuildBinaryPath: string | null;
  materializedPackages: readonly string[];
}>;

/**
 * Node source that prints, after `prefix`, the Browser Package Replacements
 * installed for `replacementSources`, the binary path esbuild's install script
 * recorded, and the installed Vite 6 package identities.
 */
export function vite6ExactGraphReporterSource(
  prefix: string,
  replacementSources: readonly string[]
): string {
  const serializedPrefix = JSON.stringify(prefix);
  const serializedSources = JSON.stringify(replacementSources);
  return String.raw`
import { readFileSync } from 'node:fs';

const vitePackage = JSON.parse(readFileSync('./node_modules/vite/package.json', 'utf8'));
const packageIdentity = (path) => {
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  return manifest.name + '@' + manifest.version;
};
const recordedEsbuildBinaryPath = /^var ESBUILD_BINARY_PATH = ("[^"]*");$/u.exec(
  readFileSync('./node_modules/esbuild/lib/main.js', 'utf8').split('\n', 1)[0]
);
console.log(${serializedPrefix}, JSON.stringify({
  replacements: Object.fromEntries(
    ${serializedSources}.map((source) => [
      source,
      packageIdentity('./node_modules/' + source + '/package.json')
    ])
  ),
  esbuildBinaryPath: recordedEsbuildBinaryPath ? JSON.parse(recordedEsbuildBinaryPath[1]) : null,
  materializedPackages: [
    packageIdentity('./node_modules/picocolors/package.json'),
    packageIdentity('./node_modules/vite/package.json'),
    packageIdentity('./node_modules/esbuild/package.json'),
    packageIdentity('./node_modules/rollup/package.json')
  ]
}));
`;
}

export function readVite6ExactGraphEvidence(output: string, prefix: string): Vite6ExactGraphEvidence {
  const marker = `${prefix} `;
  const line = output.split(/\r?\n/u).find((candidate) => candidate.startsWith(marker));
  if (line === undefined) throw new Error(`${prefix} evidence was not emitted:\n${output}`);

  const evidence: unknown = JSON.parse(line.slice(marker.length));
  const evidenceRecord = requireEvidenceRecord(evidence, 'Exact Graph evidence');
  const replacements = requireEvidenceRecord(evidenceRecord.replacements, 'replacements');
  const esbuildBinaryPath = evidenceRecord.esbuildBinaryPath;

  return {
    replacements: Object.fromEntries(
      Object.entries(replacements).map(([source, identity]) => [
        source,
        requireEvidenceString(identity, `${source} replacement`)
      ])
    ),
    esbuildBinaryPath:
      esbuildBinaryPath === null ? null : requireEvidenceString(esbuildBinaryPath, 'esbuild binary path'),
    materializedPackages: requireEvidenceArray(evidenceRecord.materializedPackages, 'materialized packages').map(
      (identity, index) => requireEvidenceString(identity, `materialized package ${index}`)
    )
  };
}

function requireEvidenceRecord(value: unknown, description: string): Readonly<Record<string, unknown>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value;
}

function requireEvidenceArray(value: unknown, description: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${description} must be an array`);
  return value;
}

function requireEvidenceString(value: unknown, description: string): string {
  if (typeof value !== 'string') throw new Error(`${description} must be a string`);
  return value;
}

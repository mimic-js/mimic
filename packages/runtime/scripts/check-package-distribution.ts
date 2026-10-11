import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

type JsonRecord = Record<string, unknown>;

export class PackageDistributionContractError extends Error {
  constructor(readonly issues: readonly string[]) {
    super(`Package distribution contract failed:\n${issues.map((issue) => `- ${issue}`).join('\n')}`);
    this.name = 'PackageDistributionContractError';
  }
}

/**
 * Validates the public surface of a built Mimic package without
 * packing or installing it. The caller owns artifact creation and consumer
 * lifecycle verification; this check only guards metadata and entry files.
 */
export function verifyPackageDistribution(root = process.cwd()): void {
  const packageRoot = resolve(root);
  const issues: string[] = [];
  const manifest = readManifest(packageRoot, issues);

  if (!manifest) throw new PackageDistributionContractError(issues);

  validatePublishableManifest(manifest, issues);
  const entry = validatePublicExport(manifest, issues);
  const packedFiles = validatePackedFiles(manifest, issues);

  if (entry && packedFiles) {
    validateEntryTarget(packageRoot, entry.types, 'types', packedFiles, issues);
    validateEntryTarget(packageRoot, entry.browser, 'browser', packedFiles, issues);
    validateEntryTarget(packageRoot, entry.default, 'default', packedFiles, issues);
    validateReferencedAssets(packageRoot, entry.browser, packedFiles, issues);
  }
  if (packedFiles) {
    validateBundlerEntry(packageRoot, manifest, packedFiles, issues);
    validateDependencies(packageRoot, manifest, packedFiles, issues);
  }

  if (issues.length > 0) throw new PackageDistributionContractError(issues);
}

function readManifest(root: string, issues: string[]): JsonRecord | undefined {
  const manifestPath = resolve(root, 'package.json');
  if (!existsSync(manifestPath)) {
    issues.push('missing package.json');
    return undefined;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (!isRecord(parsed)) {
      issues.push('package.json must contain an object');
      return undefined;
    }
    return parsed;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    issues.push(`cannot parse package.json: ${detail}`);
    return undefined;
  }
}

function validatePublishableManifest(manifest: JsonRecord, issues: string[]): void {
  if (!isNonEmptyString(manifest.name)) issues.push('package.json must declare a non-empty package name');
  if (!isNonEmptyString(manifest.version)) issues.push('package.json must declare a non-empty package version');
  if (manifest.private === true) issues.push('package.json must not set private to true');
}

type PublicEntry = Readonly<{
  types: string;
  browser: string;
  default: string;
}>;

function validatePublicExport(manifest: JsonRecord, issues: string[]): PublicEntry | undefined {
  const exportsField = manifest.exports;
  if (!isRecord(exportsField)) {
    issues.push('package.json exports must expose a single "." conditional entry');
    return undefined;
  }

  const exportKeys = Object.keys(exportsField);
  const publicSubpaths = exportKeys.filter((key) => key.startsWith('.'));
  const forbiddenSubpaths = publicSubpaths.filter(
    (key) => key !== '.' && key !== BUNDLER_ENTRY
  );
  if (forbiddenSubpaths.length > 0) {
    issues.push(`package.json must not expose deep-module, plugin, or composition subpaths: ${forbiddenSubpaths.join(', ')}`);
  }
  if (!exportKeys.includes('.') || publicSubpaths.length !== exportKeys.length) {
    issues.push('package.json exports must contain only the public "." entry');
  }

  const rootEntry = exportsField['.'];
  if (!isRecord(rootEntry)) {
    issues.push('package.json exports["."] must define types, browser, and default conditions');
    return undefined;
  }

  const conditionNames = ['types', 'browser', 'default'] as const;
  for (const condition of conditionNames) {
    if (!isPackageTarget(rootEntry[condition])) {
      issues.push(`package.json exports["."].${condition} must be a relative package target`);
    }
  }
  if (manifest.types !== rootEntry.types) {
    issues.push('package.json types must match package.json exports["."].types');
  }

  if (!isPackageTarget(rootEntry.types) || !isPackageTarget(rootEntry.browser) || !isPackageTarget(rootEntry.default)) {
    return undefined;
  }
  if (!rootEntry.types.endsWith('.d.ts')) {
    issues.push('package.json exports["."].types must point to a .d.ts file');
  }
  if (!isJavaScriptTarget(rootEntry.browser)) {
    issues.push('package.json exports["."].browser must point to a JavaScript file');
  }
  if (!isJavaScriptTarget(rootEntry.default)) {
    issues.push('package.json exports["."].default must point to a JavaScript file');
  }

  return { types: rootEntry.types, browser: rootEntry.browser, default: rootEntry.default };
}

/**
 * The one subpath beside the runtime facade: the build-time integration a
 * consumer's bundler configuration imports. It runs in Node, not in the page.
 */
const BUNDLER_ENTRY = './vite';

function validateBundlerEntry(
  root: string,
  manifest: JsonRecord,
  packedFiles: readonly string[],
  issues: string[]
): void {
  const entry = isRecord(manifest.exports) ? manifest.exports[BUNDLER_ENTRY] : undefined;
  if (entry === undefined) return;
  if (!isRecord(entry) || !isPackageTarget(entry.types) || !isPackageTarget(entry.default)) {
    issues.push(`package.json exports["${BUNDLER_ENTRY}"] must define types and default as relative package targets`);
    return;
  }
  for (const condition of ['types', 'default'] as const) {
    const target = entry[condition] as string;
    const path = resolve(root, target.slice(2));
    if (!isInside(root, path) || !existsSync(path) || !statSync(path).isFile()) {
      issues.push(`built ${BUNDLER_ENTRY} ${condition} entry does not exist: ${target}`);
    }
    if (!isPacked(target.slice(2), packedFiles)) {
      issues.push(`package.json files does not include the ${BUNDLER_ENTRY} ${condition} entry: ${target}`);
    }
  }
}

/**
 * A consumer installs exactly what the packed files import: every package
 * they name is a declared dependency (or peer dependency), and every declared
 * dependency is named by one of them.
 */
function validateDependencies(
  root: string,
  manifest: JsonRecord,
  packedFiles: readonly string[],
  issues: string[]
): void {
  const dependencies = Object.keys(isRecord(manifest.dependencies) ? manifest.dependencies : {});
  const declared = new Set([
    ...dependencies,
    ...Object.keys(isRecord(manifest.peerDependencies) ? manifest.peerDependencies : {})
  ]);
  const imported = new Set<string>();
  for (const file of [...packedScripts(root, packedFiles), ...publicDeclarations(root, manifest)]) {
    for (const specifier of importSpecifiers(file)) {
      const name = importedPackageName(specifier);
      if (name === undefined || imported.has(name)) continue;
      imported.add(name);
      if (!declared.has(name)) {
        issues.push(
          `packed file imports a package that is not a declared dependency: ${name} in ./${normalizePackedPath(relative(root, file))}`
        );
      }
    }
  }
  for (const name of dependencies) {
    if (!imported.has(name)) {
      issues.push(`package.json dependencies declares a package no packed file imports: ${name}`);
    }
  }
}

function packedScripts(root: string, packedFiles: readonly string[]): readonly string[] {
  const sources: string[] = [];
  const visit = (path: string): void => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) visit(resolve(path, entry));
    } else if (/\.[cm]?js$/u.test(path)) {
      sources.push(path);
    }
  };
  for (const entry of packedFiles) {
    const path = resolve(root, entry.replace(/\/?\*\*?$/u, ''));
    if (isInside(root, path)) visit(path);
  }
  return sources;
}

/**
 * The declaration files a consumer's compiler loads: the public types entries
 * and what they reach through relative imports. Declarations of internal
 * modules that no public type mentions are packed but never loaded.
 */
function publicDeclarations(root: string, manifest: JsonRecord): readonly string[] {
  const reached = new Set<string>();
  const visit = (path: string): void => {
    if (reached.has(path) || !existsSync(path) || !statSync(path).isFile()) return;
    reached.add(path);
    for (const fileName of importSpecifiers(path)) {
      if (!fileName.startsWith('.')) continue;
      const target = resolve(dirname(path), fileName);
      for (const candidate of [`${target}.d.ts`, resolve(target, 'index.d.ts'), target]) {
        if (existsSync(candidate) && statSync(candidate).isFile()) {
          visit(candidate);
          break;
        }
      }
    }
  };
  for (const entry of Object.values(isRecord(manifest.exports) ? manifest.exports : {})) {
    if (isRecord(entry) && isPackageTarget(entry.types)) visit(resolve(root, entry.types.slice(2)));
  }
  return [...reached];
}

/**
 * The module specifiers of a file's import and export declarations and of its
 * `import()` calls with a literal argument. The file is parsed in full: a
 * token scan mistakes the text of minified regular expressions and templates
 * for imports.
 */
function importSpecifiers(path: string): readonly string[] {
  const sourceFile = ts.createSourceFile(
    path,
    readFileSync(path, 'utf8'),
    ts.ScriptTarget.Latest,
    false,
    path.endsWith('ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS
  );
  const specifiers: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      specifiers.push(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const [argument] = node.arguments;
      if (argument !== undefined && ts.isStringLiteralLike(argument)) specifiers.push(argument.text);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      const { literal } = node.argument;
      if (ts.isStringLiteralLike(literal)) specifiers.push(literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

/** The package a specifier names, unless it is relative, absolute, or a URL such as `node:fs`. */
function importedPackageName(specifier: string): string | undefined {
  if (/^(?:[./]|[a-z][a-z0-9+.-]*:)/iu.test(specifier)) return undefined;
  const [first, second] = specifier.split('/');
  return first.startsWith('@') && second !== undefined ? `${first}/${second}` : first;
}

function validatePackedFiles(manifest: JsonRecord, issues: string[]): readonly string[] | undefined {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    issues.push('package.json files must declare the packed build outputs');
    return undefined;
  }

  const entries = manifest.files.filter(isNonEmptyString).map(normalizePackedPath);
  if (entries.length !== manifest.files.length) {
    issues.push('package.json files must contain only non-empty path entries');
    return undefined;
  }
  return entries;
}

function validateEntryTarget(
  root: string,
  target: string,
  condition: string,
  packedFiles: readonly string[],
  issues: string[]
): void {
  const relativeTarget = target.slice(2);
  const entryPath = resolve(root, relativeTarget);
  if (!isInside(root, entryPath)) {
    issues.push(`package.json exports["."].${condition} must stay inside the package root: ${target}`);
    return;
  }
  if (!existsSync(entryPath) || !statSync(entryPath).isFile()) {
    issues.push(`built ${condition} entry does not exist: ${target}`);
  }
  if (!isPacked(relativeTarget, packedFiles)) {
    issues.push(`package.json files does not include the ${condition} entry: ${target}`);
  }
}

function validateReferencedAssets(
  root: string,
  browserTarget: string,
  packedFiles: readonly string[],
  issues: string[]
): void {
  const browserPath = resolve(root, browserTarget.slice(2));
  if (!existsSync(browserPath) || !statSync(browserPath).isFile()) return;

  const source = readFileSync(browserPath, 'utf8');
  const assetReferences = new Set(
    [...source.matchAll(/new URL\(["'](\.?\/?assets\/[^"']+)["'],\s*import\.meta\.url\)/gu)]
      .map((match) => match[1].replace(/^\.\//, ''))
  );

  for (const assetReference of assetReferences) {
    const relativeAsset = normalizePackedPath(
      relative(root, resolve(dirname(browserPath), assetReference))
    );
    const assetPath = resolve(root, relativeAsset);
    if (!existsSync(assetPath) || !statSync(assetPath).isFile()) {
      issues.push(`built browser entry references a missing package asset: ./${relativeAsset}`);
    }
    if (!isPacked(relativeAsset, packedFiles)) {
      issues.push(`package.json files does not include the referenced package asset: ./${relativeAsset}`);
    }
  }
}

function isPacked(target: string, packedFiles: readonly string[]): boolean {
  return packedFiles.some((entry) => {
    const prefix = entry.replace(/\*\*?$/, '').replace(/\/$/, '');
    return entry === target || entry === `${target}/**` || target.startsWith(`${prefix}/`);
  });
}

function normalizePackedPath(entry: string): string {
  return entry.replace(/^\.\//, '').replace(/\\/g, '/').replace(/\/$/, '');
}

function isPackageTarget(value: unknown): value is string {
  return isNonEmptyString(value) && value.startsWith('./');
}

function isJavaScriptTarget(target: string): boolean {
  return /\.(?:js|mjs|cjs)$/.test(target);
}

function isInside(root: string, path: string): boolean {
  const pathFromRoot = relative(root, path);
  return pathFromRoot === '' || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== '..' && !pathFromRoot.startsWith('..'));
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    verifyPackageDistribution(process.argv[2]);
    console.log(`Package distribution contract passed: ${resolve(process.argv[2] ?? process.cwd())}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import ts from 'typescript';

type CompatibilityClaim = Readonly<{
  id: string;
  statement: string;
  declarationFingerprint: string;
}>;

type ClaimSpec = Readonly<{
  file: string;
  claims: readonly CompatibilityClaim[];
}>;

export type CompatibilityClaimMatrix = Readonly<{
  include: readonly Readonly<{
    shard: string;
    specs: string;
    claimIds: string;
  }>[];
}>;

type MatrixInput = Readonly<{
  repositoryRoot: URL;
  shardCount: number;
}>;

type AdditivityInput = Readonly<{
  baselineRoot: URL;
  repositoryRoot: URL;
}>;

type EvidenceInventory = Readonly<{
  claims: ReadonlyMap<string, string>;
  exactGraphTargets: ReadonlyMap<string, number>;
  fixtures: ReadonlyMap<string, string>;
}>;

const evidencePaths = ['tests/e2e', 'compatibility/fixtures'] as const;

export function createCompatibilityClaimMatrix({
  repositoryRoot,
  shardCount
}: MatrixInput): CompatibilityClaimMatrix {
  if (!Number.isSafeInteger(shardCount) || shardCount <= 0) {
    throw new Error(`Invalid Compatibility Claim shard count ${shardCount}`);
  }

  const rootPath = fileURLToPath(repositoryRoot);
  const e2eDirectory = join(rootPath, 'tests/e2e');
  const specs = readdirSync(e2eDirectory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.spec.ts'))
    .map((entry) => readClaimSpec(rootPath, join(e2eDirectory, entry.name)))
    .filter((entry): entry is ClaimSpec => entry !== undefined)
    .sort((left, right) => left.file.localeCompare(right.file));

  if (specs.length === 0) throw new Error('No co-located Compatibility Claims were discovered');
  assertUniqueClaimIds(specs);

  const shards = Array.from({ length: shardCount }, () => [] as ClaimSpec[]);
  for (const [index, spec] of specs.entries()) shards[index % shardCount].push(spec);

  return {
    include: shards.flatMap((shard, index) => {
      if (shard.length === 0) return [];
      return [
        {
          shard: `compatibility-${String(index + 1).padStart(2, '0')}`,
          specs: shard.map((spec) => spec.file).join(' '),
          claimIds: shard.flatMap((spec) => spec.claims.map((claim) => claim.id)).sort().join(', ')
        }
      ];
    })
  };
}

export function assertAdditiveCompatibilityEvidence({ baselineRoot, repositoryRoot }: AdditivityInput): void {
  assertAdditiveInventory(readWorkingTreeInventory(baselineRoot), readWorkingTreeInventory(repositoryRoot));
}

function readClaimSpec(repositoryRoot: string, path: string): ClaimSpec | undefined {
  const source = readFileSync(path, 'utf8');
  return readClaimSpecSource(displayPath(repositoryRoot, path), source);
}

function readClaimSpecSource(path: string, source: string): ClaimSpec | undefined {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const claims: CompatibilityClaim[] = [];
  visit(sourceFile);
  if (claims.length === 0) return undefined;

  return { file: path, claims };

  function visit(node: ts.Node): void {
    if (isCompatibilityClaimCall(node)) claims.push(readClaim(node, path));
    ts.forEachChild(node, visit);
  }
}

function isCompatibilityClaimCall(node: ts.Node): node is ts.CallExpression {
  return (
    ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'defineCompatibilityClaim'
  );
}

function readClaim(call: ts.CallExpression, path: string): CompatibilityClaim {
  const declaration = call.arguments[0];
  const id = readStaticProperty(declaration, 'id');
  const statement = readStaticProperty(declaration, 'statement');
  if (id === undefined || statement === undefined) {
    const location = call.getSourceFile().getLineAndCharacterOfPosition(call.getStart()).line + 1;
    throw new Error(`${path}:${location} must declare a static string id and statement`);
  }
  return {
    id,
    statement,
    declarationFingerprint: ts
      .createPrinter({ removeComments: true })
      .printNode(ts.EmitHint.Expression, declaration, call.getSourceFile())
  };
}

function readStaticProperty(node: ts.Expression | undefined, name: string): string | undefined {
  if (node === undefined || !ts.isObjectLiteralExpression(node)) return undefined;
  const property = node.properties.find(
    (candidate): candidate is ts.PropertyAssignment =>
      ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name
  );
  return property === undefined ? undefined : staticString(property.initializer);
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name)) return name.text;
  return undefined;
}

function staticString(node: ts.Expression): string | undefined {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return staticString(node.expression);
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isSatisfiesExpression(node)) {
    return staticString(node.expression);
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(node.left);
    const right = staticString(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
}

function assertUniqueClaimIds(specs: readonly ClaimSpec[]): void {
  const owners = new Map<string, string>();
  for (const spec of specs) {
    for (const claim of spec.claims) {
      const owner = owners.get(claim.id);
      if (owner !== undefined) {
        throw new Error(`Duplicate Compatibility Claim id ${claim.id} in ${owner} and ${spec.file}`);
      }
      owners.set(claim.id, spec.file);
    }
  }
}

function displayPath(repositoryRoot: string, path: string): string {
  const value = relative(repositoryRoot, path).split(sep).join('/');
  if (!/^tests\/e2e\/[a-z0-9-]+\.spec\.ts$/u.test(value)) {
    throw new Error(`Unsafe Compatibility Claim spec path ${value}`);
  }
  return value;
}

function readWorkingTreeInventory(repositoryRoot: URL): EvidenceInventory {
  const root = fileURLToPath(repositoryRoot);
  const entries = evidencePaths.flatMap((path) => filesUnder(join(root, path), root));
  return createEvidenceInventory(entries);
}

function readGitInventory(ref: string): EvidenceInventory {
  const prefix = packagePrefixAt(ref) ?? '';
  const paths = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', '--full-tree', ref, '--', ...evidencePaths.map((path) => `${prefix}${path}`)],
    { cwd: packageRoot, encoding: 'utf8' }
  )
    .split(/\r?\n/u)
    .filter((path) => path.length > 0);
  return createEvidenceInventory(
    paths.map(
      (path) =>
        [path.slice(prefix.length), execFileSync('git', ['show', `${ref}:${path}`], { cwd: packageRoot })] as const
    )
  );
}

const packageRoot = fileURLToPath(new URL('../', import.meta.url));
const matrixScript = 'scripts/compatibility-claim-matrix.ts';

function currentPackagePrefix(): string {
  return execFileSync('git', ['rev-parse', '--show-prefix'], { cwd: packageRoot, encoding: 'utf8' }).trim();
}

/**
 * Where this package's evidence lives in `ref`, as a path prefix from the
 * repository root. A ref from before the runtime became a workspace package
 * holds it at the root; drop that candidate once no baseline predates
 * packages/runtime.
 */
function packagePrefixAt(ref: string): string | undefined {
  for (const prefix of new Set([currentPackagePrefix(), ''])) {
    try {
      execFileSync('git', ['cat-file', '-e', `${ref}:${prefix}${matrixScript}`], {
        cwd: packageRoot,
        stdio: 'ignore'
      });
      return prefix;
    } catch {
      continue;
    }
  }
  return undefined;
}

function createEvidenceInventory(entries: readonly (readonly [string, Buffer])[]): EvidenceInventory {
  const claims = new Map<string, string>();
  const exactGraphTargets = new Map<string, number>();
  const fixtures = new Map<string, string>();

  for (const [path, body] of entries) {
    if (path.startsWith('compatibility/fixtures/')) {
      fixtures.set(path, createHash('sha256').update(body).digest('hex'));
      continue;
    }
    if (!path.startsWith('tests/e2e/') || !path.endsWith('.ts')) continue;
    const source = body.toString('utf8');
    if (path.endsWith('.spec.ts')) {
      const spec = readClaimSpecSource(path, source);
      for (const claim of spec?.claims ?? []) {
        const previous = claims.get(claim.id);
        if (previous !== undefined) throw new Error(`Duplicate Compatibility Claim id ${claim.id}`);
        claims.set(claim.id, claim.declarationFingerprint);
      }
    }
    for (const fingerprint of exactGraphTargetFingerprints(path, source)) {
      exactGraphTargets.set(fingerprint, (exactGraphTargets.get(fingerprint) ?? 0) + 1);
    }
  }
  return { claims, exactGraphTargets, fixtures };
}

function exactGraphTargetFingerprints(path: string, source: string): readonly string[] {
  const sourceFile = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const printer = ts.createPrinter({ removeComments: true });
  const fingerprints: string[] = [];
  visit(sourceFile);
  return fingerprints;

  function visit(node: ts.Node): void {
    if (ts.isObjectLiteralExpression(node) && readStaticProperty(node, 'kind') === 'exact-graph') {
      fingerprints.push(printer.printNode(ts.EmitHint.Expression, node, sourceFile));
      return;
    }
    ts.forEachChild(node, visit);
  }
}

function assertAdditiveInventory(baseline: EvidenceInventory, current: EvidenceInventory): void {
  for (const [id, declaration] of baseline.claims) {
    const currentDeclaration = current.claims.get(id);
    if (currentDeclaration === undefined) throw new Error(`Existing Compatibility Claim ${id} was removed`);
    if (currentDeclaration !== declaration) throw new Error(`Existing Compatibility Claim ${id} was refreshed`);
  }
  for (const [fingerprint, count] of baseline.exactGraphTargets) {
    if ((current.exactGraphTargets.get(fingerprint) ?? 0) < count) {
      throw new Error('An existing Exact Graph target was removed or refreshed');
    }
  }
  for (const [path, digest] of baseline.fixtures) {
    const currentDigest = current.fixtures.get(path);
    if (currentDigest === undefined) throw new Error(`Existing Exact Graph fixture ${path} was removed`);
    if (currentDigest !== digest) throw new Error(`Existing Exact Graph fixture ${path} was refreshed`);
  }
}

function filesUnder(path: string, repositoryRoot: string): readonly (readonly [string, Buffer])[] {
  const entries = readdirSync(path, { withFileTypes: true });
  return entries.flatMap((entry): readonly (readonly [string, Buffer])[] => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return filesUnder(child, repositoryRoot);
    if (!entry.isFile()) return [];
    return [[relative(repositoryRoot, child).split(sep).join('/'), readFileSync(child)]];
  });
}

function effectiveBaselineRef(requestedRef: string): string {
  if (packagePrefixAt(requestedRef) !== undefined) return requestedRef;
  const introduction = execFileSync(
    'git',
    [
      'log',
      '--reverse',
      '--diff-filter=A',
      '--format=%H',
      `${requestedRef}..HEAD`,
      '--',
      `:/${matrixScript}`,
      `:/${currentPackagePrefix()}${matrixScript}`
    ],
    { cwd: packageRoot, encoding: 'utf8' }
  )
    .trim()
    .split(/\r?\n/u)[0];
  if (!introduction) throw new Error(`Cannot locate Compatibility Claim matrix introduction after ${requestedRef}`);
  return `${introduction}^`;
}

function runCli(): void {
  const repositoryRoot = new URL('../', import.meta.url);
  const baselineRef = process.env.COMPATIBILITY_BASELINE_REF;
  if (baselineRef !== undefined && baselineRef.length > 0) {
    assertAdditiveInventory(readGitInventory(effectiveBaselineRef(baselineRef)), readWorkingTreeInventory(repositoryRoot));
  }
  const matrix = JSON.stringify(createCompatibilityClaimMatrix({ repositoryRoot, shardCount: 12 }));
  if (process.argv.includes('--github-output')) {
    const outputPath = process.env.GITHUB_OUTPUT;
    if (outputPath === undefined || outputPath.length === 0) {
      throw new Error('GITHUB_OUTPUT is required with --github-output');
    }
    appendFileSync(outputPath, `matrix=${matrix}\n`);
    return;
  }
  process.stdout.write(`${matrix}\n`);
}

const entrypoint = process.argv[1];
if (entrypoint !== undefined && pathToFileURL(entrypoint).href === import.meta.url) runCli();

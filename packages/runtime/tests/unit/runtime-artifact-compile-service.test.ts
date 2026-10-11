import { createHash } from 'node:crypto';

import * as Babel from '../../src/runtime/modules/runtime-host/runtime-artifact-compiler-babel';
import { describe, expect, test } from 'vitest';

import {
  CompileCacheKeyMismatchError,
  contentHash,
  createModuleExecutionEngine,
  createRuntimeArtifactCompileClient,
  createRuntimeArtifactCompileService,
  createRuntimeArtifactTranslator,
  runtimeArtifactCompileFailure,
  RUNTIME_ARTIFACT_TRANSLATOR_REVISION,
  type CompiledArtifactStore,
  type PrecompileFileSystem,
  type RuntimeArtifactCompileRequest,
  type RuntimeArtifactCompileResponse,
  type RuntimeArtifactKind,
  type RuntimeArtifactTranslation
} from '../../src/runtime/modules/module-execution-engine';

const translator = createRuntimeArtifactTranslator(Babel);

describe('Runtime Artifact compile service', () => {
  test('compiles each distinct source once and answers later requests by hash alone', async () => {
    const pool = countingPool();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate });
    const client = asyncClient(service);

    await expect(client('commonjs', 'module.exports = 1;')).resolves.toMatchObject({ format: 'commonjs' });
    await expect(client('commonjs', 'module.exports = 1;')).resolves.toMatchObject({ format: 'commonjs' });
    expect(pool.translations).toEqual(['commonjs']);
    expect(client.requests.filter((request) => request.source !== undefined)).toHaveLength(1);

    // A changed source is another entry.
    await client('commonjs', 'module.exports = 2;');
    expect(pool.translations).toEqual(['commonjs', 'commonjs']);
  });

  test('shares one compilation between concurrent requests for one source', async () => {
    const pool = countingPool();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate });
    const source = 'export const answer = 42;';
    const hash = hashOf(source);

    const results = await Promise.all([
      service.serve({ kind: 'module', hash, source }),
      service.serve({ kind: 'module', hash, source }),
      service.serve({ kind: 'module', hash })
    ]);

    expect(results.map((result) => result.status)).toEqual(['compiled', 'compiled', 'compiled']);
    expect(pool.translations).toEqual(['module']);
  });

  test('keeps a detected source as the artifact of the format it was detected as', async () => {
    const pool = countingPool();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate });
    const source = 'export default 42;';
    const hash = hashOf(source);

    await expect(service.serve({ kind: 'detect', hash, source })).resolves.toMatchObject({ format: 'module' });
    await expect(service.serve({ kind: 'module', hash })).resolves.toMatchObject({ status: 'compiled' });
    expect(pool.translations).toEqual(['detect']);
  });

  test('persists compiled text, so a later epoch compiles nothing it already compiled', async () => {
    const store = memoryStore();
    const firstPool = countingPool();
    await asyncClient(createRuntimeArtifactCompileService({ translate: firstPool.translate, store }))(
      'module',
      'export const value = 1;'
    );
    await store.settled();
    expect(firstPool.translations).toEqual(['module']);
    expect([...store.entries.values()][0]).toMatch(/^module\n\(function \(System, /);

    const laterPool = countingPool();
    const later = asyncClient(createRuntimeArtifactCompileService({ translate: laterPool.translate, store }));
    await expect(later('module', 'export const value = 1;')).resolves.toMatchObject({ format: 'module' });
    expect(laterPool.translations).toEqual([]);
    expect(later.requests.every((request) => request.source === undefined)).toBe(true);
  });

  test('looks in the store once per miss: the request that carries the source follows a miss', async () => {
    const store = memoryStore();
    const reads: string[] = [];
    const counted = { ...store, read: (key: string) => (reads.push(key), store.read(key)) };
    const client = asyncClient(createRuntimeArtifactCompileService({ translate: countingPool().translate, store: counted }));

    await client('commonjs', 'module.exports = 1;');

    expect(client.requests.map((request) => request.source !== undefined)).toEqual([false, true]);
    expect(reads).toHaveLength(1);
  });

  test('reports a failed compilation with its location and keeps nothing for it', async () => {
    const pool = countingPool();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate });
    const client = asyncClient(service);

    await expect(client('module-typescript', 'export const valid: number = 1;\nexport const broken: = 2;')).rejects
      .toMatchObject({ name: 'SyntaxError', loc: { line: 2, column: 21 } });
    await expect(client('module-typescript', 'export const valid: number = 1;\nexport const broken: = 2;')).rejects
      .toThrow(SyntaxError);
    expect(pool.translations).toEqual(['module-typescript', 'module-typescript']);
  });

  test('compiles the JavaScript a package manager installed, with the format Node gives each file', async () => {
    const pool = countingPool();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate });
    const files = treeFileSystem({
      '/app/node_modules/esm/package.json': '{ "type": "module" }',
      '/app/node_modules/esm/index.js': 'export const value = 1;',
      '/app/node_modules/esm/dist/cjs/package.json': '{ "type": "commonjs" }',
      '/app/node_modules/esm/dist/cjs/index.js': 'exports.value = 1;',
      '/app/node_modules/plain/package.json': '{ "name": "plain" }',
      '/app/node_modules/plain/index.js': 'module.exports = 1;',
      '/app/node_modules/plain/legacy.cjs': 'module.exports = 2;',
      '/app/node_modules/plain/modern.mjs': 'export default 3;',
      '/app/node_modules/plain/data.json': '{}',
      '/app/node_modules/plain/types.d.ts': 'export declare const value: number;',
      '/app/node_modules/plain/bundle.min.js': 'module.exports=4',
      '/app/node_modules/.bin/tool': '#!/usr/bin/env node\nrequire("plain");'
    });

    await expect(service.precompile('/app', files)).resolves.toEqual({ compiled: 5, cached: 0, failed: 0 });
    expect(pool.translations.sort()).toEqual(['commonjs', 'commonjs', 'detect', 'module', 'module']);
    await expect(service.serve({ kind: 'detect', hash: hashOf('module.exports = 1;') }))
      .resolves.toMatchObject({ status: 'compiled', format: 'commonjs' });
    await expect(service.precompile('/app', files)).resolves.toEqual({ compiled: 0, cached: 5, failed: 0 });
  });

  test('keys an entry by the SHA-256 of its source, the same for the same source and different otherwise', () => {
    const source = 'module.exports = 1;';

    expect(contentHash(source)).toBe(contentHash(source));
    expect(contentHash(source)).toMatch(/^[0-9a-f]{64}$/);
    // The key a Runtime Host verifies is the digest every other implementation computes.
    expect(contentHash(source)).toBe(createHash('sha256').update(source, 'utf8').digest('hex'));
    expect(contentHash('caf\u00e9')).toBe(createHash('sha256').update('caf\u00e9', 'utf8').digest('hex'));
    expect(contentHash(source)).not.toBe(contentHash('module.exports = 2;'));
    expect(contentHash('')).not.toBe(contentHash(' '));
    // The client sends exactly this key.
    expect(hashOf(source)).toBe(contentHash(source));
  });

  test('rejects a source sent under a key that is not its content hash, and stores nothing for it', async () => {
    const pool = countingPool();
    const store = memoryStore();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate, store });
    const victim = 'module.exports = "react";';
    const attacker = 'module.exports = "not react";';
    const claimed = hashOf(victim);

    await expect(service.serve({ kind: 'commonjs', hash: claimed, source: attacker })).rejects.toThrow(
      CompileCacheKeyMismatchError
    );
    await expect(service.serve({ kind: 'commonjs', hash: claimed, source: attacker })).rejects.toMatchObject({
      name: 'CompileCacheKeyMismatchError',
      kind: 'commonjs',
      requested: claimed,
      actual: hashOf(attacker)
    });
    expect(pool.translations).toEqual([]);
    await store.settled();
    expect(store.entries.size).toBe(0);
    // Another context asking for the victim's key still misses; nothing was planted.
    await expect(service.serve({ kind: 'commonjs', hash: claimed })).resolves.toEqual({ status: 'miss' });
    // The format a key names is part of the key, not of the verification.
    await expect(service.serve({ kind: 'module', hash: claimed, source: attacker })).rejects.toThrow(
      CompileCacheKeyMismatchError
    );
    expect(pool.translations).toEqual([]);
  });

  test('serves a source sent under its own content hash to later requests by hash alone', async () => {
    const pool = countingPool();
    const store = memoryStore();
    const service = createRuntimeArtifactCompileService({ translate: pool.translate, store });
    const source = 'module.exports = "react";';
    const hash = hashOf(source);

    await expect(service.serve({ kind: 'commonjs', hash, source })).resolves.toMatchObject({
      status: 'compiled',
      format: 'commonjs'
    });
    await expect(service.serve({ kind: 'commonjs', hash })).resolves.toMatchObject({ status: 'compiled' });
    expect(pool.translations).toEqual(['commonjs']);
    await store.settled();
    expect([...store.entries.keys()]).toEqual([`commonjs-${hash}`]);
  });

  test('gives the engine the compiler error location through the client', () => {
    const service = (request: RuntimeArtifactCompileRequest): RuntimeArtifactCompileResponse => {
      if (request.source === undefined) return { status: 'miss' };
      try {
        return { status: 'compiled', ...translator(request.kind, request.source) };
      } catch (error) {
        return { status: 'failed', error: runtimeArtifactCompileFailure(error) };
      }
    };
    const files = new Map([
      ['/app/value.cjs', 'module.exports = 41;'],
      ['/app/invalid.mts', 'export const valid: number = 1;\nexport const broken: = 2;']
    ]);
    const engine = createModuleExecutionEngine({
      cwd: '/app',
      moduleAccess: {
        readText: (path) => files.get(path) ?? '',
        isFile: (path) => files.has(path),
        isDirectory: () => false,
        realpathSync: (path) => path
      },
      process: { argv: [], env: {}, cwd: () => '/app', exit: () => { throw new Error('exit'); } },
      console: { log: () => undefined, error: () => undefined, warn: () => undefined },
      builtinModuleProvider: { resolve: () => undefined, load: () => ({ found: false }) },
      runtimeArtifactCompiler: { buffer: undefined, compile: createRuntimeArtifactCompileClient(service) }
    });

    expect(engine.require('./value.cjs', '/app')).toBe(41);
    return expect(engine.import('./invalid.mts', '/app')).rejects.toMatchObject({
      code: 'ERR_RUNTIME_ARTIFACT_COMPILE',
      location: { source: '/app/invalid.mts', line: 2 }
    });
  });
});

describe('Runtime Artifact translator', () => {
  // Compiled text is persisted, keyed by the Babel version and the translator
  // revision. A change to the translator's output must change the revision, or
  // a runtime would evaluate text an older translator wrote.
  test('produces the output its revision names', async () => {
    const outputs = [
      translator('commonjs', '#!/usr/bin/env node\nconst x = await0;\nmodule.exports = async () => await(0, x)();'),
      translator('module', "import a from './a.json' with { type: 'json' };\nexport * as ns from './b.mjs';\nfor await (const v of []) {}\nexport default await import('./c.mjs');"),
      translator('commonjs-typescript', 'const offset: number = 1;\nmodule.exports = { offset };'),
      translator('module-typescript', 'export interface Answer { value: number }\nexport const answer: Answer["value"] = 41;'),
      translator('detect', 'export default 1;'),
      translator('detect', 'module.exports = import("./x.mjs");')
    ];
    const digest = hashOf(JSON.stringify(outputs));

    expect(
      { revision: RUNTIME_ARTIFACT_TRANSLATOR_REVISION, babel: Babel.version, digest },
      'The translator output changed: increase RUNTIME_ARTIFACT_TRANSLATOR_REVISION, then record the new digest here.'
    ).toEqual({ revision: 7, babel: '7.29.7', digest: 'bda07754d98a5c2c001967ec098257c89e77eaaa0da6106505469dad9edf1cba' });
  });

  test('evaluates a CommonJS script as written, keeping its functions\' source text', () => {
    const source = 'module.exports = function   kept(value) { /* comment */ return value; };';
    const compiled = translator('commonjs', source);

    expect(compiled.code).toContain('function   kept(value) { /* comment */ return value; }');
    expect(compiled.code.split('\n')).toHaveLength(2);
  });
});

function countingPool() {
  const translations: RuntimeArtifactKind[] = [];
  return {
    translations,
    translate: async (kind: RuntimeArtifactKind, source: string): Promise<RuntimeArtifactTranslation> => {
      translations.push(kind);
      await Promise.resolve();
      try {
        return { status: 'compiled', ...translator(kind, source) };
      } catch (error) {
        return { status: 'failed', error: runtimeArtifactCompileFailure(error) };
      }
    }
  };
}

/**
 * The client's protocol over the asynchronous service, as a process worker's
 * mailbox carries it: ask by hash, and send the source only on a miss.
 */
function asyncClient(service: ReturnType<typeof createRuntimeArtifactCompileService>) {
  const requests: RuntimeArtifactCompileRequest[] = [];
  const serve = (request: RuntimeArtifactCompileRequest) => {
    requests.push(request);
    return service.serve(request);
  };
  const compile = async (kind: RuntimeArtifactKind, source: string) => {
    const hash = hashOf(source);
    let response = await serve({ kind, hash });
    if (response.status === 'miss') response = await serve({ kind, hash, source });
    const answered = response;
    // The synchronous client turns the answer into a result or the compiler's error.
    return createRuntimeArtifactCompileClient(() => answered)(kind, source);
  };
  return Object.assign(compile, { requests });
}

/** The content hash the client sends for `source`. */
function hashOf(source: string): string {
  let hash = '';
  createRuntimeArtifactCompileClient((request) => {
    hash = request.hash;
    return { status: 'compiled', format: 'commonjs', code: '' };
  })('commonjs', source);
  return hash;
}

function memoryStore(): CompiledArtifactStore & {
  readonly entries: Map<string, string>;
  settled(): Promise<void>;
} {
  const entries = new Map<string, string>();
  const writes: Promise<void>[] = [];
  return {
    entries,
    read: async (key) => entries.get(key),
    has: async (key) => entries.has(key),
    write(key, text) {
      const written = Promise.resolve().then(() => void entries.set(key, text));
      writes.push(written);
      return written;
    },
    settled: async () => {
      await Promise.all(writes);
    }
  };
}

function treeFileSystem(files: Record<string, string>): PrecompileFileSystem {
  const children = (directory: string) => {
    const names = new Map<string, boolean>();
    for (const path of Object.keys(files)) {
      if (!path.startsWith(`${directory}/`)) continue;
      const rest = path.slice(directory.length + 1);
      const slash = rest.indexOf('/');
      names.set(slash === -1 ? rest : rest.slice(0, slash), slash === -1);
    }
    return names;
  };
  return {
    async readdir(path) {
      return [...children(path)].map(([name, file]) => ({
        name,
        isFile: () => file,
        isDirectory: () => !file
      }));
    },
    async readFile(path) {
      const text = files[path];
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    }
  };
}

import { Buffer } from 'node:buffer';

import { describe, expect, test } from 'vitest';

import {
  bootstrapExecutionContext,
} from '../execution-context-bootstrap';
import {
  projectInlineNodeEntry,
  requireExecutionContextFileSystem
} from '../execution-context-file-system';
import * as Babel from '../../runtime-host/runtime-artifact-compiler-babel';

import {
  createRuntimeArtifactTranslator,
  type ModuleAccess,
  type ModuleExecutionConsole,
  type ModuleExecutionProcess
} from '../../module-execution-engine';
import { type RuntimeVirtualFileSystemClient } from '../../virtual-file-system';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';
import { createVirtualNetworkAuthority } from '../../virtual-network';

describe('Execution Context bootstrap', () => {
  test('installs the declared Node globals before entry evaluation and isolates builtin state per context', async () => {
    const first = createHarness(101);
    const second = createHarness(202);

    const firstExports = await first.context.engine.runEntry('./entry.cjs') as { os: unknown };
    const secondExports = await second.context.engine.runEntry('./entry.cjs') as { os: unknown };
    expect(firstExports).toEqual({
      os: expect.anything(),
      pid: 101,
      platform: 'browser',
      arch: 'wasm32',
      version: 'v22.22.3',
      releaseName: 'node',
      sameBuiltin: true
    });
    expect(secondExports).toEqual({
      os: expect.anything(),
      pid: 202,
      platform: 'browser',
      arch: 'wasm32',
      version: 'v22.22.3',
      releaseName: 'node',
      sameBuiltin: true
    });
    expect(first.runtimeGlobal.process).not.toBe(second.runtimeGlobal.process);
    expect(firstExports.os).not.toBe(secondExports.os);

    first.context.teardown();
    second.context.teardown();
    expect(Object.prototype.hasOwnProperty.call(first.runtimeGlobal, 'process')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(second.runtimeGlobal, 'process')).toBe(false);
  });

  test('projects bounded positional reads for an inline Node entry', () => {
    const backing = requireExecutionContextFileSystem(
      new VirtualFileSystem('/app')
    );
    const source = 'x'.repeat(1_048_608);
    const projected = projectInlineNodeEntry(backing, '/app', 42, {
      source,
      execArgv: [],
      preloadArgv: [],
      applicationArgs: []
    });
    const path = projected.path;

    expect(projected.fileSystem.readFileSliceSync(path, 1_048_576, 1_048_576))
      .toEqual(new TextEncoder().encode('x'.repeat(32)));

    const incomplete: RuntimeVirtualFileSystemClient = new Proxy(backing, {
      get: (target, property, receiver) =>
        property === 'readFileSliceSync'
          ? undefined
          : Reflect.get(target, property, receiver)
    });
    expect(() => requireExecutionContextFileSystem(incomplete))
      .toThrow('readFileSliceSync');
  });
});

function createHarness(pid: number) {
  const runtimeGlobal = Object.create(globalThis) as typeof globalThis;
  const process = {
    argv: [],
    env: {},
    pid,
    platform: 'browser',
    arch: 'wasm32',
    version: 'v22.22.3',
    versions: { node: '22.22.3' },
    release: {
      name: 'node',
      lts: 'Jod',
      sourceUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3.tar.gz',
      headersUrl: 'https://nodejs.org/download/release/v22.22.3/node-v22.22.3-headers.tar.gz'
    },
    cwd: () => '/app',
    stderr: { write: () => undefined },
    stdout: { write: () => undefined },
    exit: () => {
      throw new Error('Unexpected process.exit');
    }
  } satisfies ModuleExecutionProcess & {
    readonly platform: 'browser';
    readonly arch: 'wasm32';
    readonly version: 'v22.22.3';
    readonly versions: { readonly node: '22.22.3' };
    readonly release: { readonly name: 'node' };
  };
  const console: ModuleExecutionConsole = {
    log: () => undefined,
    error: () => undefined,
    warn: () => undefined
  };
  const sources = new Map([
    [
      '/app/entry.cjs',
      [
        "const bare = require('os');",
        "const qualified = require('node:os');",
        "module.exports = {",
        "  os: bare,",
        "  pid: process.pid,",
        "  platform: process.platform,",
        "  arch: process.arch,",
        "  version: process.version,",
        "  releaseName: process.release.name,",
        "  sameBuiltin: bare === qualified",
        "};"
      ].join('\n')
    ]
  ]);
  const declaredGlobals = [
    'process',
    'console',
    'Buffer',
    'URL',
    'URLSearchParams',
    'TextEncoder',
    'TextDecoder',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'clearImmediate',
    'queueMicrotask'
  ] as const;
  const moduleAccess: ModuleAccess = {
    readText(path) {
      expect(runtimeGlobal.process).toBe(process);
      for (const name of declaredGlobals) {
        expect(Object.prototype.hasOwnProperty.call(runtimeGlobal, name), `${name} must be installed`).toBe(true);
      }
      const source = sources.get(path);
      if (source === undefined) throw new Error(`Missing ${path}`);
      return source;
    },
    isFile: (path) => sources.has(path),
    isDirectory: (path) => [...sources.keys()].some((file) => file.startsWith(`${path.replace(/\/$/, '')}/`)),
    realpathSync: (path) => path
  };
  const context = bootstrapExecutionContext({
    cwd: '/app',
    moduleAccess,
    process,
    console,
    global: runtimeGlobal,
    nodeCompatibility: {
      childProcess: {
        cwd: '/app',
        env: process.env,
        parentPid: pid,
        port: {
          spawn: async () => { throw new Error('not used'); },
          signal: async () => false
        }
      },
      console,
      fileSystem: {
        asynchronous: new VirtualFileSystem('/app'),
        cwd: '/app',
        scheduler: runtimeGlobal,
        synchronous: new VirtualFileSystem('/app')
      },
      httpListenerClaims: () => undefined,
      referencedActivity: undefined,
      runtimeGlobal,
      threadExecutionPort: () => ({ start: () => { throw new Error('not used'); } }),
      virtualNetwork: createVirtualNetworkAuthority(),
      virtualNetworkOwnerId: String(pid),
      wasiVfs: {
        isDirectory: moduleAccess.isDirectory,
        isFile: moduleAccess.isFile
      },
      workerThreads: {
        current: {
          identity: { pid, threadId: 0 },
          payload: undefined,
          sendToParent: () => undefined,
          subscribeToParent: () => () => undefined
        },
        cwd: '/app',
        env: process.env
      }
    },
    runtimeArtifactCompiler: { buffer: undefined, compile: createRuntimeArtifactTranslator(Babel) }
  });
  return { context, runtimeGlobal };
}

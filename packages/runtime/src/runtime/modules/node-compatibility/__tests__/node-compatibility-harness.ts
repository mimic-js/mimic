import { createNodeCompatibility, type NodeCompatibilityGlobals } from '../node-compatibility';
import { createWorkerThreadSharedMemoryPool } from '../worker-thread-shared-memory';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';
import { createVirtualNetworkAuthority } from '../../virtual-network';

type HarnessOptions = {
  readonly fileSystem?: VirtualFileSystem;
  readonly global?: typeof globalThis;
  readonly globals: NodeCompatibilityGlobals;
  readonly httpListenerClaims?: () => undefined;
  readonly referencedActivity?: { acquire(): () => void };
  readonly scriptEvaluator?: { evaluate(source: string, options?: { readonly filename?: string }): unknown };
};

export function createNodeCompatibilityHarness(options: HarnessOptions) {
  const fileSystem = options.fileSystem ?? new VirtualFileSystem('/home/project');
  const runtimeGlobal = options.global ?? Object.create(globalThis) as typeof globalThis;
  const process = Object.assign(options.globals.process, {
    argv: [] as string[],
    env: {} as Record<string, string>,
    pid: 1,
    cwd: () => '/home/project',
    exit: () => { throw new Error('not used'); },
    stderr: { write: () => undefined },
    stdout: { write: () => undefined }
  });
  return createNodeCompatibility({
    global: runtimeGlobal,
    globals: options.globals,
    capabilities: {
      childProcess: {
        cwd: '/home/project',
        env: process.env,
        parentPid: process.pid,
        port: {
          spawn: async () => { throw new Error('not used'); },
          signal: async () => false
        }
      },
      console: options.globals.console,
      fileSystem: {
        asynchronous: fileSystem,
        cwd: '/home/project',
        scheduler: runtimeGlobal,
        synchronous: fileSystem
      },
      httpListenerClaims: options.httpListenerClaims ?? (() => undefined),
      nodeModuleAccess: {
        cache: {},
        extensions: {},
        compile: () => { throw new Error('not used'); },
        createRequireFunction: () => { throw new Error('not used'); },
        findPath: () => false,
        load: () => { throw new Error('not used'); },
        modulePaths: () => [],
        globalPaths: [],
        initPaths: () => undefined,
        registerCustomizationHooks: () => undefined,
        resolveFilename: () => { throw new Error('not used'); },
        syncBuiltinEsmExports: () => undefined
      },
      process,
      referencedActivity: options.referencedActivity,
      runtimeGlobal,
      queueMacrotask: (callback) => {
        const timer = setTimeout(callback, 0);
        return () => clearTimeout(timer);
      },
      scriptEvaluator: options.scriptEvaluator ?? { evaluate: () => { throw new Error('not used'); } },
      threadExecutionPort: () => ({ start: () => { throw new Error('not used'); } }),
      virtualNetwork: createVirtualNetworkAuthority(),
      virtualNetworkOwnerId: String(process.pid),
      wasiVfs: {
        isDirectory: (path) => fileSystem.isDirectory(path),
        isFile: (path) => fileSystem.isFile(path)
      },
      workerThreads: {
        current: { identity: { pid: process.pid, threadId: 0 } },
        cwd: '/home/project',
        env: process.env,
        ports: {
          createId: () => { throw new Error('not used'); },
          host: () => { throw new Error('not used'); },
          link: () => { throw new Error('not used'); }
        },
        sharedMemoryPool: createWorkerThreadSharedMemoryPool()
      }
    }
  });
}

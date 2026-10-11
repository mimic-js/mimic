import { describe, expect, test } from 'vitest';

import type {
  CommonJsExtensionHandler,
  CommonJsModule,
  CommonJsRequire,
  NodeModuleAccess
} from '../../module-execution-engine';
import { createModuleBuiltin } from '../module-builtin';

describe('node:module compatibility adapter', () => {
  test('projects Module operations onto the engine-owned module access port', () => {
    const access = createModuleAccess();
    const builtin = createModuleBuiltin(access, ['fs', 'path', 'node:assert']);
    const parent = new builtin.Module('/project/src/entry.cjs');
    const createRequireMethod = Object.getOwnPropertyDescriptor(builtin, 'createRequire')?.value as
      (filename: string | URL) => CommonJsRequire;

    expect(builtin.default).toBe(builtin.Module);
    expect(builtin.Module._cache).toBe(access.cache);
    expect(builtin.Module._extensions).toBe(access.extensions);
    expect(builtin._findPath('./value.cjs', ['/missing', '/project/src'])).toBe('/project/src/value.cjs');
    expect(builtin._nodeModulePaths('/project/src')).toEqual([
      '/project/src/node_modules',
      '/project/node_modules',
      '/node_modules'
    ]);
    expect(builtin._resolveFilename('./value.cjs', parent)).toBe('/project/src/value.cjs');
    expect(builtin.wrapper).toEqual(['(function (exports, require, module, __filename, __dirname) { ', '\n});']);
    expect(builtin.Module.wrap('exports.value = 1;')).toBe(
      '(function (exports, require, module, __filename, __dirname) { exports.value = 1;\n});'
    );
    expect(builtin._load('./value.cjs', parent)).toEqual({ loaded: './value.cjs', parentFilename: '/project/src/entry.cjs' });
    expect(createRequireMethod(new URL('file:///project/src/entry.cjs'))('./value.cjs')).toEqual({
      requiredFrom: 'file:///project/src/entry.cjs',
      request: './value.cjs'
    });
  });

  test('the Module functions Node assigns are enumerable, so a namespace interop copies them', () => {
    const builtin = createModuleBuiltin(createModuleAccess(), ['fs']);
    // What Babel's _interopRequireWildcard keeps of a CommonJS export.
    const namespace: Record<string, unknown> = {};
    for (const key in builtin) namespace[key] = (builtin as unknown as Record<string, unknown>)[key];

    expect(Object.keys(namespace)).toEqual(
      expect.arrayContaining([
        '_cache',
        '_extensions',
        'globalPaths',
        '_findPath',
        '_nodeModulePaths',
        '_load',
        '_resolveFilename',
        '_initPaths',
        'createRequire',
        'builtinModules'
      ])
    );
    expect(Object.keys(namespace)).not.toContain('wrap');
    expect((namespace._nodeModulePaths as (from: string) => string[])('/project/src')).toEqual([
      '/project/src/node_modules',
      '/project/node_modules',
      '/node_modules'
    ]);
    expect(namespace.globalPaths).toEqual(['/home/browser/.node_modules']);
  });

  test('a module built with new Module() requires from its filename and compiles source into itself', () => {
    const builtin = createModuleBuiltin(createModuleAccess(), []);
    const built = new builtin.Module('/project/src/virtual.cjs') as InstanceType<typeof builtin.Module> & {
      require(request: string): unknown;
      _compile(source: string, filename: string): unknown;
    };

    expect(built.require('./value.cjs')).toEqual({ loaded: './value.cjs', parentFilename: '/project/src/virtual.cjs' });
    built._compile('module.exports = 1', '/project/src/other.cjs');
    expect(built.exports).toEqual({ compiled: 'module.exports = 1', filename: '/project/src/other.cjs' });
    expect(built.filename).toBe('/project/src/other.cjs');
    expect(built.loaded).toBe(true);
  });

  test('keeps builtin names and module identities coherent across bare and node specifiers', () => {
    const builtin = createModuleBuiltin(createModuleAccess(), ['fs', 'path', 'node:assert']);

    expect(builtin.Module).toBe(builtin.default);
    expect(builtin.builtinModules).toEqual(['fs', 'path', 'assert']);
    expect(builtin.isBuiltin('fs')).toBe(true);
    expect(builtin.isBuiltin('node:fs')).toBe(true);
    expect(builtin.isBuiltin('node:assert')).toBe(true);
    expect(builtin.isBuiltin('vite')).toBe(false);
    expect(builtin.syncBuiltinESMExports()).toBeUndefined();
  });

  test('reports the always-on compile cache without a program-visible directory', () => {
    const builtin = createModuleBuiltin(createModuleAccess(), []);

    expect(builtin.constants.compileCacheStatus).toEqual({
      FAILED: 0,
      ENABLED: 1,
      ALREADY_ENABLED: 2,
      DISABLED: 3
    });
    expect(builtin.enableCompileCache('/pretend-cache')).toMatchObject({ status: 2 });
    expect(builtin.getCompileCacheDir()).toBeUndefined();
    expect(builtin.flushCompileCache()).toBeUndefined();
  });

  test('forwards module.register options without pretending to transfer values', () => {
    const access = createModuleAccess();
    const builtin = createModuleBuiltin(access, []);
    const registered: Array<{ specifier: string | URL; options: unknown }> = [];
    access.registerCustomizationHooks = (specifier, options) => registered.push({ specifier, options });

    builtin.register('./hooks.mjs', new URL('file:///project/src/register.mjs'), { data: { mode: 'test' } });

    expect(registered).toEqual([
      {
        specifier: './hooks.mjs',
        options: {
          parentURL: new URL('file:///project/src/register.mjs'),
          data: { mode: 'test' }
        }
      }
    ]);
  });
});

function createModuleAccess(): NodeModuleAccess {
  const cache: Record<string, CommonJsModule> = {};
  const extensions: Record<string, CommonJsExtensionHandler> = {};
  const makeRequire = (filename: string | URL): CommonJsRequire => {
    const loaderFunction = ((request: string) => ({ requiredFrom: String(filename), request })) as CommonJsRequire;
    Object.defineProperties(loaderFunction, {
      cache: { value: cache },
      extensions: { value: extensions },
      resolve: { value: (request: string) => `/project/src/${request.slice(2)}` }
    });
    return loaderFunction;
  };

  return {
    cache,
    extensions,
    compile: (module, source, filename) => {
      module.exports = { compiled: source, filename };
      module.loaded = true;
    },
    createRequireFunction: makeRequire,
    findPath: (request, paths) =>
      request === './value.cjs' && paths.includes('/project/src') ? '/project/src/value.cjs' : false,
    load: (request, parentFilename) => ({ loaded: request, parentFilename }),
    globalPaths: ['/home/browser/.node_modules'],
    initPaths: () => undefined,
    modulePaths: (fromDirectory) => [
      `${fromDirectory}/node_modules`,
      '/project/node_modules',
      '/node_modules'
    ],
    syncBuiltinEsmExports: () => undefined,
    resolveFilename: (request, parentFilename) =>
      request === './value.cjs' && parentFilename === '/project/src/entry.cjs'
        ? '/project/src/value.cjs'
        : '/project/src/unexpected.cjs',
    registerCustomizationHooks: () => undefined
  };
}

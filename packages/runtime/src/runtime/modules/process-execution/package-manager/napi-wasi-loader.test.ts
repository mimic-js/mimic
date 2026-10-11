import { describe, expect, test } from 'vitest';

import { generatedLoader, moduleExporting } from '../../../../../tests/napi-wasi-fixture';
import { loaderRegisterCalls, repairNapiWasiLoader, webAssemblyExportNames } from './napi-wasi-loader';

describe('NAPI-RS WASI loader repair', () => {
  test('reads the export names of a module without compiling it', () => {
    const bytes = moduleExporting(['__napi_register__is_ai_agent_64', 'malloc']);
    expect(webAssemblyExportNames(bytes)).toEqual(['memory', '__napi_register__is_ai_agent_64', 'malloc']);
    expect(WebAssembly.Module.exports(new WebAssembly.Module(bytes)).map((entry) => entry.name)).toEqual(
      webAssemblyExportNames(bytes)
    );
    expect(() => webAssemblyExportNames(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8))).toThrow(TypeError);
  });

  test('calls the register functions the module exports, in their sequence, and exports what they registered', () => {
    // nx 23.2: the loader names a build whose sequence numbers the module no longer carries.
    const stale = generatedLoader(
      ['__napi_register__copy_3', '__napi_register__is_ai_agent_52'],
      ['copy', 'isAiAgent']
    );
    const repaired = repairNapiWasiLoader(stale, [
      'memory',
      '__napi_register__is_ai_agent_64',
      '__napi_register__copy_4',
      '__napi_register__get_main_worktree_root_87',
      'malloc'
    ]);

    expect(repaired).toBeDefined();
    expect(loaderRegisterCalls(repaired!)).toEqual([
      '__napi_register__copy_4',
      '__napi_register__is_ai_agent_64',
      '__napi_register__get_main_worktree_root_87'
    ]);
    // The stale named exports stay; what the module registered is copied over them last.
    expect(repaired!.trimEnd().split('\n').slice(-2)).toEqual([
      '// mimic: exports what the module registered',
      'Object.assign(module.exports, __napiModule.exports)'
    ]);
    expect(repaired).toContain('module.exports.copy = __napiModule.exports.copy');
    // A repaired loader matches its module.
    expect(repairNapiWasiLoader(repaired!, [
      '__napi_register__copy_4',
      '__napi_register__is_ai_agent_64',
      '__napi_register__get_main_worktree_root_87'
    ])).toBeUndefined();
  });

  test('leaves a loader that matches its module, or that is not a generated loader, as it is', () => {
    const current = generatedLoader(['__napi_register__parse_0'], ['parse']);
    expect(repairNapiWasiLoader(current, ['memory', '__napi_register__parse_0'])).toBeUndefined();
    expect(repairNapiWasiLoader('module.exports = require("./binding")', ['__napi_register__parse_0'])).toBeUndefined();
    expect(repairNapiWasiLoader(current, ['memory'])).toBeUndefined();
  });
});

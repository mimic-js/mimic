import type { ModuleRecord } from '../module-execution-engine';
import { runtimeArtifactError } from '../runtime-artifact';

export class WasmExecutionRuntime {
  constructor(
    private readonly options: {
      readBytes(path: string): Uint8Array;
      importModule(specifier: string, fromDirectory: string): Promise<unknown>;
    }
  ) {}

  async evaluate(module: ModuleRecord): Promise<Record<string, unknown>> {
    const bytes = this.options.readBytes(module.filename);
    const artifact = { format: 'wasm', identity: module.filename } as const;

    let compiled: WebAssembly.Module;
    try {
      compiled = await WebAssembly.compile(bytes.slice().buffer);
    } catch (error) {
      throw runtimeArtifactError('ERR_RUNTIME_ARTIFACT_COMPILE', artifact, error);
    }

    const imports: WebAssembly.Imports = {};
    try {
      const descriptors = WebAssembly.Module.imports(compiled);
      for (const specifier of new Set(descriptors.map((entry) => entry.module))) {
        const imported = await this.options.importModule(specifier, module.dirname);
        if (!isRecord(imported)) {
          throw new TypeError(`WebAssembly import ${JSON.stringify(specifier)} did not resolve to a namespace`);
        }
        const moduleImports: WebAssembly.ModuleImports = {};
        for (const descriptor of descriptors.filter((entry) => entry.module === specifier)) {
          const value = imported[descriptor.name];
          if (!isWebAssemblyImportValue(value)) {
            throw new TypeError(
              `WebAssembly import ${JSON.stringify(`${specifier}.${descriptor.name}`)} has an unsupported value`
            );
          }
          moduleImports[descriptor.name] = value;
        }
        imports[specifier] = moduleImports;
      }
      const instance = await WebAssembly.instantiate(compiled, imports);
      if (!isRecord(module.exports)) {
        throw new TypeError(`WebAssembly module namespace is unavailable for ${module.filename}`);
      }
      Object.assign(module.exports, instance.exports);
      return module.exports;
    } catch (error) {
      throw runtimeArtifactError('ERR_RUNTIME_ARTIFACT_EVALUATION', artifact, error);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isWebAssemblyImportValue(value: unknown): value is WebAssembly.ImportValue {
  if (typeof value === 'function' || typeof value === 'number') return true;
  if (
    value instanceof WebAssembly.Global ||
    value instanceof WebAssembly.Memory ||
    value instanceof WebAssembly.Table
  ) {
    return true;
  }
  return false;
}

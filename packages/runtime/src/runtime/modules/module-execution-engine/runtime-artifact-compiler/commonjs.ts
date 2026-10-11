import type {
  CommonJsExtensionHandler,
  ModuleRecord
} from '../module-execution-engine';
import { runtimeArtifactError } from '../runtime-artifact';
import {
  instantiateRuntimeArtifact,
  type CompiledRuntimeArtifact,
  type RuntimeArtifactCompile,
  type RuntimeArtifactModuleScope,
  type RuntimeArtifactScope
} from './artifacts';

export class CommonJsExecutor {
  readonly extensions: Record<string, CommonJsExtensionHandler> = {
    // The engine hands extension handlers its own records; the JavaScript
    // handler reads the record's format and directory, which the view omits.
    '.js': (module) => this.loadJavaScript(module as ModuleRecord),
    '.json': (module) => {
      const source = this.options.readText(module.filename);
      try {
        module.exports = JSON.parse(source);
      } catch (error) {
        throw runtimeArtifactError('ERR_RUNTIME_ARTIFACT_COMPILE', { format: 'json', identity: module.filename }, error);
      }
    },
    '.node': () => {
      throw new Error('Native CommonJS extensions are unsupported in the browser runtime');
    }
  };
  /** The handlers the runtime installed, to tell a program's own handler from them. */
  private readonly runtimeHandlers: Readonly<Record<string, CommonJsExtensionHandler>> = { ...this.extensions };
  /** The artifact compiled while detecting a format, kept for the evaluation that follows. */
  private detected:
    | Readonly<{ kind: 'commonjs' | 'commonjs-typescript'; path: string; source: string; compiled: CompiledRuntimeArtifact }>
    | undefined;

  constructor(
    private readonly options: {
      readText(path: string): string;
      requireEsmInPlace(module: ModuleRecord): boolean;
      requireEsmFromSource(module: ModuleRecord, source: string): boolean;
      programCompile(module: ModuleRecord): ((source: string, filename: string) => unknown) | undefined;
      compile: RuntimeArtifactCompile;
      scope: RuntimeArtifactScope;
      /** `import()` from `module`, shared with ES modules. */
      moduleImport(module: ModuleRecord): RuntimeArtifactModuleScope['import'];
    }
  ) {}

  execute(module: ModuleRecord): unknown {
    const resolved = module.filename;
    const extension = registeredExtension(resolved, this.extensions);
    this.extensions[extension](module, resolved);
    return module.exports;
  }

  /** Whether a program replaced the handler that `require` would use for `filename`. */
  hasProgramHandler(filename: string): boolean {
    const extension = registeredExtension(filename, this.extensions);
    return this.extensions[extension] !== this.runtimeHandlers[extension];
  }

  /**
   * Decides the format of JavaScript no extension or package scope settles,
   * the way Node's syntax detection does: CommonJS when the source parses as a
   * script, an ES module when it only parses as one.
   */
  detectFormat(path: string, typeScript: boolean): 'commonjs' | 'module' {
    const source = this.options.readText(path);
    try {
      const compiled = this.options.compile(typeScript ? 'detect-typescript' : 'detect', source);
      this.detected = { kind: typeScript ? 'commonjs-typescript' : 'commonjs', path, source, compiled };
      return compiled.format;
    } catch {
      // The evaluation that follows compiles again and reports the error.
      return 'commonjs';
    }
  }

  /** `vm.runInThisContext`: a script of the global scope, whose top-level declarations are globals. */
  evaluateScript(source: string, filename: string): unknown {
    return globalScriptEval(`${source}\n//# sourceURL=${filename}`);
  }

  /**
   * `module._compile(source)`: runs `source` as the body of `module`, which is
   * how a CommonJS extension handler evaluates what it transformed. A source
   * that only parses as an ES module loads as one, and `module.exports` is
   * what `require()` of it returns, as Node's `_compile` detects: a handler
   * that compiles every `.js` file itself is given the ES files of a
   * `"type": "module"` package too.
   */
  compileSource(module: ModuleRecord, source: string): void {
    let compiled: CompiledRuntimeArtifact;
    try {
      compiled = this.options.compile('detect', source);
      if (compiled.format === 'module') {
        if (this.options.requireEsmFromSource(module, source)) return;
        compiled = this.options.compile('commonjs', source);
      }
    } catch (error) {
      throw runtimeArtifactError('ERR_RUNTIME_ARTIFACT_COMPILE', { format: 'commonjs', identity: module.filename }, error);
    }
    this.executeJavaScript(module, compiled);
  }

  /**
   * The runtime's `.js` loader, as Node's default one: a module whose
   * `_compile` a program replaced (pirates does, to transform the source) is
   * compiled through it, and an ES module a program's handler passed on loads
   * as an ES module.
   */
  private loadJavaScript(module: ModuleRecord): void {
    const programCompile = this.options.programCompile(module);
    if (programCompile) {
      programCompile.call(module, this.options.readText(module.filename), module.filename);
      return;
    }
    if (this.options.requireEsmInPlace(module)) return;
    this.executeJavaScript(module);
  }

  private executeJavaScript(module: ModuleRecord, supplied?: CompiledRuntimeArtifact): void {
    const resolved = module.filename;
    const source = supplied ? undefined : this.options.readText(resolved);
    const kind = supplied || module.format !== 'commonjs-typescript' ? 'commonjs' : 'commonjs-typescript';
    let instantiate: (...bindings: unknown[]) => unknown;
    try {
      instantiate = instantiateRuntimeArtifact(supplied ?? this.compiled(resolved, source!, kind), resolved);
    } catch (error) {
      throw runtimeArtifactError('ERR_RUNTIME_ARTIFACT_COMPILE', { format: kind, identity: resolved }, error);
    }
    // The program's own catch blocks receive what it throws exactly as thrown.
    this.options.scope.runCommonJs(
      instantiate,
      {
        exports: module.exports,
        require: module.require,
        module,
        filename: module.filename,
        dirname: module.dirname
      },
      { import: this.options.moduleImport(module) }
    );
  }

  private compiled(
    path: string,
    source: string,
    kind: 'commonjs' | 'commonjs-typescript'
  ): CompiledRuntimeArtifact {
    const detected = this.detected;
    this.detected = undefined;
    if (
      detected?.path === path &&
      detected.kind === kind &&
      detected.source === source &&
      detected.compiled.format === 'commonjs'
    ) {
      return detected.compiled;
    }
    return this.options.compile(kind, source);
  }
}

function registeredExtension(
  filename: string,
  extensions: Record<string, CommonJsExtensionHandler>
): string {
  const basename = filename.slice(filename.lastIndexOf('/') + 1);
  for (let dot = basename.indexOf('.'); dot !== -1; dot = basename.indexOf('.', dot + 1)) {
    const extension = basename.slice(dot);
    if (typeof extensions[extension] === 'function') return extension;
  }
  return '.js';
}

const globalScriptEval = globalThis.eval;

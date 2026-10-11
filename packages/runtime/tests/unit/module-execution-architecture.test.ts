import { existsSync, readFileSync, readdirSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

const executionContextRuntimeSource =
  'src/runtime/modules/node-compatibility/execution-context-runtime.ts';
const nodeRuntimeProgramSource =
  'src/runtime/modules/node-compatibility/node-runtime-program.ts';
const esmExecutionSource = 'src/runtime/modules/module-execution-engine/runtime-artifact-compiler/esm.ts';
const cjsExecutionSource = 'src/runtime/modules/module-execution-engine/runtime-artifact-compiler/commonjs.ts';
const runtimeArtifactCompilerSource = 'src/runtime/modules/module-execution-engine/runtime-artifact-compiler/index.ts';
const moduleExecutionEngineSource = 'src/runtime/modules/module-execution-engine/module-execution-engine.ts';
const executionContextBootstrapSource = 'src/runtime/modules/node-compatibility/execution-context-bootstrap.ts';
const nodeCompatibilityIndexSource = 'src/runtime/modules/node-compatibility/index.ts';
const nodeCompatibilitySource = 'src/runtime/modules/node-compatibility/node-compatibility.ts';
const nodeFileSystemSource = 'src/runtime/modules/node-compatibility/filesystem.ts';
const nodeFileSystemSharedSource = 'src/runtime/modules/node-compatibility/filesystem-shared.ts';
const nodeDnsSource = 'src/runtime/modules/node-compatibility/dns.ts';
const nodeHttpSource = 'src/runtime/modules/node-compatibility/http.ts';
const nodeHttp2Source = 'src/runtime/modules/node-compatibility/http2.ts';
const nodeNetworkSource = 'src/runtime/modules/node-compatibility/network-adapter.ts';
const nodeTlsSource = 'src/runtime/modules/node-compatibility/tls.ts';
const nodeWasiSource = 'src/runtime/modules/node-compatibility/wasi.ts';
const wasiExecutionSource = 'src/runtime/modules/wasi-execution/wasi-execution.ts';
const wasiExecutableInspectionSource =
  'src/runtime/modules/wasi-execution/executable-inspection.ts';
const wasiCommandExecutionSource =
  'src/runtime/modules/wasi-execution/command-execution.ts';
const wasiRuntimeProgramSource =
  'src/runtime/modules/runtime-host/wasi-runtime-program.ts';
const genericLoaderSources = [
  'src/runtime/modules/module-execution-engine/module-resolution.ts',
  cjsExecutionSource,
  esmExecutionSource,
  'src/runtime/modules/module-execution-engine/runtime-artifact-compiler/artifacts.ts'
] as const;

const forbiddenGenericLoaderPatterns = [
  {
    name: 'preview/server ownership',
    pattern: /\bpreview(?:Servers?|Request|Response|Compatibility)?\b|server-manager|Service Worker/i,
    owner: 'src/runtime/http-preview-bridge.ts or src/runtime/preview-compatibility.ts',
    allowedSources: []
  },
  {
    name: 'HMR transport ownership',
    pattern: /\bhmr\b|RuntimeHmrBroker|vite-hmr|vite-ping/i,
    owner: 'src/runtime/runtime-watch-hmr-compatibility.ts or a network/preview adapter',
    allowedSources: []
  },
  {
    name: 'Vite compatibility patching',
    pattern: /vite|@vite|vite-compatibility-adapter/i,
    owner: 'src/runtime/vite-compatibility-adapter.ts or another named quarantine adapter',
    allowedSources: []
  },
  {
    name: 'package-manager/native policy',
    pattern: /browser-package-policy|esbuild-wasm|@esbuild\/|native package|package replacement/i,
    owner: 'src/runtime/browser-package-policy.ts or package-manager policy modules',
    allowedSources: []
  },
  {
    name: 'browser demo concepts',
    pattern: /src\/App|fixture|demo catalog|Mimic UI/i,
    owner: 'demo, fixture, or public API modules',
    allowedSources: []
  },
  {
    name: 'generated runtime programs',
    pattern: /new Function|AsyncFunction|sourceURL|createEsmRuntimeArtifactSource|esmRuntimePreludeSource/i,
    owner: 'the Module Execution Engine runtime-artifact-compiler subtree',
    allowedSources: [
      cjsExecutionSource,
      esmExecutionSource,
      'src/runtime/modules/module-execution-engine/runtime-artifact-compiler/artifacts.ts'
    ]
  }
] as const;

describe('Module execution architecture', () => {
  test('keeps module identity and lifecycle in the Module Execution Engine', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const nodeRuntimeProgram = readFileSync(nodeRuntimeProgramSource, 'utf8');
    const engine = readFileSync(moduleExecutionEngineSource, 'utf8');
    const bootstrap = readFileSync(executionContextBootstrapSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const nodeCompatibilityIndex = readFileSync(nodeCompatibilityIndexSource, 'utf8');
    const nodeCompatibility = readFileSync(nodeCompatibilitySource, 'utf8');
    const commonJs = readFileSync(cjsExecutionSource, 'utf8');
    const esm = readFileSync(esmExecutionSource, 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(loader).toContain('bootstrapExecutionContext({');
    expect(bootstrap).toContain("from '../module-execution-engine'");
    expect(bootstrap).toContain("from './node-compatibility'");
    expect(bootstrap).toContain('createNodeCompatibility({');
    expect(bootstrap.indexOf('nodeCompatibility.installGlobals()')).toBeLessThan(
      bootstrap.indexOf('createModuleExecutionEngine({')
    );
    expect(nodeCompatibility).toContain('readonly builtinModuleProvider: BuiltinModuleProvider');
    expect(nodeCompatibility).toContain('canonicalBuiltinTable(options.builtins)');
    expect(nodeCompatibility).not.toMatch(/BuiltinAdapter|createDomainOperationTranslator|new Proxy/);
    expect(nodeCompatibilityIndex).not.toMatch(/create\w+Builtin\b|BuiltinTable/);
    expect(nodeCompatibility).toContain(
      'createBuiltinTable(options.capabilities, registerResource)'
    );
    const ttyBuiltin = readFileSync('src/runtime/modules/node-compatibility/tty.ts', 'utf8');
    expect(ttyBuiltin).toContain('ReadStream extends stream.Readable');
    expect(ttyBuiltin).toContain('WriteStream extends stream.Writable');
    expect(nodeRuntimeProgram).not.toMatch(/class ChildProcess(?:Input|Readable)|CHILD_STDIN_HIGH_WATER_MARK/);
    expect(nodeCompatibility).not.toMatch(
      /export function (?:createBuiltinTable|createNodeCompatibilityFromBuiltinTable)/
    );
    expect(builtinTable).not.toMatch(/BuiltinAdapter|createDomainOperationTranslator|new Proxy/);
    expect(existsSync('src/runtime/modules/node-compatibility/builtin-adapters.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/node-compatibility/builtin-table.ts')).toBe(false);
    expect(engine).toContain('private readonly records = new Map<string, ModuleRecord>()');
    expect(engine).toContain('createRuntimeArtifactCompiler');
    expect(engine).toContain("from './module-resolution'");
    expect(engine).toContain('CommonJsCacheProjection');
    expect(engine).not.toMatch(/node-stdlib|vite|rollup|esbuild/i);
    expect(engine).not.toMatch(/node-compatibility/i);
    expect(commonJs).not.toMatch(/readonly cache = new Map|cache = new Map/);
    expect(esm).not.toMatch(/evaluations = new Map/);
  });

  test('keeps the execution context constructor limited to loader collaborators', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const constructorOptions = loader.match(/private readonly options: \{([\s\S]*?)\n    \}/)?.[1] ?? '';

    expect(loader).toContain("from './execution-context-runtime-services'");
    expect(loader).not.toContain("from './browser-package-policy'");
    expect(loader).not.toContain("from './http-preview-bridge'");
    expect(loader).not.toContain("from './vite-compatibility-adapter'");
    expect(constructorOptions).not.toMatch(/preview|webSocket|hmr|vite|package/i);
    expect(constructorOptions).toContain('runtimeServices?: ExecutionContextRuntimeServices');
  });

  test('keeps Rollup parsing on the generic module and WebAssembly path', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');

    expect(loader).not.toMatch(/rollupNativeAdapter|rollupParseAstAdapter|isRollupParseAst/);
    expect(loader).not.toMatch(/node_modules\/rollup\/dist\/(?:es\/)?(?:native|parseAst)\.js/);
  });

  test('keeps ESM linking and live-binding execution behind an owned module seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const esmExecution = readFileSync(esmExecutionSource, 'utf8');
    const compiler = readFileSync(runtimeArtifactCompilerSource, 'utf8');
    const translator = readFileSync(
      'src/runtime/modules/module-execution-engine/runtime-artifact-compiler/translator.ts',
      'utf8'
    );
    const esmOptions = esmExecution.match(/type EsmExecutionRuntimeOptions = \{([\s\S]*?)\};/)?.[1] ?? '';

    expect(loader).not.toContain("from './esm-execution'");
    expect(loader).not.toContain('new EsmExecutionRuntime');
    expect(loader).not.toContain('esmEvaluations');
    expect(loader).not.toContain('function transformEsmSource');
    expect(loader).not.toContain('function instrumentMutableExportAssignments');
    expect(loader).not.toContain('function createEsmNamespace');
    expect(loader).not.toContain('function liveImportBindings');

    expect(esmExecution).toContain('class EsmExecutionRuntime');
    // The context evaluates compiled text only; the compiler runs in the
    // Runtime Host's compiler pool.
    expect(esmExecution).not.toMatch(/@babel\/|runtime-artifact-compiler-babel/);
    expect(translator).toContain("'transform-modules-systemjs'");
    expect(translator).toContain('retainLines: true');
    expect(translator).not.toContain('sourceMaps');
    expect(translator).toContain('supportTopLevelForAwait');
    expect(esmExecution).not.toContain('function transformEsmSource');
    expect(esmExecution).not.toContain('function instrumentMutableExportAssignments');
    expect(esmExecution).not.toContain('createEsmRuntimeArtifactSource');
    expect(esmExecution).not.toMatch(/prototypeEsmTransformer|BabelSystemJsPrototypeRuntime/);
    expect(esmExecution).toContain('function createEsmNamespace');
    expect(esmExecution).not.toContain('vite-compatibility-adapter');
    expect(esmExecution).not.toContain('viteServerRegistrationPatch');

    expect(esmOptions).toContain('importModule');
    expect(esmOptions).toContain('requireModule');
    expect(esmOptions).not.toContain('cacheSynchronousModule');
    expect(esmOptions).not.toMatch(/preview|hmr|vite|package|(?<!-)Mimic(?![-:])/i);
    expect(compiler).toContain('new EsmExecutionRuntime');
    expect(compiler).toContain('new CommonJsExecutor');
    expect(compiler).not.toMatch(/prototype|fallback|selector/i);
  });

  test('keeps crypto, compression, Buffer, and encoding ownership behind the Node Compatibility seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const bufferBuiltin = readFileSync('src/runtime/modules/node-compatibility/buffer.ts', 'utf8');
    const cryptoBuiltin = readFileSync('src/runtime/modules/node-compatibility/crypto.ts', 'utf8');
    const stringDecoderBuiltin = readFileSync('src/runtime/modules/node-compatibility/string-decoder.ts', 'utf8');
    const zlibBuiltin = readFileSync('src/runtime/modules/node-compatibility/zlib.ts', 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(builtinTable).toContain("['buffer', () => nodeBuffer]");
    expect(builtinTable).toContain("['crypto', createCryptoBuiltin]");
    expect(builtinTable).toContain("['string_decoder', () => nodeStringDecoder]");
    expect(builtinTable).toContain("['zlib', createZlibBuiltin]");
    expect(builtinTable).toContain("['stream/promises', () => nodeStream.promises]");
    expect(builtinTable).toContain('Buffer: BrowserBuffer');
    expect(builtinTable).toContain('WebSocket: createContextWebSocket(');
    expect(loader).not.toContain('class BrowserBuffer');
    expect(loader).not.toContain('function bufferBuiltin');
    expect(loader).not.toContain('function cryptoBuiltin');
    expect(loader).not.toContain('function stringDecoderBuiltin');
    expect(loader).not.toMatch(
      /function (?:pathBuiltin|urlBuiltin|osBuiltin|v8Builtin|ttyBuiltin|readlineBuiltin|perfHooksBuiltin)\b/
    );
    expect(loader).not.toMatch(/node-stdlib\/(?:buffer|hash|zlib)/);
    expect(bufferBuiltin).toContain('class BrowserBuffer');
    expect(bufferBuiltin).toContain('export const nodeBuffer');
    expect(bufferBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(cryptoBuiltin).toContain('function createCryptoBuiltin');
    expect(cryptoBuiltin).toContain("from '@noble/hashes/sha2.js'");
    expect(cryptoBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(stringDecoderBuiltin).toContain("from 'string_decoder/lib/string_decoder.js'");
    expect(stringDecoderBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(zlibBuiltin).toContain('function createZlibBuiltin');
    expect(zlibBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('keeps querystring implementation ownership behind the Node Compatibility seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const querystringBuiltin = readFileSync('src/runtime/modules/node-compatibility/querystring.ts', 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(builtinTable).toContain("['querystring', createQuerystringBuiltin]");
    expect(loader).not.toContain('function querystringBuiltin');
    expect(querystringBuiltin).toContain('function createQuerystringBuiltin');
    expect(querystringBuiltin).toContain('BrowserBuffer.from');
    expect(querystringBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('keeps filesystem and node:constants ownership behind Node Compatibility', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const constantsBuiltin = readFileSync('src/runtime/modules/node-compatibility/constants.ts', 'utf8');
    const fileSystemBuiltin = readFileSync(nodeFileSystemSource, 'utf8');
    const fileSystemShared = readFileSync(nodeFileSystemSharedSource, 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(builtinTable).toContain("['constants', createConstantsBuiltin]");
    expect(builtinTable).toContain('createNodeFileSystemBuiltins');
    expect(builtinTable).toContain("['fs', () => fileSystem.fs]");
    expect(builtinTable).toContain("['fs/promises', () => fileSystem.promises]");
    expect(loader).not.toContain("if (name === 'fs')");
    expect(loader).not.toContain('fsPromisesBuiltin');
    expect(loader).not.toContain('NODE_FS_CONSTANTS');
    expect(fileSystemShared).toContain('const NODE_FS_CONSTANTS');
    expect(fileSystemBuiltin).toContain('createNodeFileSystemBuiltins');
    expect(fileSystemBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(constantsBuiltin).toContain('function createConstantsBuiltin');
    expect(constantsBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('loads node:module and node:vm through engine-owned Node Compatibility ports', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const bootstrap = readFileSync(executionContextBootstrapSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const moduleBuiltin = readFileSync('src/runtime/modules/node-compatibility/module-builtin.ts', 'utf8');
    const vmBuiltin = readFileSync('src/runtime/modules/node-compatibility/vm.ts', 'utf8');
    const commonJs = readFileSync(cjsExecutionSource, 'utf8');

    expect(loader).not.toContain("from './node-stdlib/vm'");
    expect(loader).not.toContain("if (name === 'module')");
    expect(builtinTable).toContain("['module', () => createModuleBuiltin");
    expect(builtinTable).toContain("['vm', () => createVmBuiltin");
    expect(bootstrap).toContain('nodeModuleAccess');
    expect(bootstrap).toContain('scriptEvaluator');
    expect(moduleBuiltin).toContain("from '../module-execution-engine'");
    expect(moduleBuiltin).toContain('function createModuleBuiltin');
    expect(vmBuiltin).toContain("from '../module-execution-engine'");
    expect(vmBuiltin).toContain('function createVmBuiltin');
    expect(vmBuiltin).not.toMatch(/new Function|AsyncFunction|\beval\s*\(/);
    expect(commonJs).toContain('evaluateScript(source: string, filename: string)');
    expect(moduleBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(vmBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('keeps package-agnostic WASI ownership behind the WASI Execution seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const engine = readFileSync(moduleExecutionEngineSource, 'utf8');
    const bootstrap = readFileSync(executionContextBootstrapSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const wasiBuiltin = readFileSync(nodeWasiSource, 'utf8');
    const wasiExecution = readFileSync(wasiExecutionSource, 'utf8');
    const wasiExecutableInspection = readFileSync(
      wasiExecutableInspectionSource,
      'utf8'
    );
    const wasiCommandExecution = readFileSync(
      wasiCommandExecutionSource,
      'utf8'
    );
    const wasiRuntimeProgram = readFileSync(wasiRuntimeProgramSource, 'utf8');
    const processResolution = readFileSync(
      'src/runtime/modules/process-execution/executable-resolution.ts',
      'utf8'
    );
    const processExecution = readFileSync(
      'src/runtime/modules/process-execution/process-execution.ts',
      'utf8'
    );
    const processPrograms = readFileSync(
      'src/runtime/modules/runtime-host/runtime-program-host.ts',
      'utf8'
    );
    const processAssets = readFileSync(
      'src/runtime/modules/runtime-host/runtime-assets.ts',
      'utf8'
    );

    expect(loader).not.toMatch(/createWasiBuiltin|wasi_snapshot_preview1|node:wasi/);
    expect(builtinTable).toContain("['wasi', () => createWasiBuiltin({");
    expect(engine).not.toMatch(/wasi_snapshot_preview1|wasi_unstable|node:wasi/);
    expect(wasiBuiltin).toContain('function createWasiBuiltin');
    expect(wasiBuiltin).not.toMatch(/vite|rspack|rolldown|oxc|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(wasiBuiltin).toContain("from '../wasi-execution'");
    expect(wasiBuiltin).toContain('createWasiNodeAdapterFactory');
    expect(wasiBuiltin).not.toMatch(/wasi_snapshot_preview1|args_sizes_get|fd_prestat_get|path_open|proc_exit/);
    expect(wasiExecution).toContain('function createPreview1HostCore');
    expect(wasiExecution).toContain('function createWasiPreview1ExecutionFactory');
    expect(wasiExecutableInspection).toContain(
      'function inspectWasiPreview1Executable'
    );
    expect(wasiCommandExecution).toContain(
      'function executeWasiPreview1Command'
    );
    expect(wasiRuntimeProgram).toContain(
      'function createWasiRuntimeProgram'
    );
    expect(wasiExecution).toMatch(/args_sizes_get|fd_prestat_get|path_open|proc_exit/);
    expect(wasiExecution).not.toMatch(/vite|rspack|rolldown|oxc|package-manager|(?<!-)Mimic(?![-:])/i);
    expect(wasiExecutableInspection).not.toMatch(
      /vite|rspack|rolldown|oxc|package-manager|(?<!-)Mimic(?![-:])/i
    );
    expect(wasiCommandExecution).not.toMatch(
      /vite|rspack|rolldown|oxc|package-manager|(?<!-)Mimic(?![-:])|Worker|postMessage|terminate/i
    );
    expect(processResolution).toContain('program.inspect?.(bytes)');
    expect(processResolution).not.toMatch(/wasi_snapshot_preview1|WebAssembly\.Module/);
    expect(processPrograms).toContain('inspectWasiPreview1Executable');
    expect(processExecution).not.toContain('inspectWasiPreview1Executable');
    expect(processPrograms).not.toContain('binaryExecutable:');
    expect(processPrograms).toContain('createWasiRuntimeProgram');
    expect(wasiRuntimeProgram).toContain('executionContext.openWorker');
    expect(wasiRuntimeProgram).toContain('connectRpc');
    expect(wasiRuntimeProgram).toContain('terminate');
    expect(wasiRuntimeProgram).not.toMatch(/\.postMessage\(|new Worker\(|import\.meta\.url/);
    expect(processAssets).toContain('createWasiExecutionWorker');
    // The worker is a prebuilt asset the page's manifest names (ADR-0033).
    expect(processAssets).toContain("runtimeAssetUrl('wasi-runtime-worker.js')");
  });

  test('keeps util implementation ownership behind the Node Compatibility seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const utilBuiltin = readFileSync('src/runtime/modules/node-compatibility/util.ts', 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(builtinTable).toContain("['util', loadUtil]");
    expect(builtinTable).toContain('createUtilBuiltin(options.console');
    expect(loader).not.toContain('function utilBuiltin');
    expect(utilBuiltin).toContain('function createUtilBuiltin');
    expect(utilBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('keeps diagnostics_channel ownership behind the Node Compatibility seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const diagnosticsBuiltin = readFileSync('src/runtime/modules/node-compatibility/diagnostics-channel.ts', 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(builtinTable).toContain("['diagnostics_channel', createDiagnosticsChannelBuiltin]");
    expect(diagnosticsBuiltin).toContain('function createDiagnosticsChannelBuiltin');
    expect(diagnosticsBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('keeps Node network adapters behind Node Compatibility capability seams', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const dnsBuiltin = readFileSync(nodeDnsSource, 'utf8');
    const httpBuiltin = readFileSync(nodeHttpSource, 'utf8');
    const http2Builtin = readFileSync(nodeHttp2Source, 'utf8');
    const netBuiltin = readFileSync(nodeNetworkSource, 'utf8');
    const tlsBuiltin = readFileSync(nodeTlsSource, 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(loader).not.toMatch(/node-stdlib\/(?:http|http2|tls)/);
    expect(builtinTable).toMatch(/\['http', \(\) =>\s+createHttpBuiltin/);
    expect(builtinTable).toContain("['http2', createHttp2Builtin]");
    expect(builtinTable).toMatch(/\['https', \(\) =>\s+createHttpBuiltin/);
    expect(builtinTable).toContain("['net', () => network]");
    expect(builtinTable).toContain("['dns', loadDns]");
    expect(builtinTable).toContain('createDnsBuiltin()');
    expect(builtinTable).toContain("['tls', () => createTlsBuiltin(network, {");
    expect(loader).not.toContain('function dnsBuiltin');
    expect(dnsBuiltin).toContain('function createDnsBuiltin');
    expect(httpBuiltin).toContain('function createHttpBuiltin');
    expect(httpBuiltin).toContain("from '../http-1-wire-codec'");
    expect(httpBuiltin).not.toMatch(/MessagePort|postMessage|addEventListener\(['"]message/);
    expect(http2Builtin).toContain('function createHttp2Builtin');
    expect(http2Builtin).toContain('ENOTSUP');
    expect(netBuiltin).toContain('function createNodeNetworkBuiltin');
    expect(tlsBuiltin).toContain('function createTlsBuiltin');
    for (const source of [dnsBuiltin, httpBuiltin, http2Builtin, netBuiltin, tlsBuiltin]) {
      expect(source).not.toMatch(/hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
    }
  });

  test('keeps async_hooks ownership behind the Node Compatibility seam', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const builtinTable = readFileSync(nodeCompatibilitySource, 'utf8');
    const asyncHooksBuiltin = readFileSync('src/runtime/modules/node-compatibility/async-hooks.ts', 'utf8');

    expect(loader).toContain("from './execution-context-bootstrap'");
    expect(builtinTable).toContain("['async_hooks', createAsyncHooksBuiltin]");
    expect(asyncHooksBuiltin).toContain('function createAsyncHooksBuiltin');
    expect(asyncHooksBuiltin).not.toMatch(/preview|hmr|vite|package-manager|(?<!-)Mimic(?![-:])/i);
  });

  test('deletes the legacy Node builtin registry, bridge, loader switches, and generated preview globals', () => {
    const loader = readFileSync(executionContextRuntimeSource, 'utf8');
    const packageManifest = readFileSync('package.json', 'utf8');
    const domainSources = [
      'src/runtime/modules/virtual-file-system',
      'src/runtime/modules/virtual-network',
      'src/runtime/modules/worker-transport'
    ]
      .flatMap((directory) => readdirSync(directory).filter((name) => name.endsWith('.ts')).map((name) => `${directory}/${name}`))
      .map((path) => readFileSync(path, 'utf8'))
      .join('\n');

    expect(loader).not.toMatch(/node-stdlib|node-compatibility-migration-bridge/);
    expect(loader).not.toContain('private createBuiltin(');
    expect(existsSync('src/runtime/server-manager.ts')).toBe(false);
    expect(packageManifest).not.toContain('architecture/node-compatibility-migration-bridge.cjs');
    expect(domainSources).not.toMatch(
      /\b(?:EADDRINUSE|EAGAIN|EALREADY|ECANCELED|ECONNREFUSED|EEXIST|EINVAL|EIO|EISDIR|ELOOP|ENOENT|ENOTDIR|ENOTEMPTY|EPERM)\b|['"]node:/
    );
    expect(existsSync('src/runtime/node-stdlib')).toBe(false);
    expect(existsSync('src/runtime/node-compatibility-migration-bridge.ts')).toBe(false);
    expect(existsSync('src/runtime/preview-process-global.ts')).toBe(false);
    expect(existsSync('architecture/node-compatibility-migration-bridge.cjs')).toBe(false);
  });

  test('keeps generic loader modules free of unrelated runtime responsibilities', () => {
    const violations = genericLoaderSources.flatMap((sourcePath) => {
      const source = readFileSync(sourcePath, 'utf8');
      return forbiddenGenericLoaderPatterns.flatMap((rule) =>
        rule.pattern.test(source) && !rule.allowedSources.includes(sourcePath)
          ? [
              `${sourcePath}: ${rule.name} belongs in ${rule.owner}. ` +
                'Roadmap sections 14 and 16 require an owned module or quarantine adapter with deletion criteria, not generic loader code.'
            ]
          : []
      );
    });

    expect(violations).toEqual([]);
  });
});

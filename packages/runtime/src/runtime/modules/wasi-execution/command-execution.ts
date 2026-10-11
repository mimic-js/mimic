import { inspectCompiledWasiPreview1Executable } from './executable-inspection';
import {
  createWasiPreview1ExecutionFactory,
  type WasiByteWriter,
  type WasiStandardInput,
  type WasiSynchronousVfsPort
} from './wasi-execution';

export const WASI_PREVIEW1_RUNTIME_PROGRAM_ID = 'wasi-preview1';

export interface WasiPreview1CommandExecutionOptions {
  readonly bytes: ArrayBuffer;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly stdout: WasiByteWriter;
  readonly stderr: WasiByteWriter;
  readonly stdin: WasiStandardInput;
  readonly vfs: WasiSynchronousVfsPort;
}

export async function executeWasiPreview1Command(
  options: WasiPreview1CommandExecutionOptions
): Promise<number> {
  const module = await WebAssembly.compile(options.bytes);
  const inspection = inspectCompiledWasiPreview1Executable(module);
  if (inspection.kind !== 'supported') {
    throw new TypeError(
      inspection.kind === 'unsupported'
        ? inspection.message
        : 'Resolved WASI executable is no longer WebAssembly.'
    );
  }
  const execution = createWasiPreview1ExecutionFactory({
    process: {
      argv: options.args,
      env: options.env,
      stdout: options.stdout,
      stderr: options.stderr,
      exit: () => undefined
    },
    stdin: options.stdin,
    vfs: options.vfs
  })({
    version: 'preview1',
    args: options.args,
    env: options.env,
    preopens: { '/': '/' }
  });
  const instance = new WebAssembly.Instance(
    module,
    execution.getImportObject()
  );
  const result = execution.start(instance);
  return typeof result === 'number' ? result : 0;
}

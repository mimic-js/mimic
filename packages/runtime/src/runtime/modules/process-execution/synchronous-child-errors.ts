import type { ExecutableResolutionError } from './executable-resolution';
import type { ProcessExecutionErrorCode } from './process-execution';

export type ProcessExecutionSynchronousChildErrorCode =
  | ProcessExecutionErrorCode
  | ExecutableResolutionError['code']
  | 'EXECUTABLE_RESOLUTION_UNAVAILABLE'
  | 'EXECUTION_FAILED'
  | 'INPUT_FAILED'
  | 'OUTPUT_LIMIT_EXCEEDED'
  | 'PARENT_TERMINATED'
  | 'TIMEOUT';

const synchronousChildErrorCodes: ReadonlySet<string> = new Set([
  'CAPACITY_EXHAUSTED',
  'PARK_LIMIT_EXHAUSTED',
  'INVALID_CONTEXT',
  'INVALID_PARENT',
  'PROCESS_EXECUTION_CLOSED',
  'INVALID_WASM_EXECUTABLE',
  'WASI_EXECUTABLE_LIBRARY',
  'UNSUPPORTED_WASI_ABI',
  'UNKNOWN_WASI_IMPORT',
  'UNKNOWN_PROCESS',
  'EXECUTABLE_NOT_FOUND',
  'UNSUPPORTED_INTERPRETER',
  'RESOLUTION_CYCLE',
  'INVALID_INLINE_ENTRY',
  'EXECUTABLE_RESOLUTION_UNAVAILABLE',
  'EXECUTION_FAILED',
  'INPUT_FAILED',
  'OUTPUT_LIMIT_EXCEEDED',
  'PARENT_TERMINATED',
  'TIMEOUT'
] satisfies readonly ProcessExecutionSynchronousChildErrorCode[]);

export function isSynchronousChildErrorCode(
  value: unknown
): value is ProcessExecutionSynchronousChildErrorCode {
  return (
    typeof value === 'string' &&
    synchronousChildErrorCodes.has(value)
  );
}

export function normalizeSynchronousChildErrorCode(
  error: unknown
): ProcessExecutionSynchronousChildErrorCode {
  const code =
    error && typeof error === 'object' && 'code' in error
      ? error.code
      : undefined;
  return isSynchronousChildErrorCode(code) ? code : 'EXECUTION_FAILED';
}

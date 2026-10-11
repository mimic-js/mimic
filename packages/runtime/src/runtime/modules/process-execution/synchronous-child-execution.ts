import type {
  ProcessExecutionSynchronousChildRequest,
  ProcessExecutionSynchronousChildResult
} from './child-requests';
import {
  normalizeSynchronousChildErrorCode,
  type ProcessExecutionSynchronousChildErrorCode
} from './synchronous-child-errors';
import type {
  ProcessInput,
  ProcessWriter,
  RuntimeProgramProcess
} from './virtual-process';

export interface SynchronousChildProcessExecutionOptions {
  spawn(
    request: Pick<
      ProcessExecutionSynchronousChildRequest,
      'command' | 'args' | 'cwd' | 'env' | 'parentPid'
    >
  ): Promise<RuntimeProgramProcess>;
  readonly parentInput?: ProcessInput;
  readonly parentStdout: Pick<ProcessWriter, 'write'>;
  readonly parentStderr: Pick<ProcessWriter, 'write'>;
  readonly parentSignal?: Promise<'SIGTERM' | 'SIGKILL' | 'SIGINT'>;
  cancelWait(
    child: RuntimeProgramProcess,
    signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT'
  ): Promise<void>;
}

export async function executeSynchronousChildProcess(
  request: ProcessExecutionSynchronousChildRequest,
  options: SynchronousChildProcessExecutionOptions
): Promise<ProcessExecutionSynchronousChildResult> {
  const emptyOutput = () =>
    request.stdio.stdout === 'pipe' ? new Uint8Array() : null;
  const emptyError = () =>
    request.stdio.stderr === 'pipe' ? new Uint8Array() : null;
  let child: RuntimeProgramProcess;
  try {
    child = await options.spawn({
      command: request.command,
      args: request.args,
      cwd: request.cwd,
      env: request.env,
      parentPid: request.parentPid
    });
  } catch (error) {
    return {
      status: null,
      signal: null,
      stdout: emptyOutput(),
      stderr: emptyError(),
      error: executionError(error)
    };
  }

  let terminalError:
    | {
        readonly code: ProcessExecutionSynchronousChildErrorCode;
        readonly message: string;
      }
    | undefined;
  let terminalSignal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | null = null;
  const terminate = (
    signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT',
    error: {
      readonly code: ProcessExecutionSynchronousChildErrorCode;
      readonly message: string;
    }
  ): void => {
    if (terminalError) return;
    terminalError = error;
    terminalSignal = signal;
    child.kill(signal);
  };
  const outputAbort = new AbortController();
  const stdout = consumeOutput(
    child.stdout,
    request.stdio.stdout,
    options.parentStdout,
    request.maxBuffer,
    () =>
      terminate(request.killSignal, {
        code: 'OUTPUT_LIMIT_EXCEEDED',
        message: `Synchronous child output exceeded maxBuffer for ${request.command}.`
      }),
    outputAbort.signal
  );
  const stderr = consumeOutput(
    child.stderr,
    request.stdio.stderr,
    options.parentStderr,
    request.maxBuffer,
    () =>
      terminate(request.killSignal, {
        code: 'OUTPUT_LIMIT_EXCEEDED',
        message: `Synchronous child output exceeded maxBuffer for ${request.command}.`
      }),
    outputAbort.signal
  );
  const inputAbort = new AbortController();
  const input = supplyInput(
    child,
    request,
    options.parentInput,
    inputAbort.signal
  ).catch((error: unknown) => {
    if (inputAbort.signal.aborted) return;
    terminate(request.killSignal, {
      code: 'INPUT_FAILED',
      message: error instanceof Error ? error.message : String(error)
    });
  });
  const timeout =
    request.timeout > 0
      ? setTimeout(
          () =>
            terminate(request.killSignal, {
              code: 'TIMEOUT',
              message: `Synchronous child ${request.command} timed out.`
            }),
          request.timeout
        )
      : undefined;
  const childExited = child.exit.then((status) => ({
    type: 'exit' as const,
    status
  }));
  const parentTerminated = options.parentSignal?.then((signal) => ({
    type: 'parent-terminated' as const,
    signal
  }));

  try {
    const terminal = parentTerminated
      ? await Promise.race([childExited, parentTerminated])
      : await childExited;
    if (terminal.type === 'parent-terminated') {
      await options.cancelWait(child, terminal.signal);
      inputAbort.abort();
      outputAbort.abort();
      void Promise.allSettled([stdout, stderr, input]);
      return {
        pid: child.pid,
        status: null,
        signal: null,
        stdout: emptyOutput(),
        stderr: emptyError(),
        error: {
          code: 'PARENT_TERMINATED',
          message: `Synchronous child wait was canceled with ${terminal.signal}.`
        }
      };
    }
    inputAbort.abort();
    const [capturedStdout, capturedStderr] = await Promise.all([
      stdout,
      stderr
    ]);
    return {
      pid: child.pid,
      status: terminalError ? null : terminal.status,
      signal: terminalSignal,
      stdout: capturedStdout,
      stderr: capturedStderr,
      ...(terminalError ? { error: terminalError } : {})
    };
  } catch (error) {
    return {
      pid: child.pid,
      status: null,
      signal: terminalSignal,
      stdout: await settledOutput(stdout, emptyOutput()),
      stderr: await settledOutput(stderr, emptyError()),
      error: terminalError ?? executionError(error)
    };
  } finally {
    inputAbort.abort();
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

async function supplyInput(
  child: RuntimeProgramProcess,
  request: ProcessExecutionSynchronousChildRequest,
  inherited: ProcessInput | undefined,
  signal: AbortSignal
): Promise<void> {
  const writer = child.stdin.getWriter();
  try {
    if (request.stdio.stdin === 'pipe') {
      if (request.input.byteLength > 0) await writer.write(request.input);
    } else if (request.stdio.stdin === 'inherit' && inherited) {
      while (true) {
        const chunk = await inherited.read({ signal });
        if (!chunk) break;
        await writer.write(chunk);
      }
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    if (signal.aborted) return;
    throw error;
  }
}

async function consumeOutput(
  stream: ReadableStream<Uint8Array>,
  mode: 'pipe' | 'inherit' | 'ignore',
  inherited: Pick<ProcessWriter, 'write'>,
  maxBuffer: number,
  onOverflow: () => void,
  signal: AbortSignal
): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let overflowed = false;
  while (true) {
    if (signal.aborted) {
      await reader.cancel();
      break;
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (signal.aborted) {
      await reader.cancel();
      break;
    }
    if (mode === 'inherit') {
      await inherited.write(value);
      continue;
    }
    if (mode === 'ignore' || overflowed) continue;
    const remaining = Math.max(0, maxBuffer - length);
    if (remaining > 0) {
      const copy = value.slice(0, remaining);
      chunks.push(copy);
      length += copy.byteLength;
    }
    if (value.byteLength > remaining) {
      overflowed = true;
      onOverflow();
    }
  }
  if (mode !== 'pipe') return null;
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

async function settledOutput(
  output: Promise<Uint8Array | null>,
  fallback: Uint8Array | null
): Promise<Uint8Array | null> {
  try {
    return await output;
  } catch {
    return fallback;
  }
}

function executionError(error: unknown): {
  readonly code: ProcessExecutionSynchronousChildErrorCode;
  readonly message: string;
} {
  return {
    code: normalizeSynchronousChildErrorCode(error),
    message: error instanceof Error ? error.message : String(error)
  };
}

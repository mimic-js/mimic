import type { ProcessInput, ProcessWriter } from './virtual-process';

export async function pipeProcessInput(
  source: ProcessInput | undefined,
  destination: WritableStream<Uint8Array>,
  options: { readonly signal?: AbortSignal } = {}
): Promise<void> {
  const writer = destination.getWriter();
  try {
    if (source) {
      while (true) {
        const chunk = await source.read({ signal: options.signal });
        if (!chunk) break;
        await writer.write(chunk);
      }
    }
    await writer.close();
  } catch (error) {
    await writer.abort(error).catch(() => undefined);
    if (options.signal?.aborted) return;
    throw error;
  } finally {
    writer.releaseLock();
  }
}

export async function pipeProcessOutput(
  source: ReadableStream<Uint8Array>,
  destination: ProcessWriter
): Promise<void> {
  const reader = source.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      await destination.write(value);
    }
  } finally {
    reader.releaseLock();
  }
}

export const closedProcessInput: ProcessInput = {
  read: async () => undefined
};

export function readableProcessInput(
  source: ReadableStream<Uint8Array>
): ProcessInput {
  const reader = source.getReader();
  let closed = false;
  return {
    async read() {
      if (closed) return undefined;
      const { done, value } = await reader.read();
      if (done) {
        closed = true;
        reader.releaseLock();
        return undefined;
      }
      return value;
    }
  };
}

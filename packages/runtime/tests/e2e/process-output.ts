import type { MimicProcess } from '../../src/runtime';

type ProcessStreams = Pick<MimicProcess, 'stdout' | 'stderr'>;

export type CollectedProcessOutput = Readonly<{
  done: Promise<string>;
  text(): string;
}>;

export function collectProcessOutput(
  process: ProcessStreams,
  onChunk?: (chunk: string, stream: 'stdout' | 'stderr') => void
): CollectedProcessOutput {
  let text = '';
  const done = Promise.all([
    readStream(process.stdout, 'stdout'),
    readStream(process.stderr, 'stderr')
  ]).then(() => text);
  return { done, text: () => text };

  async function readStream(
    output: ReadableStream<Uint8Array>,
    stream: 'stdout' | 'stderr'
  ): Promise<void> {
    const reader = output.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        const chunk = decoder.decode(value, { stream: !done });
        text += chunk;
        if (chunk) onChunk?.(chunk, stream);
        if (done) return;
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/**
 * One stream of a process's standard output and error, chunk by chunk as
 * they arrive, as a terminal shows them. Both streams are read eagerly.
 */
export function mergeProcessOutput(process: ProcessStreams): ReadableStream<Uint8Array> {
  const readers = [process.stdout.getReader(), process.stderr.getReader()];
  let open = readers.length;
  let settled = false;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const reader of readers) {
        void (async () => {
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              if (!settled) controller.enqueue(value);
            }
            open -= 1;
            if (open === 0 && !settled) {
              settled = true;
              controller.close();
            }
          } catch (error) {
            if (settled) return;
            settled = true;
            controller.error(error);
          }
        })();
      }
    },
    async cancel(reason) {
      settled = true;
      await Promise.all(readers.map((reader) => reader.cancel(reason)));
    }
  });
}

export async function runProcessToExit(
  process: MimicProcess,
  description: string,
  timeoutMs: number
): Promise<Readonly<{ exitCode: number; output: string }>> {
  const output = collectProcessOutput(process);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const exitCode = await Promise.race([
      process.exit,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          process.kill('SIGTERM');
          reject(new Error(`${description} timed out after ${timeoutMs}ms:\n${output.text()}`));
        }, timeoutMs);
      })
    ]);
    return { exitCode, output: await output.done };
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export type ProcessReadiness = Readonly<{
  started: boolean;
  output: string;
  exitCode?: number;
}>;

export async function waitForProcessReadiness(
  process: MimicProcess,
  output: () => string,
  readiness: RegExp,
  timeoutMs: number
): Promise<ProcessReadiness> {
  const exit = process.exit.then((exitCode) => ({ started: false as const, output: output(), exitCode }));
  const ready = (async () => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const current = output();
      const plain = current.replace(/\u001b\[[0-9;]*m/g, '');
      if (readiness.test(plain)) return { started: true as const, output: current };
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return { started: false as const, output: output() };
  })();
  return Promise.race([exit, ready]);
}

export async function terminateProcess(process: MimicProcess): Promise<void> {
  process.kill('SIGTERM');
  const stopped = await Promise.race([
    process.exit.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 5_000))
  ]);
  if (!stopped) {
    process.kill('SIGKILL');
    await process.exit;
  }
}

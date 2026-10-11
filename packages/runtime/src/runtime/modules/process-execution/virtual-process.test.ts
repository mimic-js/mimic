import { expect, test } from 'vitest';

import { createVirtualProcess } from './virtual-process';

test('public process streams preserve binary stdin, stdout, and stderr with backpressure', async () => {
  const stdinChunk = new Uint8Array(128 * 1024);
  stdinChunk.set([0, 255, 128, 10, 13, 42]);
  const stdoutChunk = new Uint8Array(128 * 1024);
  stdoutChunk.set([0, 255, 1, 2, 128]);
  const stderrChunk = new Uint8Array([3, 4, 254, 0, 129]);
  let releaseStdin!: () => void;
  const stdinMayDrain = new Promise<void>((resolve) => {
    releaseStdin = resolve;
  });
  let observedStdin: Uint8Array | undefined;
  let stdoutDrained = false;

  const process = createVirtualProcess(
    7,
    async (stdout, stdin, stderr) => {
      await stdinMayDrain;
      observedStdin = await stdin.read();
      await stdout.write(stdoutChunk);
      stdoutDrained = true;
      await stderr.write(stderrChunk);
      return 0;
    }
  );
  const stdin = process.stdin.getWriter();
  const stdinWrite = stdin.write(stdinChunk);
  let stdinWriteSettled = false;
  void stdinWrite.then(() => {
    stdinWriteSettled = true;
  });
  await Promise.resolve();
  expect(stdinWriteSettled).toBe(false);

  releaseStdin();
  await stdinWrite;
  await stdin.close();
  expect(observedStdin).toEqual(stdinChunk);

  await Promise.resolve();
  expect(stdoutDrained).toBe(false);

  const [stdout, stderr] = await Promise.all([
    readAll(process.stdout),
    readAll(process.stderr)
  ]);
  await expect(process.exit).resolves.toBe(0);
  const legacyOutput = await readAll(process.output);
  expect(stdout).toEqual(stdoutChunk);
  expect(stderr).toEqual(stderrChunk);
  expect(legacyOutput.byteLength).toBe(64 * 1024);
});

test('process exit settles after both output streams close', async () => {
  const order: string[] = [];
  const process = createVirtualProcess(
    8,
    async (stdout, _stdin, stderr) => {
      await stdout.write(new Uint8Array([1]));
      await stderr.write(new Uint8Array([2]));
      return 23;
    }
  );
  const stdout = readAll(process.stdout).then(() => order.push('stdout'));
  const stderr = readAll(process.stderr).then(() => order.push('stderr'));
  const exit = process.exit.then((code) => {
    order.push('exit');
    return code;
  });

  await expect(Promise.all([stdout, stderr, exit])).resolves.toEqual([1, 2, 23]);
  expect(order).toEqual(['stdout', 'stderr', 'exit']);
});

test('process crash releases pending stdin backpressure and errors output streams', async () => {
  let keepRunning!: () => void;
  const running = new Promise<void>((resolve) => {
    keepRunning = resolve;
  });
  const process = createVirtualProcess(9, async () => {
    await running;
    return 0;
  });
  const stdin = process.stdin.getWriter();
  const pendingWrite = stdin.write(new Uint8Array(128 * 1024));
  const exit = process.exit;
  const stdoutRead = process.stdout.getReader().read();
  const stderrRead = process.stderr.getReader().read();
  await Promise.resolve();

  process.crash(new Error('execution context failed'));

  await expect(pendingWrite).resolves.toBeUndefined();
  await expect(exit).rejects.toThrow('execution context failed');
  await expect(stdoutRead).rejects.toThrow('execution context failed');
  await expect(stderrRead).rejects.toThrow('execution context failed');
  keepRunning();
});

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.byteLength;
  }
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

test('a process reports the signal that ended it, and not one its program handled before exiting', async () => {
  const handling = createVirtualProcess(3, (writer) =>
    new Promise<number>((resolve) => {
      writer.onSignal!(() => setTimeout(() => resolve(0), 5));
    })
  );
  const ended = createVirtualProcess(4, (writer) => writer.waitForKill().then(() => 143));
  await Promise.resolve();
  handling.kill('SIGTERM');
  ended.kill('SIGTERM');

  await expect(handling.termination).resolves.toEqual({ code: 0, signal: null });
  await expect(ended.termination).resolves.toEqual({ code: 143, signal: 'SIGTERM' });
});

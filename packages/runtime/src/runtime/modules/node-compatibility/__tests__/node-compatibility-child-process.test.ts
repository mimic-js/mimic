import { describe, expect, test, vi } from 'vitest';

import { createChildProcessBuiltin } from '../child-process';
import { EventEmitter } from '../events';
import { nodeStream } from '../streams';
import type {
  ChildProcessExecutionPort,
  ProcessExecutionChildHandle,
  SynchronousChildProcessExecutionPort
} from '../child-process';
import type {
  ProcessExecutionChildRequest,
  ProcessExecutionSynchronousChildRequest,
  ProcessExecutionSynchronousChildResult
} from '../../process-execution';

describe('Node Compatibility child_process adapter', () => {
  test('settles shared stream.finished for a normally ended child stdin', async () => {
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 72,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exit: new Promise(() => undefined)
      }),
      signal: async () => true
    };
    const stream = nodeStream;
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    const completed = new Promise<Error | null>((resolve) => {
      if (!child.stdin) throw new Error('Expected piped child stdin.');
      stream.finished(child.stdin, (error) => resolve(error ?? null));
    });

    child.stdin?.end('done');

    await expect(completed).resolves.toBeNull();
  });

  test('runs a shell spawn through sh -c and accepts a detached process group', async () => {
    const requests: Array<{ command: string; args: readonly string[] }> = [];
    const port: ChildProcessExecutionPort = {
      spawn: async (request: { command: string; args: readonly string[] }) => {
        requests.push({ command: request.command, args: request.args });
        return {
          pid: 7,
          stdin: new WritableStream<Uint8Array>(),
          stdout: new ReadableStream<Uint8Array>(),
          stderr: new ReadableStream<Uint8Array>(),
          exit: new Promise(() => undefined)
        };
      },
      signal: async () => true
    };
    const childProcess = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port });
    // Nx's run-commands executor spawns every task this way.
    const child = childProcess.spawn('tsc --build', ['tsconfig.lib.json'], { shell: true, detached: true });
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    expect(requests).toEqual([{ command: 'sh', args: ['-c', 'tsc --build tsconfig.lib.json'] }]);
  });

  test('execFile and exec hand the whole output of a spawn to their callback', async () => {
    const requests: Array<{ command: string; args: readonly string[] }> = [];
    const outputOf = (text: string) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        }
      });
    const port = {
      spawn: async (request: { command: string; args: readonly string[] }) => {
        requests.push({ command: request.command, args: request.args });
        if (request.command === 'watchman') {
          throw Object.assign(new Error('Executable program was not found: watchman'), {
            code: 'EXECUTABLE_NOT_FOUND'
          });
        }
        const failing = request.args.includes('--fail');
        return {
          pid: 7,
          stdin: new WritableStream<Uint8Array>(),
          stdout: outputOf('out'),
          stderr: outputOf(failing ? 'bad flag' : ''),
          exit: Promise.resolve({ code: failing ? 2 : 0, signal: null })
        };
      },
      signal: async () => true
    };
    const childProcess = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port });
    const run = (start: (callback: (...values: unknown[]) => void) => unknown) =>
      new Promise<unknown[]>((resolve) => start((...values) => resolve(values)));

    await expect(run((callback) => childProcess.execFile('tool', ['--version'], callback))).resolves.toEqual([
      null,
      'out',
      ''
    ]);
    const [failure, , stderr] = await run((callback) => childProcess.execFile('tool', ['--fail'], {}, callback));
    expect(failure).toMatchObject({ code: 2, signal: null, cmd: 'tool --fail' });
    expect(stderr).toBe('bad flag');
    await run((callback) => childProcess.exec('tool | wc -l', callback));
    expect(requests.at(-1)).toEqual({ command: 'sh', args: ['-c', 'tool | wc -l'] });

    const [missing] = await run((callback) => childProcess.execFile('watchman', ['version'], callback));
    expect(missing).toMatchObject({
      code: 'ENOENT',
      errno: -2,
      syscall: 'spawn watchman',
      path: 'watchman',
      message: 'spawn watchman ENOENT'
    });
  });

  test('projects spawnSync results and execFileSync failures without changing Process Execution semantics', () => {
    const port = new FakeProcessExecutionPort();
    const synchronousPort = new FakeSynchronousProcessExecutionPort([
      {
        pid: 91,
        status: 0,
        signal: null,
        stdout: new TextEncoder().encode('child-output'),
        stderr: new TextEncoder().encode('child-error')
      },
      {
        pid: 92,
        status: 7,
        signal: null,
        stdout: new TextEncoder().encode('failed-output'),
        stderr: new TextEncoder().encode('failed-error')
      },
      {
        pid: 93,
        status: 0,
        signal: null,
        stdout: new TextEncoder().encode('shelled'),
        stderr: new Uint8Array()
      }
    ]);
    const childProcess = createChildProcessBuiltin({
      cwd: '/home/project',
      env: { HOME: '/home/browser', PATH: '/bin' },
      parentPid: 41,
      port,
      synchronousPort
    });

    const spawned = childProcess.spawnSync('node', ['child.mjs'], {
      cwd: '/home/project/nested',
      env: { MODE: 'test' },
      input: 'child-input',
      encoding: 'utf8',
      timeout: 25,
      killSignal: 'SIGINT',
      maxBuffer: 64,
      stdio: 'pipe'
    });

    expect(synchronousPort.requests[0]).toEqual({
      command: 'node',
      args: ['child.mjs'],
      cwd: '/home/project/nested',
      env: { MODE: 'test' },
      input: new TextEncoder().encode('child-input'),
      killSignal: 'SIGINT',
      maxBuffer: 64,
      parentPid: 41,
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      timeout: 25
    });
    expect(spawned).toEqual({
      pid: 91,
      status: 0,
      signal: null,
      stdout: 'child-output',
      stderr: 'child-error',
      output: [null, 'child-output', 'child-error']
    });

    expect(() =>
      childProcess.execFileSync('node', ['failed.mjs'], {
        encoding: 'utf8'
      })
    ).toThrowError(
      expect.objectContaining({
        pid: 92,
        status: 7,
        signal: null,
        stdout: 'failed-output',
        stderr: 'failed-error',
        output: [null, 'failed-output', 'failed-error']
      })
    );
    expect(childProcess.execSync('echo shelled | cat', { encoding: 'utf8' })).toBe('shelled');
    expect(synchronousPort.requests.at(-1)).toMatchObject({ command: 'sh', args: ['-c', 'echo shelled | cat'] });
  });

  test('uses the selected Node encoding for synchronous string input and output', () => {
    const synchronousPort = new FakeSynchronousProcessExecutionPort([
      {
        pid: 91,
        status: 0,
        signal: null,
        stdout: new Uint8Array([0xe9, 0x41]),
        stderr: new Uint8Array([0xa9, 0x03])
      }
    ]);
    const childProcess = createChildProcessBuiltin({
      cwd: '/home/project',
      env: {},
      parentPid: 41,
      port: new FakeProcessExecutionPort(),
      synchronousPort
    });

    const result = childProcess.spawnSync('node', [], {
      input: 'éΩ',
      encoding: 'latin1'
    });

    expect(synchronousPort.requests[0]?.input).toEqual(
      new Uint8Array([0xe9, 0xa9])
    );
    expect(result.stdout).toBe('éA');
    expect(result.stderr).toBe('©\u0003');
  });

  test('writes a synchronous child\'s output to the streams its stdio names, as ngcc\'s parent asks', () => {
    const synchronousPort = new FakeSynchronousProcessExecutionPort([
      {
        pid: 92,
        status: 0,
        signal: null,
        stdout: new TextEncoder().encode('compiled\n'),
        stderr: new TextEncoder().encode('warning\n')
      }
    ]);
    const childProcess = createChildProcessBuiltin({
      cwd: '/home/project',
      env: {},
      parentPid: 41,
      port: new FakeProcessExecutionPort(),
      synchronousPort
    });
    const written: string[] = [];
    const parentStderr = { write: (chunk: Uint8Array) => written.push(new TextDecoder().decode(chunk)) };

    const result = childProcess.spawnSync('node', ['ngcc'], { stdio: ['inherit', parentStderr, parentStderr] });

    expect(synchronousPort.requests[0]?.stdio).toEqual({ stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' });
    expect(written).toEqual(['compiled\n', 'warning\n']);
    expect(result).toMatchObject({ status: 0, stdout: null, stderr: null });
  });

  test('preserves ordinary command-not-found failures as Node-shaped ENOENT', () => {
    const missing = {
      status: null,
      signal: null,
      stdout: new Uint8Array(),
      stderr: new Uint8Array(),
      error: {
        code: 'EXECUTABLE_NOT_FOUND' as const,
        message: 'Executable program was not found: missing-command'
      }
    };
    const childProcess = createChildProcessBuiltin({
      cwd: '/home/project',
      env: {},
      parentPid: 41,
      port: new FakeProcessExecutionPort(),
      synchronousPort: new FakeSynchronousProcessExecutionPort([
        missing,
        missing
      ])
    });

    expect(childProcess.spawnSync('missing-command').error).toMatchObject({
      code: 'ENOENT'
    });
    expect(() => childProcess.execFileSync('missing-command')).toThrowError(
      expect.objectContaining({ code: 'ENOENT' })
    );
  });

  test('adapts a child request with inherited execution identity and Node lifecycle events', async () => {
    const port = new FakeProcessExecutionPort();
    const childProcess = createChildProcessBuiltin({
      cwd: '/home/project',
      env: { HOME: '/home/browser', PATH: '/bin' },
      parentPid: 41,
      port
    });
    const child = childProcess.spawn('/usr/bin/node', ['child.mjs', '--inspect'], {
      cwd: '/home/project/packages/app',
      env: { MODE: 'test' }
    });
    const events: string[] = [];
    const output: string[] = [];
    child.on('spawn', () => events.push('spawn'));
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    child.on('exit', (code, signal) => events.push(`exit:${code}:${signal}`));
    child.on('close', (code, signal) => events.push(`close:${code}:${signal}`));

    const handle = await port.waitForSpawn();
    expect(port.requests).toEqual([
      {
        command: '/usr/bin/node',
        args: ['child.mjs', '--inspect'],
        cwd: '/home/project/packages/app',
        env: { MODE: 'test' },
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        parentPid: 41
      }
    ]);
    expect(child.pid).toBe(handle.pid);

    await handle.writeStdout('child-ready\n');
    await handle.close(0);
    await waitFor(() => events.includes('close:0:null'));

    expect(output).toEqual(['child-ready\n']);
    expect(events).toEqual(['spawn', 'exit:0:null', 'close:0:null']);
    expect(child.exitCode).toBe(0);
    expect(child.signalCode).toBeNull();
  });

  test('an error a close listener throws is an uncaught exception of the process, not a lost one', async () => {
    // node-pre-gyp continues its build from a 'close' listener; what it throws there must surface.
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node-gyp', ['clean']);
    const thrown = new Error('next step failed');
    child.on('close', () => {
      throw thrown;
    });
    const reported: unknown[] = [];
    const queueMicrotask = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (callback) =>
      queueMicrotask(() => {
        try {
          callback();
        } catch (error) {
          reported.push(error);
        }
      });
    try {
      const handle = await port.waitForSpawn();
      await handle.close(0);
      await waitFor(() => reported.length > 0);
    } finally {
      globalThis.queueMicrotask = queueMicrotask;
    }

    expect(reported).toEqual([thrown]);
    expect(child.exitCode).toBe(0);
  });

  test('streams multibyte text across output chunks when an encoding is selected', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const output: string[] = [];
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));

    const handle = await port.waitForSpawn();
    await handle.writeStdoutBytes(Uint8Array.of(0xe2));
    await handle.writeStdoutBytes(Uint8Array.of(0x82));
    await handle.writeStdoutBytes(Uint8Array.of(0xac));
    await handle.close(0);
    await waitFor(() => child.exitCode === 0);

    expect(output).toEqual(['€']);
  });

  test('uses the context cwd and environment defaults when spawn omits options', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({
      cwd: '/home/project',
      env: { HOME: '/home/browser', PATH: '/project/node_modules/.bin:/bin' },
      parentPid: 17,
      port
    }).spawn('tool');

    const handle = await port.waitForSpawn();

    expect(port.requests).toEqual([
      {
        command: 'tool',
        args: [],
        cwd: '/home/project',
        env: { HOME: '/home/browser', PATH: '/project/node_modules/.bin:/bin' },
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        parentPid: 17
      }
    ]);
    expect(child.pid).toBe(handle.pid);
    await handle.close(0);
  });

  test('projects child signals to the authority without allocating local process state', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 5, port }).spawn('node', ['app.mjs']);
    const handle = await port.waitForSpawn();

    expect(child.kill('SIGINT')).toBe(true);
    await waitFor(() => port.signals.length === 1);
    expect(port.signals).toEqual([{ pid: handle.pid, signal: 'SIGINT' }]);
    expect(child.killed).toBe(true);

    await handle.close(130, 'SIGINT');
    await waitFor(() => child.signalCode === 'SIGINT');
    expect(child.exitCode).toBeNull();
    expect(child.kill()).toBe(false);
  });

  test('delivers a signal requested by a spawn listener exactly once', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 5, port }).spawn('node', ['app.mjs']);
    child.on('spawn', () => child.kill('SIGTERM'));

    const handle = await port.waitForSpawn();
    await waitFor(() => port.signals.length === 1);
    await Promise.resolve();

    expect(port.signals).toEqual([{ pid: handle.pid, signal: 'SIGTERM' }]);
    await handle.close(143, 'SIGTERM');
  });

  test('reports an authority signal failure without inventing terminal child state', async () => {
    const port = new FakeProcessExecutionPort();
    port.signalFailure = Object.assign(new Error('signal transport failed'), { code: 'ERR_SIGNAL_TRANSPORT' });
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 5, port }).spawn('node');
    const errors: Error[] = [];
    child.on('error', (error) => errors.push(error as Error));
    const handle = await port.waitForSpawn();

    expect(child.kill('SIGINT')).toBe(true);
    await waitFor(() => errors.length === 1);

    expect(errors[0]).toMatchObject({ code: 'ERR_SIGNAL_TRANSPORT', message: 'signal transport failed' });
    expect(child.exitCode).toBeNull();
    expect(child.killed).toBe(false);

    await handle.close(0);
    await waitFor(() => child.exitCode === 0);
  });

  test('emits an authority spawn failure as a Node-shaped error', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('missing-command');
    const failure = new Error('Execution Capacity 1 is exhausted.');
    Object.assign(failure, { code: 'CAPACITY_EXHAUSTED' });
    const errors: Error[] = [];
    child.on('error', (error) => errors.push(error as Error));

    port.rejectSpawn(failure);
    await waitFor(() => errors.length === 1);

    expect(errors[0]).toMatchObject({ code: 'EAGAIN', message: 'Execution Capacity 1 is exhausted.' });
    expect(child.pid).toBeUndefined();
    expect(child.exitCode).toBe(1);
  });

  test('fails stdin writes queued before an admission rejection', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('missing-command');
    const callbackErrors: Error[] = [];
    child.on('error', () => undefined);
    child.stdin?.on('error', () => undefined);
    child.stdin?.write('queued-before-admission', (error) => {
      if (error) callbackErrors.push(error);
    });
    const failure = Object.assign(new Error('admission rejected'), { code: 'CAPACITY_EXHAUSTED' });

    port.rejectSpawn(failure);
    await waitFor(() => callbackErrors.length === 1);

    expect(callbackErrors[0]).toMatchObject({ code: 'EAGAIN', message: 'admission rejected' });
  });

  test('settles stdin.end callbacks when admission fails', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('missing-command');
    const callbackErrors: Error[] = [];
    child.on('error', () => undefined);
    child.stdin?.end('final-input', (error) => {
      if (error) callbackErrors.push(error);
    });
    const failure = Object.assign(new Error('admission rejected'), { code: 'CAPACITY_EXHAUSTED' });

    port.rejectSpawn(failure);
    await waitFor(() => callbackErrors.length === 1);

    expect(callbackErrors[0]).toMatchObject({ code: 'EAGAIN', message: 'admission rejected' });
  });

  test('observes rejected stream cleanup operations', async () => {
    const abortFailure = Object.assign(new Error('stdin abort failed'), { code: 'ERR_ABORT' });
    const cancelFailure = Object.assign(new Error('stdout cancel failed'), { code: 'ERR_CANCEL' });
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 99,
        stdin: new WritableStream<Uint8Array>({
          abort: () => Promise.reject(abortFailure)
        }),
        stdout: new ReadableStream<Uint8Array>({
          cancel: () => Promise.reject(cancelFailure)
        }),
        stderr: new ReadableStream<Uint8Array>(),
        exit: new Promise(() => undefined)
      }),
      signal: async () => true
    };
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const errors: Error[] = [];
    child.stdin?.on('error', (error) => errors.push(error as Error));
    child.stdout?.on('error', (error) => errors.push(error as Error));
    await new Promise<void>((resolve) => child.once('spawn', resolve));

    child.stdin?.destroy();
    child.stdout?.destroy();
    await waitFor(() => errors.length === 2);

    expect(errors).toEqual([
      expect.objectContaining({ code: 'ERR_ABORT', message: 'stdin abort failed' }),
      expect.objectContaining({ code: 'ERR_CANCEL', message: 'stdout cancel failed' })
    ]);
  });

  test('cancels streams that arrive after the Node projection was destroyed', async () => {
    let admit!: (handle: ProcessExecutionChildHandle) => void;
    const admission = new Promise<ProcessExecutionChildHandle>((resolve) => {
      admit = resolve;
    });
    const stdinAbort = vi.fn();
    const stdoutCancel = vi.fn();
    const port: ChildProcessExecutionPort = {
      spawn: () => admission,
      signal: async () => true
    };
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    child.stdin?.destroy();
    child.stdout?.destroy();

    admit({
      pid: 101,
      stdin: new WritableStream<Uint8Array>({ abort: stdinAbort }),
      stdout: new ReadableStream<Uint8Array>({ cancel: stdoutCancel }),
      stderr: new ReadableStream<Uint8Array>(),
      exit: new Promise(() => undefined)
    });
    await waitFor(() => stdinAbort.mock.calls.length === 1 && stdoutCancel.mock.calls.length === 1);

    expect(stdinAbort).toHaveBeenCalledOnce();
    expect(stdoutCancel).toHaveBeenCalledOnce();
  });

  test('settles a blocked stdin write exactly once when destroyed concurrently', async () => {
    let resolveWrite!: () => void;
    const blockedWrite = new Promise<void>((resolve) => {
      resolveWrite = resolve;
    });
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 104,
        stdin: new WritableStream<Uint8Array>({ write: () => blockedWrite }),
        stdout: new ReadableStream<Uint8Array>(),
        stderr: new ReadableStream<Uint8Array>(),
        exit: new Promise(() => undefined)
      }),
      signal: async () => true
    };
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const callbackResults: Array<string | null> = [];
    const closes: string[] = [];
    child.stdin?.on('error', () => undefined);
    child.stdin?.on('close', () => closes.push('close'));
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    child.stdin?.write('blocked', (error) => callbackResults.push(error?.message ?? null));
    await Promise.resolve();

    child.stdin?.destroy();
    resolveWrite();
    await waitFor(() => callbackResults.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(callbackResults).toEqual(['Child process stdin is closed.']);
    expect(closes).toEqual(['close']);
  });

  test('closes a destroyed output immediately but waits for late stream cancellation before child close', async () => {
    let admit!: (handle: ProcessExecutionChildHandle) => void;
    let resolveCancel!: () => void;
    const admission = new Promise<ProcessExecutionChildHandle>((resolve) => {
      admit = resolve;
    });
    const cancellation = new Promise<void>((resolve) => {
      resolveCancel = resolve;
    });
    const port: ChildProcessExecutionPort = {
      spawn: () => admission,
      signal: async () => true
    };
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const outputCloses: string[] = [];
    const childCloses: string[] = [];
    child.stdout?.on('close', () => outputCloses.push('close'));
    child.on('close', () => childCloses.push('close'));

    child.stdout?.destroy();
    await waitFor(() => outputCloses.length === 1);
    expect(outputCloses).toEqual(['close']);

    admit({
      pid: 102,
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({ cancel: () => cancellation }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exit: Promise.resolve({ code: 0, signal: null })
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(childCloses).toEqual([]);

    resolveCancel();
    await waitFor(() => childCloses.length === 1);
    expect(child.exitCode).toBe(0);
  });

  test('emits error then close when an attached output stream fails', async () => {
    const failure = Object.assign(new Error('output transport failed'), { code: 'ERR_OUTPUT' });
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 103,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>({
          pull: () => {
            throw failure;
          }
        }),
        stderr: new ReadableStream<Uint8Array>(),
        exit: new Promise(() => undefined)
      }),
      signal: async () => true
    };
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const events: string[] = [];
    child.stdout?.on('error', (error) => events.push(`error:${String((error as Error & { code?: string }).code)}`));
    child.stdout?.on('close', () => events.push('close'));

    await waitFor(() => events.includes('close'));
    expect(events).toEqual(['error:ERR_OUTPUT', 'close']);
    expect(child.stdout?.readable).toBe(false);
    expect(child.stdout?.readableEnded).toBe(false);
  });

  test('buffers output for delayed listeners and honors pause and resume', async () => {
    const port = new FakeProcessExecutionPort();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const handle = await port.waitForSpawn();
    await handle.writeStdout('before-listener');
    const output: string[] = [];
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => output.push(String(chunk)));
    await waitFor(() => output.length === 1);

    child.stdout?.pause();
    await handle.writeStdout('-paused');
    await Promise.resolve();
    expect(output).toEqual(['before-listener']);

    child.stdout?.resume();
    await waitFor(() => output.length === 2);
    expect(output).toEqual(['before-listener', '-paused']);
    await handle.close(0);
  });

  test('does not settle child close while unread output is paused at the high-water mark', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024);
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 105,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls <= 5) controller.enqueue(chunk);
            else controller.close();
          }
        }),
        stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        exit: Promise.resolve({ code: 0, signal: null })
      }),
      signal: async () => true
    };
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const closes: string[] = [];
    const output: Uint8Array[] = [];
    child.on('close', () => closes.push('close'));
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(pulls).toBeLessThanOrEqual(6);
    expect(closes).toEqual([]);
    expect(child.stdout?.readable).toBe(true);
    expect(child.stdout?.readableEnded).toBe(false);

    child.stdout?.on('data', (value) => output.push(value as Uint8Array));
    await waitFor(() => closes.length === 1);

    expect(output).toHaveLength(5);
    expect(child.stdout?.readableEnded).toBe(true);
  });

  test('keeps piped output paused until every active destination releases backpressure', async () => {
    let pulls = 0;
    const chunk = new Uint8Array(16 * 1024);
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 106,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            if (pulls <= 5) controller.enqueue(chunk);
            else controller.close();
          }
        }),
        stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
        exit: Promise.resolve({ code: 0, signal: null })
      }),
      signal: async () => true
    };
    class BackpressuredDestination extends EventEmitter {
      readonly chunks: unknown[] = [];
      readonly end = vi.fn();
      write(value: unknown): boolean {
        this.chunks.push(value);
        return this.chunks.length !== 1;
      }
    }
    const closingDestination = new BackpressuredDestination();
    const drainingDestination = new BackpressuredDestination();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    const closes: string[] = [];
    child.on('close', () => closes.push('close'));
    child.stdout?.pipe(closingDestination);
    child.stdout?.pipe(drainingDestination);
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(closingDestination.chunks).toHaveLength(1);
    expect(drainingDestination.chunks).toHaveLength(1);
    expect(closes).toEqual([]);
    expect(pulls).toBeLessThanOrEqual(6);

    closingDestination.emit('close');
    await Promise.resolve();
    expect(drainingDestination.chunks).toHaveLength(1);
    expect(closes).toEqual([]);

    drainingDestination.emit('drain');
    await waitFor(() => closes.length === 1);

    expect(closingDestination.chunks).toHaveLength(1);
    expect(closingDestination.end).not.toHaveBeenCalled();
    expect(drainingDestination.chunks).toHaveLength(5);
    expect(drainingDestination.end).toHaveBeenCalledOnce();
  });

  test('returns to bounded buffering when the sole destination closes without backpressure', async () => {
    let pulls = 0;
    const port: ChildProcessExecutionPort = {
      spawn: async () => ({
        pid: 107,
        stdin: new WritableStream<Uint8Array>(),
        stdout: new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1;
            controller.enqueue(new Uint8Array(16 * 1024));
          }
        }),
        stderr: new ReadableStream<Uint8Array>(),
        exit: new Promise(() => undefined)
      }),
      signal: async () => true
    };
    class ClosingDestination extends EventEmitter {
      readonly chunks: unknown[] = [];
      write(value: unknown): boolean {
        this.chunks.push(value);
        queueMicrotask(() => this.emit('close'));
        return true;
      }
    }
    const destination = new ClosingDestination();
    const child = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port }).spawn('node');
    child.stdout?.pipe(destination);
    await new Promise<void>((resolve) => child.once('spawn', resolve));
    for (let turn = 0; turn < 10; turn += 1) await Promise.resolve();

    expect(destination.chunks).toHaveLength(1);
    expect(pulls).toBeLessThanOrEqual(6);
    expect(child.stdout?.readable).toBe(true);
    child.stdout?.destroy();
  });

  test('passes stdio policy to Process Execution while rejecting unsupported execution choices explicitly', async () => {
    const port = new FakeProcessExecutionPort();
    const childProcess = createChildProcessBuiltin({ cwd: '/project', env: {}, parentPid: 1, port });
    const inheritedStdout = { write: vi.fn() };
    const child = childProcess.spawn('node', [], { stdio: ['pipe', inheritedStdout, 'ignore'] });
    expect(new childProcess.ChildProcess()).toBeInstanceOf(childProcess.ChildProcess);
    expect(child.unref()).toBe(child);
    expect(child.ref()).toBe(child);

    await port.waitForSpawn();
    const request = port.requests[0];
    expect(request).toMatchObject({
      command: 'node',
      stdio: { stdin: 'pipe', stderr: 'ignore' }
    });
    expect(typeof request?.stdio.stdout).toBe('object');
    if (typeof request?.stdio.stdout === 'object') request.stdio.stdout.write(Uint8Array.of(65));
    expect(inheritedStdout.write).toHaveBeenCalledOnce();
    expect(Array.from(inheritedStdout.write.mock.calls[0]?.[0] as Uint8Array)).toEqual([65]);
    await port.waitForSpawn().then((handle) => handle.close(0));

    expect(() => childProcess.spawn('node', [1] as unknown as string[])).toThrowError(
      expect.objectContaining({ code: 'ERR_INVALID_ARG_TYPE' })
    );
    expect(port.requests).toHaveLength(1);
    expect(() => childProcess.execFileSync('node')).toThrowError(expect.objectContaining({ code: 'ENOTSUP' }));
    await waitFor(() => child.exitCode === 0);
    expect(child.exitCode).toBe(0);
  });
});

class FakeProcessExecutionPort implements ChildProcessExecutionPort {
  readonly requests: ProcessExecutionChildRequest[] = [];
  readonly signals: Array<{ readonly pid: number; readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' }> = [];
  signalFailure: Error | undefined;
  #handle: FakeProcessExecutionChildHandle | undefined;
  #resolveSpawn!: (handle: FakeProcessExecutionChildHandle) => void;
  #rejectSpawn!: (error: Error) => void;
  #spawn = new Promise<FakeProcessExecutionChildHandle>((resolve, reject) => {
    this.#resolveSpawn = resolve;
    this.#rejectSpawn = reject;
  });

  spawn(request: ProcessExecutionChildRequest): Promise<ProcessExecutionChildHandle> {
    this.requests.push(request);
    return this.#spawn;
  }

  async signal(pid: number, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT'): Promise<boolean> {
    this.signals.push({ pid, signal });
    if (this.signalFailure) throw this.signalFailure;
    return true;
  }

  async waitForSpawn(): Promise<FakeProcessExecutionChildHandle> {
    if (!this.#handle) {
      this.#handle = new FakeProcessExecutionChildHandle(73);
      this.#resolveSpawn(this.#handle);
    }
    await Promise.resolve();
    return this.#handle;
  }

  rejectSpawn(error: Error): void {
    this.#rejectSpawn(error);
  }
}

class FakeSynchronousProcessExecutionPort
  implements SynchronousChildProcessExecutionPort
{
  readonly requests: ProcessExecutionSynchronousChildRequest[] = [];

  constructor(
    private readonly results: ProcessExecutionSynchronousChildResult[]
  ) {}

  spawnSync(
    request: ProcessExecutionSynchronousChildRequest
  ): ProcessExecutionSynchronousChildResult {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) throw new Error('Missing fake synchronous child result.');
    return result;
  }
}

class FakeProcessExecutionChildHandle implements ProcessExecutionChildHandle {
  readonly stdin = new TransformStream<Uint8Array>().writable;
  readonly #stdout = new TransformStream<Uint8Array>();
  readonly #stderr = new TransformStream<Uint8Array>();
  readonly stdout = this.#stdout.readable;
  readonly stderr = this.#stderr.readable;
  readonly #stdoutWriter = this.#stdout.writable.getWriter();
  readonly #stderrWriter = this.#stderr.writable.getWriter();
  readonly #resolveExit: (outcome: { readonly code: number; readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | null }) => void;
  readonly exit: Promise<{ readonly code: number; readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | null }>;

  constructor(readonly pid: number) {
    let resolveExit!: (outcome: { readonly code: number; readonly signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | null }) => void;
    this.exit = new Promise((resolve) => {
      resolveExit = resolve;
    });
    this.#resolveExit = resolveExit;
  }

  writeStdout(text: string): Promise<void> {
    return this.#stdoutWriter.write(new TextEncoder().encode(text));
  }

  writeStdoutBytes(bytes: Uint8Array): Promise<void> {
    return this.#stdoutWriter.write(bytes);
  }

  async close(code: number, signal: 'SIGTERM' | 'SIGKILL' | 'SIGINT' | null = null): Promise<void> {
    await Promise.all([this.#stdoutWriter.close(), this.#stderrWriter.close()]);
    this.#resolveExit({ code, signal });
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('Expected condition to become true.');
}

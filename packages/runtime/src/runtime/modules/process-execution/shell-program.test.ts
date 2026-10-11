import { describe, expect, test } from 'vitest';

import { createShellProgram, type ShellChildSpawnRequest, type ShellProgramServices } from './shell-program';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

describe('Shell Program', () => {
  test('expands quoted variables and runs the resulting command through Process Execution', async () => {
    const calls: ShellChildSpawnRequest[] = [];
    const stdout: string[] = [];
    const program = createShellProgram();
    const services: ShellProgramServices = {
      children: {
        async spawn(request) {
          calls.push(request);
          return child({ stdout: `ran:${request.command}:${request.args.join(',')}\n` });
        }
      },
      files: memoryFiles()
    };

    const code = await program.run(invocation(['-c', 'MESSAGE="hello world" tool "$MESSAGE"'], stdout), services);

    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      command: 'tool',
      args: ['hello world'],
      cwd: '/home/project',
      env: expect.objectContaining({ MESSAGE: 'hello world' }),
      parentPid: 41
    });
    expect(stdout.join('')).toBe('ran:tool:hello world\n');
  });

  test('pipes binary stdout concurrently and redirects the final command output', async () => {
    const calls: ShellChildSpawnRequest[] = [];
    const errors: string[] = [];
    const program = createShellProgram();
    const files = memoryFiles();
    const services: ShellProgramServices = {
      children: {
        async spawn(request) {
          calls.push(request);
          if (request.command === 'emit') return child({ stdout: new Uint8Array([0, 255, 128]) });
          return child({ stdout: request.stdin });
        }
      },
      files
    };

    const code = await program.run(invocation(['-c', 'emit | collect > payload.bin'], [], errors), services);

    expect(code, errors.join('')).toBe(0);
    expect(calls.map((call) => call.command)).toEqual(['emit', 'collect']);
    expect([...(files.contents.get('/home/project/payload.bin') ?? [])]).toEqual([0, 255, 128]);
  });

  test('preserves list status, isolates subshell assignments, and stops after exit', async () => {
    const calls: ShellChildSpawnRequest[] = [];
    const errors: string[] = [];
    const program = createShellProgram();
    const services: ShellProgramServices = {
      children: {
        async spawn(request) {
          calls.push(request);
          return child({ stdout: '', code: request.command === 'fail' ? 5 : 0 });
        }
      },
      files: memoryFiles()
    };

    const code = await program.run(
      invocation(
        ['-c', 'fail && skipped; recover "$?"; (LOCAL=inner probe "$LOCAL"); probe "${LOCAL}"; exit 7; never'],
        [],
        errors
      ),
      services
    );

    expect(code, errors.join('')).toBe(7);
    expect(calls.map(({ command, args, env }) => ({ command, args, local: env.LOCAL }))).toEqual([
      { command: 'fail', args: [], local: undefined },
      { command: 'recover', args: ['5'], local: undefined },
      {
        command: 'sh',
        args: ['-c', 'LOCAL=inner probe "$LOCAL"', 'sh'],
        local: undefined
      },
      { command: 'probe', args: [''], local: undefined }
    ]);
  });

  test('feeds subshell stdin from the final input redirection', async () => {
    const stdout: string[] = [];
    const program = createShellProgram();
    const files = memoryFiles({ '/home/project/input.txt': 'subshell payload' });
    const services: ShellProgramServices = {
      children: {
        async spawn(request) {
          return child({ stdout: request.stdin });
        }
      },
      files
    };

    const code = await program.run(invocation(['-c', '( consume ) < input.txt'], stdout), services);

    expect(code).toBe(0);
    expect(files.reads).toEqual(['/home/project/input.txt']);
    expect(stdout.join('')).toBe('subshell payload');
  });

  test('uses temporary command assignments when expanding output redirection', async () => {
    const program = createShellProgram();
    const files = memoryFiles({ '/home/project/result.txt': 'stale ' });
    const services: ShellProgramServices = {
      children: {
        async spawn() {
          return child({ stdout: 'assigned output' });
        }
      },
      files
    };

    const code = await program.run(invocation(['-c', 'OUT=result.txt tool > "$OUT"; tool >> "result.txt"'], []), services);

    expect(code).toBe(0);
    expect(decoder.decode(files.contents.get('/home/project/result.txt'))).toBe(
      'assigned outputassigned output'
    );
  });

  test('requests an admitted Process Execution replacement for the final simple command', async () => {
    const replaced: ShellChildSpawnRequest[] = [];
    const program = createShellProgram();
    const services: ShellProgramServices = {
      children: {
        async spawn() {
          throw new Error('the admitted tail replacement must preserve process identity');
        }
      },
      async replace(request) {
        replaced.push(request);
        return 12;
      },
      files: memoryFiles()
    };

    const code = await program.run(invocation(['-c', 'tool "$BASE"'], []), services);

    expect(code).toBe(12);
    expect(replaced).toHaveLength(1);
    expect(replaced[0]).toMatchObject({
      command: 'tool',
      args: ['base'],
      parentPid: 41
    });
  });

});

function memoryFiles(initial: Readonly<Record<string, string>> = {}) {
  const contents = new Map(
    Object.entries(initial).map(([path, text]) => [path, encoder.encode(text)] as const)
  );
  const reads: string[] = [];
  return {
    contents,
    reads,
    stat: (path: string) =>
      contents.has(path)
        ? { kind: 'file' as const, size: contents.get(path)!.byteLength, mtimeMs: 0, mode: 0o644 }
        : undefined,
    readFile(path: string) {
      reads.push(path);
      const bytes = contents.get(path);
      if (!bytes) throw new Error(`${path}: no such file`);
      return bytes;
    },
    readDirectory: () => [],
    writeFile(path: string, data: Uint8Array) {
      contents.set(path, data.slice());
    },
    makeDirectory: () => undefined
  } satisfies ShellProgramServices['files'] & Record<string, unknown>;
}

function invocation(argv: readonly string[], stdout: string[], stderr: string[] = []) {
  return {
    argv,
    cwd: '/home/project',
    env: { BASE: 'base' },
    pid: 41,
    parentPid: 0,
    stdin: { read: async () => undefined },
    stdout: writer(stdout),
    stderr: writer(stderr),
    signal: new Promise<never>(() => undefined)
  };
}

function writer(chunks: string[]) {
  return {
    write(chunk: string | Uint8Array) {
      chunks.push(typeof chunk === 'string' ? chunk : decoder.decode(chunk));
    },
    close() {},
    fail(error: unknown) {
      throw error;
    },
    waitForKill: () => new Promise<never>(() => undefined)
  };
}

function child(output: { readonly stdout: string | Uint8Array | ReadableStream<Uint8Array>; readonly code?: number }) {
  return {
    pid: 101,
    stdin: new WritableStream<Uint8Array>(),
    stdout:
      output.stdout instanceof ReadableStream
        ? output.stdout
        : typeof output.stdout === 'string'
          ? streamFromText(output.stdout)
          : streamFromBytes(output.stdout),
    stderr: streamFromText(''),
    exit: Promise.resolve(output.code ?? 0),
    kill() {}
  };
}

function streamFromText(text: string): ReadableStream<Uint8Array> {
  return streamFromBytes(encoder.encode(text));
}

function streamFromBytes(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    }
  });
}

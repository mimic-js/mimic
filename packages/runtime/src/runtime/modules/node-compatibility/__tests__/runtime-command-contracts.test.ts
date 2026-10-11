import { describe, expect, test, vi } from 'vitest';

import * as Babel from '../../runtime-host/runtime-artifact-compiler-babel';

import { createRuntimeArtifactTranslator } from '../../module-execution-engine';
import { NodeCommand } from '../node-runtime-program';
import { testMacrotaskQueue, testProcessPorts } from './test-process-ports';
import { type ProcessWriter, type RuntimeProgram } from '../../process-execution';
import { createVirtualProcess, VirtualFileSystem } from '../../../../../tests/support/module-internals';
import type { NodeFileSystemWatchPort } from '..';
import {
  createVirtualNetworkAuthority
} from '../../virtual-network';

const compile = createRuntimeArtifactTranslator(Babel);

type RuntimeProgramContext = Parameters<NodeCommand['run']>[1];

const EMPTY_EMITTER: RuntimeProgramContext['emitter'] = {};

describe('process and VFS synchronization contracts', () => {
  test('delivers public process input chunks and EOF to the process runner', async () => {
    const process = createVirtualProcess(1, async (writer, input) => {
      const chunks: string[] = [];
      while (true) {
        const chunk = await input.read();
        if (!chunk) break;
        chunks.push(new TextDecoder().decode(chunk));
      }
      writer.write(chunks.join(''));
      return 0;
    });
    const input = process.input.getWriter();
    const output = collectOutput(process.output);

    await input.write(new TextEncoder().encode('first '));
    await input.write(new TextEncoder().encode('second'));
    await input.close();

    await expect(process.exit).resolves.toBe(0);
    await expect(output).resolves.toBe('first second');
  });

  test('cancels fallback Node evaluation before delayed effects can outlive process exit', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile(
      '/home/project/cancelled-entry.cjs',
      [
        "const fs = require('node:fs');",
        "const timers = require('node:timers');",
        "console.log('fallback-ready', globalThis.process.pid);",
        'void (async () => {',
        '  await new Promise((resolve) => setTimeout(resolve, 25));',
        "  fs.writeFileSync('/home/project/late-bare.txt', 'late');",
        "  console.log('fallback-late-bare-write');",
        '})();',
        'void (async () => {',
        '  await new Promise((resolve) => timers.setTimeout(resolve, 25));',
        "  fs.writeFileSync('/home/project/late-timers.txt', 'late');",
        "  console.log('fallback-late-timers-write');",
        '})();'
      ].join('\n')
    );
    const process = createVirtualProcess(1, (writer) =>
      createNodeCommand().run(['/home/project/cancelled-entry.cjs'], {
        cwd: '/home/project',
        env: {},
        signal: writer.waitForKill(),
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );
    const output = collectOutput(process.output);

    await new Promise((resolve) => setTimeout(resolve, 5));
    process.kill('SIGTERM');

    await expect(process.exit).resolves.toBe(143);
    await new Promise((resolve) => setTimeout(resolve, 35));
    await expect(output).resolves.toContain('fallback-ready 1');
    await expect(output).resolves.not.toContain('fallback-late-bare-write');
    await expect(output).resolves.not.toContain('fallback-late-timers-write');
    expect(fs.exists('/home/project/late-bare.txt')).toBe(false);
    expect(fs.exists('/home/project/late-timers.txt')).toBe(false);
  });

  test('takes the exit code a SIGTERM listener passes to process.exit, as Node does', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile(
      '/home/project/signal-exit.cjs',
      [
        "process.on('SIGTERM', () => {",
        '  process.exit(0);',
        "  console.log('must-not-run-after-signal-exit');",
        '});',
        'setInterval(() => undefined, 1_000);'
      ].join('\n')
    );
    const process = createVirtualProcess(1, (writer) =>
      createNodeCommand().run(['/home/project/signal-exit.cjs'], {
        cwd: '/home/project',
        env: {},
        signal: writer.waitForKill(),
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );
    const output = collectOutput(process.output);

    await new Promise((resolve) => setTimeout(resolve, 5));
    process.kill('SIGTERM');

    await expect(process.exit).resolves.toBe(0);
    await expect(output).resolves.not.toContain('must-not-run-after-signal-exit');
  });

  test('calls a SIGTERM listener with the signal name and number, as Node does', async () => {
    const fs = new VirtualFileSystem('/home/project');
    // The idiom of servers that close on a signal and exit with its status.
    await fs.writeFile(
      '/home/project/signal-number.cjs',
      [
        "process.once('SIGTERM', (name, number) => {",
        "  console.log(`signal ${name} ${number}`);",
        '  process.exitCode ??= 128 + number;',
        '  process.exit();',
        '});',
        'setInterval(() => undefined, 1_000);'
      ].join('\n')
    );
    const process = createVirtualProcess(1, (writer) =>
      createNodeCommand().run(['/home/project/signal-number.cjs'], {
        cwd: '/home/project',
        env: {},
        signal: writer.waitForKill(),
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );
    const output = collectOutput(process.output);

    await new Promise((resolve) => setTimeout(resolve, 5));
    process.kill('SIGTERM');

    await expect(process.exit).resolves.toBe(143);
    await expect(output).resolves.toContain('signal SIGTERM 15');
  });

  test('a SIGTERM listener keeps the process running until it ends it, and a later signal still arrives', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile(
      '/home/project/graceful.cjs',
      [
        'let received = 0;',
        "process.on('SIGTERM', () => {",
        '  received += 1;',
        "  console.log(`SIGTERM ${received}`);",
        '  if (received === 2) setTimeout(() => process.exit(7), 20);',
        '});',
        'setInterval(() => undefined, 1_000);'
      ].join('\n')
    );
    const process = createVirtualProcess(1, (writer) => {
      const nextSignal = () =>
        new Promise<'SIGTERM' | 'SIGKILL' | 'SIGINT'>((resolve) => {
          const unsubscribe = writer.onSignal!((signal) => {
            unsubscribe();
            resolve(signal);
          });
        });
      return createNodeCommand().run(['/home/project/graceful.cjs'], {
        cwd: '/home/project',
        env: {},
        signal: writer.waitForKill(),
        nextSignal,
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });
    const output = collectOutput(process.output);
    let exited = false;
    void process.exit.then(() => (exited = true));

    await new Promise((resolve) => setTimeout(resolve, 5));
    process.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(exited).toBe(false);
    process.kill('SIGTERM');

    await expect(process.exit).resolves.toBe(7);
    await expect(output).resolves.toBe('SIGTERM 1\nSIGTERM 2\n');
  });


});

describe('virtual socket table contracts', () => {
  test('keeps a Runtime Process alive until an outbound HTTP response lifecycle settles', async () => {
    const fs = new VirtualFileSystem('/home/project');
    let observeRequest!: () => void;
    let respond!: (response: Response) => void;
    const requestObserved = new Promise<void>((resolve) => {
      observeRequest = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      observeRequest();
      return response;
    });
    const authority = createVirtualNetworkAuthority();
    const registry = new TestRuntimeProgramRegistry();
    registry.register(new TestNodeCommand(authority));
    await fs.writeFile(
      '/home/project/outbound-lifecycle.cjs',
      [
        "const http = require('node:http');",
        "process.once('beforeExit', () => console.log('outbound-before-exit'));",
        "const request = http.get('http://registry.example.test/package', (response) => {",
        "  console.log('outbound-headers', response.statusCode);",
        "  setImmediate(() => {",
        "    console.log('outbound-consumption-start');",
        "    let body = '';",
        "    response.setEncoding('utf8');",
        "    response.on('data', (chunk) => { body += chunk; });",
        "    response.on('end', () => {",
        "      console.log('outbound-body', body);",
        "      Promise.resolve().then(() => console.log('outbound-promise-settled'));",
        '    });',
        '  });',
        '});',
        "request.on('error', (error) => console.error('outbound-error', error.code));"
      ].join('\n')
    );

    const runPromise = runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/outbound-lifecycle.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );
    let settled = false;
    void runPromise.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );

    await requestObserved;
    for (let turn = 0; turn < 32; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    expect(settled).toBe(false);
    respond(new Response('ok', { status: 200 }));

    const run = await runPromise;
    fetch.mockRestore();
    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('outbound-headers 200');
    expect(run.output).toContain('outbound-consumption-start');
    expect(run.output).toContain('outbound-body ok');
    expect(run.output).toContain('outbound-promise-settled');
    expect(run.output.indexOf('outbound-headers 200')).toBeLessThan(
      run.output.indexOf('outbound-consumption-start')
    );
    expect(run.output.indexOf('outbound-promise-settled')).toBeLessThan(
      run.output.indexOf('outbound-before-exit')
    );
  }, 15_000);

  test('aborts pending outbound Fetch when the Runtime Process terminates', async () => {
    const fs = new VirtualFileSystem('/home/project');
    let observeRequest!: () => void;
    let respond!: (response: Response) => void;
    let signal: AbortSignal | null | undefined;
    const requestObserved = new Promise<void>((resolve) => {
      observeRequest = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      respond = resolve;
    });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signal = init?.signal;
      observeRequest();
      return response;
    });
    const registry = new TestRuntimeProgramRegistry();
    registry.register(new TestNodeCommand());
    await fs.writeFile(
      '/home/project/outbound-termination.cjs',
      [
        "const http = require('node:http');",
        "http.get('http://registry.example.test/package', () => console.log('late-response'))",
        "  .on('error', () => console.log('late-error'));"
      ].join('\n')
    );
    const process = createVirtualProcess(1, (writer) =>
      registry.resolve('node')?.run(['/home/project/outbound-termination.cjs'], {
        cwd: '/home/project',
        env: {},
        signal: writer.waitForKill(),
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );
    const output = collectOutput(process.output);

    try {
      await requestObserved;
      process.kill('SIGTERM');
      await expect(process.exit).resolves.toBe(143);
      expect(signal?.aborted).toBe(true);
      respond(new Response('too-late'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await expect(output).resolves.not.toMatch(/late-(?:response|error)/u);
    } finally {
      fetch.mockRestore();
    }
  }, 15_000);

  test('delivers connection data, close callbacks, and refused errors', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile('/home/project/net-smoke.mjs', netSocketProgram());

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/net-smoke.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    for (const marker of [
      'server-listening 127.0.0.1 8123',
      'client-connect 8123',
      'client-write-callback',
      'server-data ping',
      'server-write-callback',
      'client-data hello:',
      'client-data done',
      'client-end hello:done',
      'client-end-callback',
      'server-connections-after-end 0',
      'server-close-callback',
      'refused-error ECONNREFUSED',
      'refused-close true'
    ]) {
      expect(run.output).toContain(marker);
    }
  }, 15_000);

  test('waits for the answer to a question instead of ending while its input is still open', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/question.cjs',
      [
        "const readline = require('readline');",
        'const rl = readline.createInterface({ input: process.stdin, output: process.stdout });',
        "rl.question('name? ', (answer) => { console.log('answer', answer); rl.close(); });"
      ].join('\n')
    );
    // The answer arrives after the program has nothing else to do.
    const chunks = [new TextEncoder().encode('expo\n')];
    const input = {
      read: () => new Promise<Uint8Array | undefined>((resolve) => setTimeout(() => resolve(chunks.shift()), 100))
    };

    const run = await runVirtualCommand((writer) => registry.resolve('node')?.run(['/home/project/question.cjs'], {
      cwd: '/home/project', env: {}, fs, writer, input, ...testProcessPorts(), emitter: EMPTY_EMITTER
    }));

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('answer expo');
  }, 15_000);

  test('lets a port go as soon as close() is called, so the next listen on it succeeds', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/net-relisten.mjs',
      [
        "import net from 'node:net';",
        // detect-port (react-scripts) probes a port this way, for several hosts in a row.
        'const probe = (host) => new Promise((resolve) => {',
        '  const server = new net.Server();',
        "  server.on('error', (error) => resolve(error.code));",
        '  server.listen(3000, host, () => { server.close(); resolve(server.address() === null ? \'free\' : \'open\'); });',
        '});',
        "for (const host of [undefined, '0.0.0.0', 'localhost', '127.0.0.1']) console.log('probe', await probe(host));",
        "const closed = new Promise((resolve) => net.createServer().listen(3001, function () { this.close(resolve); }));",
        "console.log('close-callback', await closed === undefined);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => registry.resolve('node')?.run(['/home/project/net-relisten.mjs'], {
      cwd: '/home/project', env: {}, fs, writer, ...testProcessPorts(), emitter: EMPTY_EMITTER
    }));

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output.match(/probe free/g)).toHaveLength(4);
    expect(run.output).toContain('close-callback true');
  }, 15_000);

  test('emits Node drain only after a paused virtual peer resumes', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/net-backpressure.mjs',
      [
        "import net from 'node:net';",
        'await new Promise((resolve, reject) => {',
        '  const server = net.createServer((socket) => {',
        '    let received = 0;',
        "    socket.on('data', (chunk) => { received += chunk.length; });",
        '    socket.pause();',
        "    console.log('peer-paused');",
        "    setTimeout(() => { console.log('peer-resuming'); socket.resume(); }, 50);",
        "    socket.on('end', () => { socket.end(); server.close(() => { console.log('peer-closed', received); resolve(); }); });",
        '  });',
        "  server.on('error', reject);",
        "  server.listen(8124, '127.0.0.1', () => {",
        "    const client = net.connect({ host: '127.0.0.1', port: 8124 });",
        "    client.on('connect', () => setTimeout(() => {",
        "      const accepted = client.write(new Uint8Array(16 * 1024), () => console.log('write-callback'));",
        "      console.log('write-return', accepted);",
        "      client.once('drain', () => { console.log('client-drain'); client.end(); });",
        '    }, 10));',
        "    client.on('error', reject);",
        '  });',
        '});'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => registry.resolve('node')?.run(['/home/project/net-backpressure.mjs'], {
      cwd: '/home/project', env: {}, fs, writer, ...testProcessPorts(), emitter: EMPTY_EMITTER
    }));

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('write-return false');
    expect(run.output).toContain('peer-resuming');
    expect(run.output).toContain('client-drain');
    expect(run.output.indexOf('client-drain')).toBeGreaterThan(run.output.indexOf('peer-resuming'));
    expect(run.output).toContain('write-callback');
    expect(run.output).toContain('peer-closed 16384');
  }, 15_000);

  test('publishes an ephemeral HTTP listener only after its virtual bind resolves', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const authority = createVirtualNetworkAuthority();
    const releaseOwner = vi.spyOn(authority, 'releaseOwner');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(new TestNodeCommand(authority));
    let publishedPort = -1;
    await fs.writeFile(
      '/home/project/http-ephemeral.mjs',
      [
        "import http from 'node:http';",
        'await new Promise((resolve, reject) => {',
        '  const server = http.createServer((_request, response) => response.end());',
        "  server.on('error', reject);",
        "  server.listen(0, '127.0.0.1', () => { console.log('http-bound', server.address().port); server.close(resolve); });",
        '});'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => registry.resolve('node')?.run(['/home/project/http-ephemeral.mjs'], {
      cwd: '/home/project',
      env: {},
      fs,
      writer,
      ...testProcessPorts(),
      emitter: EMPTY_EMITTER,
      publishedEndpoints: {
        register(port) { publishedPort = port; },
        close() {}
      }
    }));

    expect(run.exitCode, run.output).toBe(0);
    expect(publishedPort).toBeGreaterThan(0);
    expect(run.output).toContain(`http-bound ${publishedPort}`);
    expect(releaseOwner).toHaveBeenCalledWith('1');
  }, 15_000);
});

describe('JavaScript bin loader contracts', () => {
  test('runs ordered CommonJS and ESM preloads before the entry and exposes consumed CLI flags', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/require-first.cjs',
      "globalThis.preloadOrder = [...(globalThis.preloadOrder ?? []), 'require-first'];\n"
    );
    await fs.writeFile(
      '/home/project/require-second.cjs',
      "globalThis.preloadOrder = [...globalThis.preloadOrder, 'require-second'];\n"
    );
    await fs.writeFile(
      '/home/project/require-third.cjs',
      "globalThis.preloadOrder = [...globalThis.preloadOrder, 'require-third'];\n"
    );
    await fs.writeFile(
      '/home/project/require-fourth.cjs',
      "globalThis.preloadOrder = [...globalThis.preloadOrder, 'require-fourth'];\n"
    );
    await fs.writeFile(
      '/home/project/import-first.mjs',
      "globalThis.preloadOrder = [...globalThis.preloadOrder, 'import-first'];\n"
    );
    await fs.writeFile(
      '/home/project/import-second.mjs',
      "globalThis.preloadOrder = [...globalThis.preloadOrder, 'import-second'];\n"
    );
    await fs.writeFile(
      '/home/project/entry.cjs',
      [
        "globalThis.preloadOrder.push('entry');",
        "console.log('preload-order', JSON.stringify(globalThis.preloadOrder));",
        "console.log('exec-argv', JSON.stringify(process.execArgv));",
        "console.log('argv', JSON.stringify(process.argv));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(
        [
          '--import',
          '/home/project/import-first.mjs',
          '-r',
          '/home/project/require-first.cjs',
          '-r=/home/project/require-second.cjs',
          '--require',
          '/home/project/require-third.cjs',
          '--require=/home/project/require-fourth.cjs',
          '--import=/home/project/import-second.mjs',
          '/home/project/entry.cjs',
          '--require',
          '/home/project/must-remain-an-application-argument.cjs'
        ],
        {
          cwd: '/home/project',
          env: {},
          fs,
          writer,
          ...testProcessPorts(),
          emitter: EMPTY_EMITTER
        }
      )
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain(
      'preload-order ["require-first","require-second","require-third","require-fourth","import-first","import-second","entry"]'
    );
    expect(run.output).toContain(
      'exec-argv ["--import","/home/project/import-first.mjs","-r","/home/project/require-first.cjs","-r=/home/project/require-second.cjs","--require","/home/project/require-third.cjs","--require=/home/project/require-fourth.cjs","--import=/home/project/import-second.mjs"]'
    );
    expect(run.output).toContain(
      'argv ["node","/home/project/entry.cjs","--require","/home/project/must-remain-an-application-argument.cjs"]'
    );
  });

  test('identifies the CommonJS entry and honours export conditions given on the command line', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.mkdir('/home/project/node_modules/conditional', { recursive: true });
    await fs.writeFile(
      '/home/project/node_modules/conditional/package.json',
      JSON.stringify({ exports: { custom: './custom.js', default: './default.js' } })
    );
    await fs.writeFile('/home/project/node_modules/conditional/custom.js', "module.exports = 'custom';\n");
    await fs.writeFile('/home/project/node_modules/conditional/default.js', "module.exports = 'default';\n");
    await fs.writeFile(
      '/home/project/cli.cjs',
      [
        'function main() {',
        "  console.log('main-module', process.mainModule === module, module.id, require('conditional'));",
        '}',
        'if (require.main === module) main();'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['--conditions=custom', '/home/project/cli.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('main-module true . custom');
  });

  test.each([
    { args: ['-r'], error: 'node: -r requires an argument\n', exitCode: 9 },
    { args: ['--require='], error: 'node: --require requires an argument\n', exitCode: 9 },
    { args: ['--import'], error: 'node: --import requires an argument\n', exitCode: 9 },
    { args: ['--import='], error: 'node: --import requires an argument\n', exitCode: 9 },
    { args: ['--not-a-node-option', 'a.cjs'], error: 'node: bad option: --not-a-node-option\n', exitCode: 9 },
    { args: [], error: 'node: missing entry file\n', exitCode: 1 },
    { args: ['--require', '/home/project/preload.cjs'], error: 'node: missing entry file\n', exitCode: 1 }
  ])('rejects invalid command lines: $error', async ({ args, error, exitCode }) => {
    const fs = new VirtualFileSystem('/home/project');
    const errors: string[] = [];
    const writer: ProcessWriter = {
      write() {},
      close() {},
      fail() {},
      waitForKill: () => new Promise(() => undefined)
    };
    const run = await createNodeCommand().run(args, {
      cwd: '/home/project',
      env: {},
      fs,
      writer,
      errorWriter: {
        ...writer,
        write(chunk) {
          errors.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        }
      },
      ...testProcessPorts(),
      emitter: EMPTY_EMITTER
    });

    expect(run).toBe(exitCode);
    expect(errors).toEqual([error]);
  });

  test('keeps injected child-process activity referenced until the child closes', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile(
      '/home/project/injected-child-parent.cjs',
      [
        "const { spawn } = require('node:child_process');",
        "const unexpectedIdle = () => { console.log('unexpected-child-idle'); process.exitCode = 42; };",
        "process.once('beforeExit', unexpectedIdle);",
        "const child = spawn('helper', ['installed-bin']);",
        "child.stdout.on('data', (chunk) => process.stdout.write(chunk));",
        "child.once('close', (code) => {",
        "  process.off('beforeExit', unexpectedIdle);",
        "  console.log('injected-child-close', code);",
        '});'
      ].join('\n')
    );

    let resolveSpawned!: () => void;
    const spawned = new Promise<void>((resolve) => {
      resolveSpawned = resolve;
    });
    let finishChild!: () => void;
    const childProcess: NonNullable<RuntimeProgramContext['childProcess']> = {
      async spawn() {
        let stdout!: ReadableStreamDefaultController<Uint8Array>;
        let resolveExit!: (result: { readonly code: number; readonly signal: null }) => void;
        const exit = new Promise<{ readonly code: number; readonly signal: null }>((resolve) => {
          resolveExit = resolve;
        });
        finishChild = () => {
          stdout.enqueue(new TextEncoder().encode('helper installed-bin\n'));
          stdout.close();
          resolveExit({ code: 0, signal: null });
        };
        resolveSpawned();
        return {
          pid: 73,
          stdin: new WritableStream<Uint8Array>(),
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              stdout = controller;
            }
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            }
          }),
          exit
        };
      },
      signal: async () => true
    };
    const run = runVirtualCommand((writer) =>
      createNodeCommand().run(['/home/project/injected-child-parent.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        childProcess,
        emitter: EMPTY_EMITTER
      })
    );

    await spawned;
    for (let turn = 0; turn < 32; turn += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
    finishChild();

    await expect(run).resolves.toEqual({
      exitCode: 0,
      output: 'helper installed-bin\ninjected-child-close 0\n'
    });
  });

  test('keeps detached async filesystem work alive and implements console.assert without throwing', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/async-cli.cjs',
      [
        "const fs = require('node:fs');",
        "console.assert(true, 'hidden');",
        "console.assert(false, 'visible', 42);",
        'const beforeExitGuard = () => undefined;',
        "process.once('beforeExit', beforeExitGuard);",
        "process.off('beforeExit', beforeExitGuard);",
        "console.log('before-exit-listeners', process.listenerCount('beforeExit'));",
        "void fs.promises.writeFile('/home/project/detached.txt', 'settled').then(() => console.log('detached-write-complete'));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/async-cli.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        errorWriter: writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('Assertion failed: visible 42');
    expect(run.output).not.toContain('hidden');
    expect(run.output).toContain('before-exit-listeners 0');
    expect(run.output).toContain('detached-write-complete');
    expect(fs.readText('/home/project/detached.txt')).toBe('settled');
  });

  test('returns a JavaScript entrypoint process.exitCode when it finishes normally', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile('/home/project/exit-code.cjs', 'process.exitCode = 2;\n');

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/exit-code.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(2);
  });

  test('terminates from process.exit inside referenced async work without leaking later effects', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/async-exit.cjs',
      [
        'setTimeout(() => {',
        '  process.exit(7);',
        "  console.log('must-not-run-in-exit-turn');",
        "  require('node:fs').writeFileSync('/home/project/async-after-exit.txt', 'bad');",
        '}, 0);',
        "setTimeout(() => console.log('must-not-run-after-exit'), 25);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/async-exit.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(7);
    expect(run.output).not.toContain('must-not-run-in-exit-turn');
    expect(run.output).not.toContain('must-not-run-after-exit');
    expect(fs.exists('/home/project/async-after-exit.txt')).toBe(false);
  });

  test('treats process.exit from tracked ESM work as normal numeric termination', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    const runtimeErrors: string[] = [];
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/tracked-esm-exit.mjs',
      [
        '(async () => {',
        '  await Promise.resolve();',
        '  process.exit(7);',
        '})();'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/tracked-esm-exit.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: { ...EMPTY_EMITTER, emitError: (error) => runtimeErrors.push(error.message) }
      })
    );

    expect(run.exitCode, run.output).toBe(7);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(runtimeErrors).toEqual([]);
  });

  test('translates process.exit from process.nextTick without leaking same-turn effects', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    const runtimeErrors: string[] = [];
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/next-tick-exit.cjs',
      [
        'process.nextTick(() => {',
        '  process.exit(6);',
        "  console.log('must-not-run-after-next-tick-exit');",
        "  require('node:fs').writeFileSync('/home/project/next-tick-after-exit.txt', 'bad');",
        '});'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/next-tick-exit.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: { ...EMPTY_EMITTER, emitError: (error) => runtimeErrors.push(error.message) }
      })
    );

    expect(run.exitCode, run.output).toBe(6);
    expect(run.output).not.toContain('must-not-run-after-next-tick-exit');
    expect(fs.exists('/home/project/next-tick-after-exit.txt')).toBe(false);
    expect(runtimeErrors).toEqual([]);
  });

  test('translates process.exit from queueMicrotask without leaking same-turn effects', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    const runtimeErrors: string[] = [];
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/microtask-exit.cjs',
      [
        'queueMicrotask(() => {',
        '  process.exit(8);',
        "  console.log('must-not-run-after-microtask-exit');",
        "  require('node:fs').writeFileSync('/home/project/microtask-after-exit.txt', 'bad');",
        '});'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/microtask-exit.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: { ...EMPTY_EMITTER, emitError: (error) => runtimeErrors.push(error.message) }
      })
    );

    expect(run.exitCode, run.output).toBe(8);
    expect(run.output).not.toContain('must-not-run-after-microtask-exit');
    expect(fs.exists('/home/project/microtask-after-exit.txt')).toBe(false);
    expect(runtimeErrors).toEqual([]);
  });

  test('reports a non-exit rejection that settles after a caught process.exit request', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    const runtimeErrors: string[] = [];
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/caught-exit.cjs',
      [
        "try { process.exit(9); } catch {}",
        "Promise.resolve().then(() => { throw new Error('post-exit-rejection-marker'); });"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/caught-exit.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: { ...EMPTY_EMITTER, emitError: (error) => runtimeErrors.push(error.message) }
      })
    );

    expect(run.exitCode, run.output).toBe(9);
    await vi.waitFor(() =>
      expect(runtimeErrors.some((message) => message.includes('post-exit-rejection-marker'))).toBe(true)
    );
  });

  test('terminates the current entry turn when process.exit is called', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/sync-exit.cjs',
      [
        'process.exit(5);',
        "console.log('must-not-run-in-entry-turn');",
        "require('node:fs').writeFileSync('/home/project/sync-after-exit.txt', 'bad');"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/sync-exit.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(5);
    expect(run.output).not.toContain('must-not-run-in-entry-turn');
    expect(fs.exists('/home/project/sync-after-exit.txt')).toBe(false);
  });

  test('resolves extensionless CommonJS subpaths with dotted basenames', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    fs.mount(
      {
        'entry.cjs': {
          file: {
            contents: "const dotted = require('dotted-package');\nconsole.log('dotted-helper', dotted.value);\n"
          }
        },
        node_modules: {
          directory: {
            'dotted-package': {
              directory: {
                'package.json': {
                  file: {
                    contents: JSON.stringify({ name: 'dotted-package', version: '1.0.0', main: 'index.js' })
                  }
                },
                'index.js': {
                  file: {
                    contents: "module.exports = require('./util.inspect');\n"
                  }
                },
                'util.inspect.js': {
                  file: {
                    contents: "exports.value = 'ok';\n"
                  }
                }
              }
            }
          }
        }
      },
      '/home/project'
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/entry.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('dotted-helper ok');
  });

});

describe('virtual Node identity contracts', () => {
  test('preserves relative POSIX path components before resolving them against cwd', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/path-posix.cjs',
      [
        "const path = require('node:path');",
        "console.log(JSON.stringify({ dirname: path.dirname('dist/api.js'), basename: path.basename('dist/api.js'), extname: path.extname('dist/api.js'), resolved: path.resolve('dist/api.js'), roots: ['/', '//', '///'].map((value) => path.dirname(value)) }));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/path-posix.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain(
      '{"dirname":"dist","basename":"api.js","extname":".js","resolved":"/home/project/dist/api.js","roots":["/","/","/"]}'
    );
  });

  test('exposes the Node path/posix builtin subpath', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/path-posix-subpath.cjs',
      "const { relative } = require('node:path/posix'); console.log(relative('/home/project', '/home/project/src/app.ts'));"
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/path-posix-subpath.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('src/app.ts');
  });

  test('exposes the Node path.win32 parser used by portable archive consumers', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/path-win32.cjs',
      [
        "const { win32 } = require('node:path');",
        "const parsed = win32.parse('C:\\\\archive\\\\package\\\\index.js');",
        "console.log(win32.isAbsolute('C:\\\\archive'), parsed.root, parsed.base);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/path-win32.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('true C:\\ index.js');
  });

  test('reports one engine-facing identity through node:process and node:os', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/identity-probe.mjs',
      [
        "import process from 'node:process';",
        "import os from 'node:os';",
        "console.log('virtual-identity', [process.platform, process.arch, process.version, process.versions.webcontainer, os.platform(), os.arch(), os.type()].join(':'));",
        "console.log('virtual-signals', os.constants.signals.SIGINT, os.constants.signals.SIGTERM, os.constants.signals.SIGKILL);",
        "console.log('virtual-errno', os.constants.errno.EEXIST, os.constants.errno.EISDIR, os.constants.errno.EINVAL, os.constants.errno.ENOTDIR);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/identity-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('virtual-identity linux:wasm32:v22.22.3:0.1.0:linux:wasm32:Linux');
    expect(run.output).toContain('virtual-signals 2 15 9');
    expect(run.output).toContain('virtual-errno 17 21 22 20');
  });

  test('reports the supported Node crypto hash algorithms', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/crypto-hashes-probe.mjs',
      [
        "import crypto from 'node:crypto';",
        "console.log('crypto-hashes', crypto.getHashes().join(','));",
        "console.log('crypto-curves', crypto.getCurves().join(','));",
        "console.log('crypto-ciphers', crypto.getCiphers().join(','));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/crypto-hashes-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain(
      'crypto-hashes md5,ripemd160,rmd160,sha1,sha224,sha256,sha384,sha512,sha512-224,sha512-256,sha3-224,sha3-256,sha3-384,sha3-512'
    );
    expect(run.output).toContain('crypto-curves prime256v1,secp256k1,secp384r1,secp521r1');
    expect(run.output).toContain('crypto-ciphers aes-128-cbc,aes-192-cbc,aes-256-cbc,aes-128-gcm,aes-192-gcm,aes-256-gcm');
  });

  test('supports callback descriptors and promise links used by package stores', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/fs-store-probe.mjs',
      [
        "import fs, { promises } from 'node:fs';",
        "fs.mkdirSync('/home/project/store', { recursive: true });",
        "const fd = await new Promise((resolve, reject) => fs.open('/home/project/store/marker', fs.constants.O_RDWR | fs.constants.O_CREAT, (error, value) => error ? reject(error) : resolve(value)));",
        "const source = Buffer.from('cached');",
        "await new Promise((resolve, reject) => fs.write(fd, source, 0, source.length, 0, (error) => error ? reject(error) : resolve()));",
        'const first = Buffer.alloc(3);',
        'const second = Buffer.alloc(3);',
        "const firstRead = await new Promise((resolve, reject) => fs.read(fd, first, 0, first.length, -1, (error, count) => error ? reject(error) : resolve(count)));",
        "const secondRead = await new Promise((resolve, reject) => fs.read(fd, second, 0, second.length, -1, (error, count) => error ? reject(error) : resolve(count)));",
        "console.log('store-read', firstRead + secondRead, first.toString() + second.toString());",
        "await new Promise((resolve, reject) => fs.futimes(fd, Date.now(), Date.now(), (error) => error ? reject(error) : resolve()));",
        "await new Promise((resolve, reject) => fs.close(fd, (error) => error ? reject(error) : resolve()));",
        "await new Promise((resolve, reject) => fs.copyFile('/home/project/store/marker', '/home/project/store/copied', fs.constants.COPYFILE_EXCL, (error) => error ? reject(error) : resolve()));",
        "console.log('store-copy', fs.readFileSync('/home/project/store/copied', 'utf8'));",
        "await promises.link('/home/project/store/marker', '/home/project/store/linked');",
        "const sourceStat = fs.statSync('/home/project/store/marker', { bigint: true });",
        "const linkedStat = fs.statSync('/home/project/store/linked', { bigint: true });",
        "console.log('store-link', fs.existsSync('/home/project/store/linked'), sourceStat.ino === linkedStat.ino, typeof sourceStat.mtimeNs);",
        "await promises.utimes('/home/project/store', 1700000000, 1700000000);",
        "fs.utimesSync('/home/project/store', 1700000001, 1700000001);",
        "console.log('store-mtime', fs.statSync('/home/project/store').mtimeMs);",
        "await promises.unlink('/home/project/store/linked');"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/fs-store-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('store-read 6 cached');
    expect(run.output).toContain('store-copy cached');
    expect(run.output).toContain('store-link true true bigint');
    expect(run.output).toContain('store-mtime 1700000001000');
    expect(fs.exists('/home/project/store/linked')).toBe(false);
  });

  test('exposes promise timers and scheduler turns through node:timers/promises', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/timers-promises-probe.mjs',
      [
        "import { setTimeout as delay, setImmediate as defer, scheduler } from 'node:timers/promises';",
        "const timeoutValue = await delay(1, 'timeout');",
        "const immediateValue = await defer('immediate');",
        'await scheduler.yield();',
        'await scheduler.wait(1);',
        "console.log('timers-promises', timeoutValue, immediateValue);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/timers-promises-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('timers-promises timeout immediate');
  });

  test('exposes refable global timers and async-iterable readable streams', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/runtime-primitives-probe.mjs',
      [
        "import { isDisturbed, isErrored, isReadable, isWritable, Readable } from 'node:stream';",
        'const timer = setTimeout(() => undefined, 1000);',
        "console.log('timer-handle', timer.unref() === timer, timer.hasRef(), timer.ref() === timer, timer.hasRef());",
        'timer.refresh();',
        'clearTimeout(timer);',
        'const values = [];',
        "const readable = Readable.from(['one', 'two']);",
        "console.log('stream-state-before', isDisturbed(readable), isErrored(readable), isReadable(readable), isWritable(readable));",
        'for await (const value of readable) values.push(value);',
        "console.log('stream-iterator', values.join(','), isDisturbed(readable));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/runtime-primitives-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('timer-handle true false true true');
    expect(run.output).toContain('stream-state-before false false true null');
    expect(run.output).toContain('stream-iterator one,two true');
  });

  test('runs transform destroy hooks before completing a failed pipeline', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/stream-pipeline-destroy-probe.mjs',
      [
        "import { pipeline, Readable, Transform, Writable } from 'node:stream';",
        'const events = [];',
        'class FailingTransform extends Transform {',
        '  _transform(chunk, _encoding, callback) { events.push(`transform:${chunk}`); callback(new Error("transform failed")); }',
        '  _destroy(error, callback) { events.push(`transform-destroy:${error?.message ?? "none"}`); setTimeout(callback, 0); }',
        '}',
        'class DestroyAwareWritable extends Writable {',
        '  _destroy(error, callback) { events.push(`destroy:${error?.message ?? "none"}`); setTimeout(callback, 0); }',
        '}',
        'pipeline(Readable.from(["body"]), new FailingTransform(), new DestroyAwareWritable(), (error) => {',
        '  console.log("pipeline-destroy", error?.message ?? "none", events.join("|"));',
        '});'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/stream-pipeline-destroy-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain(
      'pipeline-destroy transform failed transform:body|transform-destroy:transform failed|destroy:transform failed'
    );
  });

  test('exposes the runtime performance resource-timing contract through perf_hooks', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/perf-hooks-probe.mjs',
      [
        "import { performance, PerformanceObserver } from 'node:perf_hooks';",
        "console.log('perf-hooks', typeof performance.now, typeof performance.markResourceTiming);",
        // Nx observes `measure` entries at load; the constructor and `observe` must exist.
        "new PerformanceObserver(() => undefined).observe({ entryTypes: ['measure'] });",
        "console.log('perf-hooks-observer', typeof PerformanceObserver);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/perf-hooks-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('perf-hooks function function');
    expect(run.output).toContain('perf-hooks-observer function');
  });

  test('names a missing module MODULE_NOT_FOUND for require and ERR_MODULE_NOT_FOUND for import', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/missing-probe.cjs',
      [
        // The Angular devkit tells a package from a file by this code.
        "try { require.resolve('./missing/package.json'); } catch (error) { console.log('resolve', error.code); }",
        "try { require('missing-package'); } catch (error) { console.log('require', error.code); }",
        "import('missing-package').catch((error) => console.log('import', error.code));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/missing-probe.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('resolve MODULE_NOT_FOUND');
    expect(run.output).toContain('require MODULE_NOT_FOUND');
    expect(run.output).toContain('import ERR_MODULE_NOT_FOUND');
  });

  test('measures event loop delay without keeping the program alive, and records histograms', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/histogram-probe.mjs',
      [
        "import { createHistogram, monitorEventLoopDelay, performance } from 'node:perf_hooks';",
        // NestJS enables this monitor at start; the program must still end on its own.
        'const delay = monitorEventLoopDelay({ resolution: 5 });',
        'delay.enable();',
        'await new Promise((resolve) => setTimeout(resolve, 40));',
        'delay.disable();',
        "console.log('delay', delay.count > 0, delay.min >= 1, delay.percentile(50) >= delay.min);",
        'const histogram = createHistogram();',
        'for (const value of [5, 1, 3, 2, 4]) histogram.record(value);',
        "console.log('histogram', histogram.count, histogram.min, histogram.max, histogram.mean, histogram.percentile(50));",
        'const utilization = performance.eventLoopUtilization();',
        "console.log('elu', typeof utilization.utilization, performance.eventLoopUtilization(utilization).active >= 0);",
        "const uv = process.binding('uv');",
        "console.log('uv', uv.errname(uv.UV_ENOENT), uv.UV_EADDRINUSE < 0);",
        // http-deceiver, under webpack-dev-server 2 and 3, reads this binding when it loads.
        "const { HTTPParser, methods } = process.binding('http_parser');",
        "console.log('http_parser', methods.includes('GET'), HTTPParser.methods.length === methods.length, HTTPParser.kOnHeaders | 0, HTTPParser.kOnMessageComplete | 0);",
        // webpack 3 and builtin-modules list the builtins from this binding's keys.
        "const natives = Object.keys(process.binding('natives'));",
        // workerpool tells Node from a browser by this.
        "console.log('tag', String(process), Object.prototype.toString.call(process));",
        "console.log('natives', natives.includes('fs'), natives.includes('child_process'), natives.length > 30);",
        'delay.enable();'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/histogram-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('delay true true true');
    expect(run.output).toContain('histogram 5 1 5 3 3');
    expect(run.output).toContain('elu number true');
    expect(run.output).toContain('uv ENOENT true');
    expect(run.output).toContain('http_parser true true 1 4');
    expect(run.output).toContain('natives true true true');
    expect(run.output).toContain('tag [object process] [object process]');
  });

  test('reports native TypeScript support, which the compiler worker provides', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/features-probe.mjs',
      // Nx registers swc or ts-node for `.ts` files unless this names Node's own support.
      "console.log('features', process.features.typescript, process.features.require_module);"
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/features-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('features transform false');
  });

  test('exposes Node stream default high-water marks', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/stream-defaults-probe.mjs',
      [
        "import { getDefaultHighWaterMark, setDefaultHighWaterMark } from 'node:stream';",
        "console.log('stream-defaults', getDefaultHighWaterMark(false), getDefaultHighWaterMark(true));",
        'setDefaultHighWaterMark(true, 24);',
        "console.log('stream-object-default', getDefaultHighWaterMark(true));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/stream-defaults-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('stream-defaults 65536 16');
    expect(run.output).toContain('stream-object-default 24');
  });

  test('executes synchronous SQLite prepared statements through node:sqlite', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/sqlite-probe.mjs',
      [
        "import { DatabaseSync } from 'node:sqlite';",
        "const db = new DatabaseSync('/home/project/store.db');",
        "db.exec('CREATE TABLE IF NOT EXISTS package_index (key TEXT PRIMARY KEY, data BLOB NOT NULL) WITHOUT ROWID');",
        "const set = db.prepare('INSERT OR REPLACE INTO package_index (key, data) VALUES (?, ?)');",
        "const get = db.prepare('SELECT data FROM package_index WHERE key = ?');",
        "const all = db.prepare('SELECT key, data FROM package_index');",
        "const del = db.prepare('DELETE FROM package_index WHERE key = ?');",
        "set.run('alpha', new Uint8Array([1, 2, 3]));",
        "console.log('sqlite-get', get.get('alpha').data.length, [...all.iterate()].length);",
        "console.log('sqlite-delete', del.run('alpha').changes, get.get('alpha') === undefined);",
        "set.run('persisted', new Uint8Array([4, 5]));",
        'db.close();'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/sqlite-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('sqlite-get 3 1');
    expect(run.output).toContain('sqlite-delete 1 true');

    await fs.writeFile(
      '/home/project/sqlite-reopen-probe.mjs',
      [
        "import { DatabaseSync } from 'node:sqlite';",
        "const db = new DatabaseSync('/home/project/store.db');",
        "const get = db.prepare('SELECT data FROM package_index WHERE key = :key');",
        "get.setAllowBareNamedParameters(true);",
        "console.log('sqlite-reopen', get.get({ key: 'persisted' }).data.length);",
        'db.close();'
      ].join('\n')
    );
    const reopened = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/sqlite-reopen-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );
    expect(reopened.exitCode, reopened.output).toBe(0);
    expect(reopened.output).toContain('sqlite-reopen 2');
  });

  test('exposes the process EventEmitter listener-limit contract', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/process-listeners-probe.mjs',
      [
        "import process from 'node:process';",
        'process.setMaxListeners(23);',
        "const listener = () => undefined; process.addListener('probe', listener);",
        "console.log('process-listeners', process.getMaxListeners(), process.listenerCount('probe'), process.listeners('probe').length);",
        "console.log('process-umask', process.umask().toString(8), process.umask(0o027).toString(8), process.umask().toString(8));",
        "process.removeAllListeners('probe');"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/process-listeners-probe.mjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('process-listeners 23 1 1');
    expect(run.output).toContain('process-umask 22 22 27');
  });

  test('exposes callable tuple and monotonic bigint high-resolution time through process', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/hrtime-probe.cjs',
      [
        'const first = process.hrtime.bigint();',
        'const second = process.hrtime.bigint();',
        'const tuple = process.hrtime();',
        'const delta = process.hrtime(tuple);',
        "console.log('hrtime-contract', typeof process.hrtime, typeof first, second >= first, tuple.length, delta.length);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/hrtime-probe.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('hrtime-contract function bigint true 2 2');
  });

  test('exposes Node-shaped process memory telemetry', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/memory-usage-probe.cjs',
      [
        'const memory = process.memoryUsage();',
        "console.log('memory-usage', ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers'].every((key) => Number.isFinite(memory[key]) && memory[key] >= 0), process.memoryUsage.rss() >= 0);"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/memory-usage-probe.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('memory-usage true true');
  });

  test('drains top-level CommonJS async work before the command exits', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/async-entry.cjs',
      [
        'void (async () => {',
        '  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();',
        "  console.log('async-cjs-complete');",
        '})();'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/async-entry.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('async-cjs-complete');
  });

  test('emits beforeExit at idle without requiring persistent listeners to be removed', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/before-exit-entry.cjs',
      [
        'let emissions = 0;',
        "process.on('beforeExit', (code) => {",
        '  emissions += 1;',
        "  console.log('before-exit', emissions, code);",
        "  if (emissions === 1) setTimeout(() => console.log('before-exit-work'), 0);",
        '});'
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/before-exit-entry.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('before-exit 1 0');
    expect(run.output).toContain('before-exit-work');
    expect(run.output).toContain('before-exit 2 0');
  });

  test('emits exit after the final beforeExit turn on normal completion', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/normal-exit-entry.cjs',
      [
        "process.once('beforeExit', (code) => console.log('normal-before-exit', code));",
        "process.once('exit', (code) => console.log('normal-exit', code));"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) =>
      registry.resolve('node')?.run(['/home/project/normal-exit-entry.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      })
    );

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('normal-before-exit 0');
    expect(run.output).toContain('normal-exit 0');
    expect(run.output.indexOf('normal-before-exit 0')).toBeLessThan(run.output.indexOf('normal-exit 0'));
  });

  test('keeps the process alive for referenced callback work after the entry promise resolves', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand());
    await fs.writeFile(
      '/home/project/callback-entry.cjs',
      [
        "setTimeout(() => console.log('referenced-callback-complete'), 5);",
        "console.info('referenced-callback-scheduled');",
        "console.debug('referenced-debug-output');"
      ].join('\n')
    );

    const run = await runVirtualCommand((writer) => {
      return registry.resolve('node')?.run(['/home/project/callback-entry.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });

    expect(run.exitCode, run.output).toBe(0);
    expect(run.output).toContain('referenced-callback-scheduled');
    expect(run.output).toContain('referenced-debug-output');
    expect(run.output).toContain('referenced-callback-complete');
  });

  test('keeps the process alive while it owns a Published Endpoint', async () => {
    const fs = new VirtualFileSystem('/home/project');
    await fs.writeFile(
      '/home/project/published-endpoint-server.mjs',
      [
        "import http from 'node:http';",
        "http.createServer((_request, response) => response.end('ready')).listen(5173, '127.0.0.1');"
      ].join('\n')
    );
    let resolveRegistered!: () => void;
    let closeRegistered!: () => void;
    const registered = new Promise<void>((resolve) => {
      resolveRegistered = resolve;
    });
    const process = createVirtualProcess(1, (writer) =>
      createNodeCommand().run(['/home/project/published-endpoint-server.mjs'], {
        cwd: '/home/project',
        env: {},
        signal: writer.waitForKill(),
        fs,
        writer,
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER,
        publishedEndpoints: {
          register: (_port, _protocol, handler) => {
            closeRegistered = () => handler.close?.();
            resolveRegistered();
          },
          close: () => undefined
        }
      })
    );

    await registered;
    await expect(Promise.race([process.exit, new Promise((resolve) => setTimeout(() => resolve('running'), 25))])).resolves.toBe(
      'running'
    );
    closeRegistered();
    await expect(process.exit).resolves.toBe(0);
  });

  test('keeps the process alive when referenced file watchers are registered by callback work', async () => {
    const fs = new VirtualFileSystem('/home/project');
    const watch = testCommittedWatchPort();
    const registry = new TestRuntimeProgramRegistry();
    registry.register(createNodeCommand(watch.port));
    await fs.writeFile('/home/project/watched.txt', 'initial');
    await fs.writeFile(
      '/home/project/late-watch-entry.cjs',
      [
        "const fs = require('node:fs');",
        'setTimeout(() => {',
        "  const watcher = fs.watch('/home/project/watched.txt', () => {",
        "    console.log('late-watcher-change');",
        '    watcher.close();',
        '  });',
        "  console.log('late-watcher-opened');",
        '}, 0);'
      ].join('\n')
    );

    const chunks: string[] = [];
    const process = createVirtualProcess(1, (writer) => {
      return registry.resolve('node')?.run(['/home/project/late-watch-entry.cjs'], {
        cwd: '/home/project',
        env: {},
        fs,
        writer: captureOutput(writer, chunks),
        ...testProcessPorts(),
        emitter: EMPTY_EMITTER
      });
    });
    for (let turn = 0; turn < 100 && !chunks.join('').includes('late-watcher-opened'); turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(chunks.join('')).toContain('late-watcher-opened');
    await fs.writeFile('/home/project/watched.txt', 'updated');
    watch.publish('/home/project/watched.txt', 'path');
    const [output, exitCode] = await Promise.all([collectOutput(process.output), process.exit]);

    expect(exitCode, output).toBe(0);
    expect(output).toContain('late-watcher-change');
  });

});

function command(
  name: string,
  run: RuntimeProgram<RuntimeProgramContext>['run']
): RuntimeProgram<RuntimeProgramContext> {
  return { id: name, commands: [name], run };
}
class TestRuntimeProgramRegistry {
  readonly #programs = new Map<
    string,
    RuntimeProgram<RuntimeProgramContext>
  >();

  register(program: RuntimeProgram<RuntimeProgramContext>): void {
    for (const command of program.commands) this.#programs.set(command, program);
  }

  resolve(command: string): RuntimeProgram<RuntimeProgramContext> | undefined {
    return this.#programs.get(command);
  }
}

/** The Node program with the Virtual Network a process worker puts in its context. */
class TestNodeCommand extends NodeCommand {
  constructor(
    private readonly virtualNetwork = createVirtualNetworkAuthority(),
    fileSystemWatch?: NodeFileSystemWatchPort
  ) {
    super(compile, testMacrotaskQueue, fileSystemWatch);
  }

  override run(args: readonly string[], context: RuntimeProgramContext): Promise<number> {
    return super.run(args, { ...context, virtualNetwork: context.virtualNetwork ?? this.virtualNetwork });
  }
}

function createNodeCommand(fileSystemWatch?: NodeFileSystemWatchPort): NodeCommand {
  return new TestNodeCommand(createVirtualNetworkAuthority(), fileSystemWatch);
}

function testCommittedWatchPort(): {
  readonly port: NodeFileSystemWatchPort;
  publish(path: string, scope: 'path' | 'subtree'): void;
} {
  let revision = 0;
  const listeners = new Set<Parameters<NodeFileSystemWatchPort['watchCommitted']>[0]>();
  return {
    port: {
      watchCommitted(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }
    },
    publish(path, scope) {
      revision += 1;
      for (const listener of listeners) {
        listener({
          kind: 'commit',
          revision,
          invalidations: [{ path, scope }]
        });
      }
    }
  };
}

function captureOutput(delegate: ProcessWriter, chunks: string[]): ProcessWriter {
  return {
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
      delegate.write(chunk);
    },
    close: (code) => delegate.close(code),
    fail: (error) => delegate.fail(error),
    waitForKill: () => delegate.waitForKill()
  };
}

async function runVirtualCommand(
  runner: (writer: ProcessWriter) => Promise<number | void> | number | void
): Promise<{ exitCode: number; output: string }> {
  const process = createVirtualProcess(1, runner);
  const [output, exitCode] = await Promise.all([collectOutput(process.output), process.exit]);
  return { exitCode, output };
}

async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
  const reader = output.getReader();
  const decoder = new TextDecoder();
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += decoder.decode(value);
  }
}

function netSocketProgram(): string {
  return [
    "import net from 'net';",
    '',
    'await new Promise((resolve, reject) => {',
    '  const server = net.createServer((socket) => {',
    '    socket.setEncoding("utf8");',
    '    socket.on("data", (chunk) => {',
    '      console.log("server-data", chunk);',
    '      socket.write("hello:", () => console.log("server-write-callback"));',
    '      socket.end("done", () => console.log("server-end-callback"));',
    '    });',
    '    socket.on("error", reject);',
    '  });',
    '  server.on("error", reject);',
    '  server.listen(8123, "127.0.0.1", () => {',
    '    console.log("server-listening", server.address().address, server.address().port);',
    '    const client = net.createConnection({ port: 8123, host: "127.0.0.1" }, () => {',
    '      console.log("client-connect", client.remotePort, client.localPort);',
    '      client.write("ping", () => console.log("client-write-callback"));',
    '    });',
    '    let body = "";',
    '    client.setEncoding("utf8");',
    '    client.on("data", (chunk) => {',
    '      body += chunk;',
    '      console.log("client-data", chunk);',
    '    });',
    '    client.on("end", () => {',
    '      console.log("client-end", body);',
    '      client.end(undefined, () => {',
    '        console.log("client-end-callback");',
    '        setTimeout(() => {',
    '          server.getConnections((error, count) => {',
    '            if (error) reject(error);',
    '            console.log("server-connections-after-end", count);',
    '            server.close((closeError) => {',
    '              if (closeError) reject(closeError);',
    '              console.log("server-close-callback");',
    '              resolve();',
    '            });',
    '          });',
    '        }, 0);',
    '      });',
    '    });',
    '    client.on("error", reject);',
    '  });',
    '});',
    '',
    'await new Promise((resolve) => {',
    '  const refused = net.connect({ port: 9999, host: "127.0.0.1" });',
    '  refused.on("error", (error) => console.log("refused-error", error.code));',
    '  refused.on("close", (hadError) => {',
    '    console.log("refused-close", hadError);',
    '    resolve();',
    '  });',
    '});'
  ].join('\n');
}

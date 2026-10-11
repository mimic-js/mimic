import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const synchronousChildProcessClaim = defineCompatibilityClaim({
  id: 'synchronous-child-process-execution-v1',
  statement:
    'Mimic synchronously executes generic JavaScript and WASI children through ordinary Runtime Processes',
  target: {
    kind: 'runtime-capability',
    capability: 'synchronous-child-process-execution'
  }
});

// Generated from tests/fixtures/wasi-runtime-process.wat.
const rawWasiRuntimeProcessProgram =
  'AGFzbQEAAAABFwRgAn9/AX9gBH9/f38Bf2ABfwF/YAAAAuABBhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmFyZ3Nfc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhhcmdzX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzERZW52aXJvbl9zaXplc19nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2Vudmlyb25fZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAIDAgEDBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAYKfQF7AEEAQQQQABpBwABBgAEQARpBEEGAATYCAEEUQQQoAgA2AgBBAUEQQQFBIBAEGkEIQQwQAhpBgARBgAgQAxpBGEGACDYCAEEcQQwoAgA2AgBBAUEYQQFBJBAEGkEoQYAQNgIAQSxBEDYCAEECQShBAUEwEAQaQQcQBRoLCxcBAEGAEAsQc3RkZXJyPW9ic2VydmVkCg==';
const successfulWasiRuntimeProcessProgram =
  'AGFzbQEAAAABIQVgBH9/f38Bf2ABfwBgCX9/f39/fn5/fwF/YAABf2AAAAKKAQQWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAQMDAgMEBQQBAwEBBx8DBm1lbW9yeQIACWludmFsaWRGZAAEBl9zdGFydAAFCmMCDQBB4wBBEEEBQRgQAQtTAEEAQfgANgIAQQRBATYCAEEQQfgANgIAQRRBATYCAEEDQQBBwABBCUEAQgJCAEEAQQwQAhpBDCgCAEEQQQFBGBABGkEBQQBBAUEIEAAaQQAQAwsLEAEAQcAACwlpbnB1dC50eHQ=';

test('nested synchronous JavaScript wrapper executes a WASI Runtime Process', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), {
    timeout: 10_000
  }).toBe(true);

  const result = await page.evaluate(async (programBase64) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { collectProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/synchronous-wasi-wrapper' });
    try {
      await runtime.fs.mount({
        'successful.wasm': {
          file: {
            contents: Uint8Array.from(atob(programBase64), (character) =>
              character.charCodeAt(0)
            )
          }
        },
        bin: {
          directory: {
            esbuild: {
              file: {
                contents: [
                  '#!/usr/bin/env node',
                  "require('child_process').execFileSync('/home/synchronous-wasi-wrapper/successful.wasm', process.argv.slice(2), { stdio: 'inherit' });"
                ].join('\n')
              }
            }
          }
        },
        'parent.cjs': {
          file: {
            contents: [
              "const { execFileSync } = require('node:child_process');",
              'async function prepare() {}',
              'prepare().then(() => {',
              "  process.stdout.write(execFileSync(process.execPath, ['/home/synchronous-wasi-wrapper/bin/esbuild'], { encoding: 'utf8' }));",
              '});'
            ].join('\n')
          }
        }
      });
      await runtime.fs.writeFile('/input.txt', new Uint8Array([90]));
      const parent = await runtime.spawn('sh', ['-c', 'node parent.cjs'], { cwd: runtime.workdir });
      const output = collectProcessOutput(parent);
      return { exitCode: await parent.exit, output: await output.done };
    } finally {
      await runtime.teardown();
    }
  }, successfulWasiRuntimeProcessProgram);

  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).toBe('Z');
});

test(synchronousChildProcessClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', {
    waitUntil: 'domcontentloaded'
  });
  await expect
    .poll(() => page.evaluate(() => window.crossOriginIsolated), {
      timeout: 10_000
    })
    .toBe(true);

  const result = await page.evaluate(async ({ programBase64, successfulProgramBase64 }) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({
      workdir: '/home/synchronous-child'
    });
    try {
      const program = Uint8Array.from(atob(programBase64), (character) =>
        character.charCodeAt(0)
      );
      const successfulProgram = Uint8Array.from(
        atob(successfulProgramBase64),
        (character) => character.charCodeAt(0)
      );
      await runtime.fs.mount({
        'direct.wasm': { file: { contents: program } },
        'successful.wasm': { file: { contents: successfulProgram } },
        nested: { directory: {} },
        'child.mjs': {
          file: {
            contents: [
              'const chunks = [];',
              'for await (const chunk of process.stdin) chunks.push(chunk);',
              "process.stdout.write([process.cwd(), process.env.MODE, Buffer.concat(chunks).toString('utf8')].join('|'));",
              "process.stderr.write('child-stderr');"
            ].join('\n')
          }
        },
        'leaf.mjs': {
          file: { contents: "process.stdout.write('nested-leaf');" }
        },
        'nonzero.mjs': {
          file: {
            contents: [
              "process.stdout.write('nonzero-output');",
              "process.stderr.write('nonzero-error');",
              'process.exit(7);'
            ].join('\n')
          }
        },
        'inherited.mjs': {
          file: {
            contents: [
              "process.stdout.write('inherited-stdout\\n');",
              "process.stderr.write('inherited-stderr\\n');"
            ].join('\n')
          }
        },
        'inherited-input.mjs': {
          file: {
            contents: [
              'const chunks = [];',
              'for await (const chunk of process.stdin) chunks.push(chunk);',
              'process.stdout.write(Buffer.concat(chunks));'
            ].join('\n')
          }
        },
        'ignored.mjs': {
          file: {
            contents: [
              "process.stdout.write('forbidden-ignored-stdout');",
              "process.stderr.write('forbidden-ignored-stderr');"
            ].join('\n')
          }
        },
        'timeout.mjs': {
          file: { contents: 'await new Promise(() => {});' }
        },
        'overflow.mjs': {
          file: { contents: "process.stdout.write('x'.repeat(128));" }
        },
        'recursive.mjs': {
          file: {
            contents: [
              "import { execFileSync } from 'node:child_process';",
              'const depth = Number(process.argv[2]);',
              "if (depth === 0) process.stdout.write('unexpected-depth-zero');",
              'else {',
              '  try {',
              "    process.stdout.write(execFileSync(process.execPath, ['/home/synchronous-child/recursive.mjs', String(depth - 1)], { encoding: 'utf8' }));",
              '  } catch (error) {',
              "    if (error?.code !== 'EAGAIN') throw error;",
              "    process.stdout.write('park-limit:' + error.code);",
              '  }',
              '}'
            ].join('\n')
          }
        },
        'nested.mjs': {
          file: {
            contents: [
              "import { execFileSync } from 'node:child_process';",
              "process.stdout.write(execFileSync(process.execPath, ['/home/synchronous-child/leaf.mjs'], { encoding: 'utf8' }));"
            ].join('\n')
          }
        },
        'holder.mjs': {
          file: {
            contents: "console.log('holder-ready'); await new Promise(() => {});"
          }
        },
        'parent.mjs': {
          file: {
            contents: [
              "import { execFileSync, spawnSync } from 'node:child_process';",
              'await new Promise((resolve) => setTimeout(resolve, 50));',
              "const javascript = spawnSync(process.execPath, ['/home/synchronous-child/child.mjs'], { cwd: '/home/synchronous-child/nested', env: { MODE: 'sync' }, input: 'input', encoding: 'utf8' });",
              "const nested = execFileSync(process.execPath, ['/home/synchronous-child/nested.mjs'], { encoding: 'utf8' });",
              "const nonzero = spawnSync(process.execPath, ['/home/synchronous-child/nonzero.mjs'], { encoding: 'utf8' });",
              'let execFileFailure;',
              "try { execFileSync(process.execPath, ['/home/synchronous-child/nonzero.mjs'], { encoding: 'utf8' }); } catch (error) { execFileFailure = { code: error.code ?? null, status: error.status, signal: error.signal, stdout: String(error.stdout), stderr: String(error.stderr) }; }",
              "const inherited = spawnSync(process.execPath, ['/home/synchronous-child/inherited.mjs'], { stdio: ['ignore', 'inherit', 'inherit'] });",
              "const inheritedInput = spawnSync(process.execPath, ['/home/synchronous-child/inherited-input.mjs'], { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'latin1' });",
              "const ignored = spawnSync(process.execPath, ['/home/synchronous-child/ignored.mjs'], { stdio: 'ignore' });",
              "const timeout = spawnSync(process.execPath, ['/home/synchronous-child/timeout.mjs'], { encoding: 'utf8', timeout: 25, killSignal: 'SIGINT' });",
              "const overflow = spawnSync(process.execPath, ['/home/synchronous-child/overflow.mjs'], { encoding: 'utf8', maxBuffer: 32 });",
              "const missing = spawnSync('/home/synchronous-child/missing-command', [], { encoding: 'utf8' });",
              "const parkLimit = execFileSync(process.execPath, ['/home/synchronous-child/recursive.mjs', '8'], { encoding: 'utf8' });",
              "const successfulWasi = spawnSync('/home/synchronous-child/successful.wasm', [], { encoding: 'utf8' });",
              "const wasi = spawnSync('/home/synchronous-child/direct.wasm', ['sync-wasi'], { cwd: '/home/synchronous-child/nested', env: { TOKEN: 'sync' }, encoding: 'utf8' });",
              "console.log('RESULT ' + JSON.stringify({ javascript, nested, nonzero, execFileFailure, inherited, inheritedInput, ignored, timeout: { error: timeout.error?.code, status: timeout.status, signal: timeout.signal }, overflow: { error: overflow.error?.code, status: overflow.status, signal: overflow.signal, stdoutLength: overflow.stdout?.length }, missing: { error: missing.error?.code, status: missing.status, signal: missing.signal }, parkLimit, successfulWasi, wasi }));"
            ].join('\n')
          }
        }
      });
      await runtime.fs.writeFile('/input.txt', new Uint8Array([90]));

      const capacity = Math.min(
        8,
        Math.max(1, navigator.hardwareConcurrency - 1)
      );
      const holders = [];
      for (let index = 1; index < capacity; index += 1) {
        const holder = await runtime.spawn('node', [
          '/home/synchronous-child/holder.mjs'
        ]);
        const reader = holder.stdout.getReader();
        const first = await reader.read();
        reader.releaseLock();
        if (
          first.done ||
          !new TextDecoder().decode(first.value).includes('holder-ready')
        ) {
          throw new Error('capacity holder did not become ready');
        }
        holders.push(holder);
      }

      const parent = await runtime.spawn('node', [
        '/home/synchronous-child/parent.mjs'
      ]);
      const parentInput = parent.stdin.getWriter();
      await parentInput.write(new Uint8Array([0xe9, 0xa9]));
      await parentInput.close();
      const [output, stderr, exitCode] = await Promise.all([
        collect(parent.stdout),
        collect(parent.stderr),
        parent.exit
      ]);
      for (const holder of holders) holder.kill('SIGKILL');
      await Promise.all(holders.map((holder) => holder.exit));
      return { capacity, exitCode, output, stderr };
    } finally {
      await runtime.teardown();
    }

    async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    }
  }, {
    programBase64: rawWasiRuntimeProcessProgram,
    successfulProgramBase64: successfulWasiRuntimeProcessProgram
  });

  expect(result.exitCode, result.stderr).toBe(0);
  const resultLine = result.output
    .split('\n')
    .find((line) => line.startsWith('RESULT '));
  expect(resultLine, result.output).toBeDefined();
  const parsed = JSON.parse(resultLine?.slice('RESULT '.length) ?? '') as {
    readonly javascript: {
      readonly status: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    };
    readonly nested: string;
    readonly nonzero: {
      readonly status: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    };
    readonly execFileFailure: {
      readonly code: string | null;
      readonly status: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    };
    readonly inherited: {
      readonly status: number | null;
      readonly stdout: null;
      readonly stderr: null;
    };
    readonly inheritedInput: {
      readonly status: number | null;
      readonly stdout: string;
      readonly stderr: string;
    };
    readonly ignored: {
      readonly status: number | null;
      readonly stdout: null;
      readonly stderr: null;
    };
    readonly timeout: {
      readonly error: string;
      readonly status: null;
      readonly signal: string;
    };
    readonly overflow: {
      readonly error: string;
      readonly status: null;
      readonly signal: string;
      readonly stdoutLength: number;
    };
    readonly missing: {
      readonly error: string;
      readonly status: null;
      readonly signal: null;
    };
    readonly parkLimit: string;
    readonly successfulWasi: {
      readonly status: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    };
    readonly wasi: {
      readonly status: number | null;
      readonly signal: string | null;
      readonly stdout: string;
      readonly stderr: string;
    };
  };
  expect(parsed.javascript).toMatchObject({
    status: 0,
    signal: null,
    stdout: '/home/synchronous-child/nested|sync|input',
    stderr: 'child-stderr'
  });
  expect(parsed.nested).toBe('nested-leaf');
  expect(parsed.nonzero).toMatchObject({
    status: 7,
    signal: null,
    stdout: 'nonzero-output',
    stderr: 'nonzero-error'
  });
  expect(parsed.execFileFailure).toEqual({
    code: null,
    status: 7,
    signal: null,
    stdout: 'nonzero-output',
    stderr: 'nonzero-error'
  });
  expect(parsed.inherited).toMatchObject({
    status: 0,
    stdout: null,
    stderr: null
  });
  expect(parsed.inheritedInput).toMatchObject({
    status: 0,
    stdout: 'é©',
    stderr: ''
  });
  expect(parsed.ignored).toMatchObject({
    status: 0,
    stdout: null,
    stderr: null
  });
  expect(parsed.timeout).toEqual({
    error: 'ETIMEDOUT',
    status: null,
    signal: 'SIGINT'
  });
  expect(parsed.overflow).toEqual({
    error: 'ENOBUFS',
    status: null,
    signal: 'SIGTERM',
    stdoutLength: 32
  });
  expect(parsed.missing).toEqual({
    error: 'ENOENT',
    status: null,
    signal: null
  });
  expect(parsed.parkLimit).toBe('park-limit:EAGAIN');
  expect(parsed.successfulWasi).toMatchObject({
    status: 0,
    signal: null,
    stdout: 'Z',
    stderr: ''
  });
  expect(parsed.wasi.status).toBe(7);
  expect(parsed.wasi.signal).toBeNull();
  expect(parsed.wasi.stdout).toContain('sync-wasi\0');
  expect(parsed.wasi.stdout).toContain('TOKEN=sync\0');
  expect(parsed.wasi.stdout).toContain('PWD=/home/synchronous-child/nested\0');
  expect(parsed.wasi.stderr).toBe('stderr=observed\n');
  expect(result.capacity).toBeGreaterThanOrEqual(1);
  expect(result.output).toContain('inherited-stdout\n');
  expect(result.stderr).toContain('inherited-stderr\n');
  expect(result.output).not.toContain('forbidden-ignored-stdout');
  expect(result.stderr).not.toContain('forbidden-ignored-stderr');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test('parent termination and teardown release synchronous child contexts and leases', async ({
  page
}) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', {
    waitUntil: 'domcontentloaded'
  });
  await expect
    .poll(() => page.evaluate(() => window.crossOriginIsolated), {
      timeout: 10_000
    })
    .toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const terminated = await runBlockedParent('terminated', async (runtime, parent) => {
      parent.kill('SIGTERM');
      const exitCode = await parent.exit;
      await sleep(350);
      const recovery = await runtime.spawn('echo', ['lease-recovered']);
      return {
        exitCode,
        recoveryExit: await recovery.exit,
        recoveryOutput: await collect(recovery.stdout)
      };
    });
    const tornDown = await runBlockedParent('teardown', async (runtime, parent) => {
      const completed = await Promise.race([
        runtime.teardown().then(() => true),
        sleep(2_000).then(() => false)
      ]);
      return { completed, exitCode: await parent.exit };
    });
    const rebooted = await Mimic.boot({
      workdir: '/home/synchronous-child-reboot'
    });
    const recovery = await rebooted.spawn('echo', ['runtime-rebooted']);
    const reboot = {
      exitCode: await recovery.exit,
      output: await collect(recovery.stdout)
    };
    await rebooted.teardown();
    return { terminated, tornDown, reboot };

    async function runBlockedParent<T>(
      name: string,
      stop: (
        runtime: Awaited<ReturnType<typeof Mimic.boot>>,
        parent: Awaited<ReturnType<Awaited<ReturnType<typeof Mimic.boot>>['spawn']>>
      ) => Promise<T>
    ): Promise<T & { readonly output: string }> {
      const runtime = await Mimic.boot({
        workdir: `/home/synchronous-child-${name}`
      });
      try {
        await runtime.fs.mount({
          'blocking-child.mjs': {
            file: {
              contents: [
                "console.log('sync-child-ready');",
                'await new Promise((resolve) => setTimeout(resolve, 200));',
                "console.log('sync-child-finished');"
              ].join('\n')
            }
          },
          'blocking-parent.mjs': {
            file: {
              contents: [
                "import { execFileSync } from 'node:child_process';",
                "console.log('parent-before-sync');",
                'try {',
                "  execFileSync(process.execPath, [process.cwd() + '/blocking-child.mjs'], { stdio: ['ignore', 'inherit', 'inherit'] });",
                '} catch (error) {',
                "  console.log('forbidden-parent-resumed', error.code);",
                '}',
                "console.log('forbidden-parent-continued');"
              ].join('\n')
            }
          }
        });
        const parent = await runtime.spawn('node', [
          `${runtime.workdir}/blocking-parent.mjs`
        ]);
        const capture = captureOutput(parent.stdout);
        await waitForOutput(() => capture.text, 'sync-child-ready');
        const stopped = await stop(runtime, parent);
        return { ...stopped, output: await capture.complete };
      } finally {
        await runtime.teardown();
      }
    }

    function captureOutput(stream: ReadableStream<Uint8Array>): {
      readonly text: string;
      readonly complete: Promise<string>;
    } {
      let text = '';
      const complete = (async () => {
        const reader = stream.getReader();
        const decoder = new TextDecoder();
        while (true) {
          const { done, value } = await reader.read();
          if (done) return text;
          text += decoder.decode(value, { stream: true });
        }
      })();
      return {
        get text() {
          return text;
        },
        complete
      };
    }

    async function waitForOutput(
      read: () => string,
      expected: string
    ): Promise<void> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < 5_000) {
        if (read().includes(expected)) return;
        await sleep(25);
      }
      throw new Error(`Timed out waiting for ${expected}`);
    }

    async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    }

    function sleep(milliseconds: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
  });

  expect(result.terminated.exitCode).toBe(143);
  expect(result.terminated.output).toContain('parent-before-sync');
  expect(result.terminated.output).toContain('sync-child-ready');
  expect(result.terminated.output).not.toContain('forbidden-parent-resumed');
  expect(result.terminated.output).not.toContain('forbidden-parent-continued');
  expect(result.terminated.recoveryExit).toBe(0);
  expect(result.terminated.recoveryOutput).toBe('lease-recovered\n');
  expect(result.tornDown.completed).toBe(true);
  expect(result.tornDown.exitCode).toBe(137);
  expect(result.tornDown.output).toContain('sync-child-ready');
  expect(result.reboot).toEqual({
    exitCode: 0,
    output: 'runtime-rebooted\n'
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

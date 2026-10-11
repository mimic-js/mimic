import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const wasiCompatibilityClaim = defineCompatibilityClaim({
  id: 'wasi-preview1-public-runtime-v1',
  statement: 'Mimic runs package-agnostic WASI Preview1 programs through node:wasi with VFS preopens',
  target: {
    kind: 'runtime-capability',
    capability: 'wasi-preview1-public-runtime'
  }
});

const rawWasiRuntimeProcessClaim = defineCompatibilityClaim({
  id: 'wasi-preview1-raw-runtime-process-v1',
  statement:
    'Mimic admits a package-neutral raw WASI Preview1 command as an ordinary Runtime Process',
  target: {
    kind: 'runtime-capability',
    capability: 'wasi-preview1-raw-runtime-process'
  }
});

// Generated from tests/fixtures/wasi-runtime-process.wat.
const rawWasiRuntimeProcessProgram =
  'AGFzbQEAAAABFwRgAn9/AX9gBH9/f38Bf2ABfwF/YAAAAuABBhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmFyZ3Nfc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhhcmdzX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzERZW52aXJvbl9zaXplc19nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2Vudmlyb25fZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAIDAgEDBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAYKfQF7AEEAQQQQABpBwABBgAEQARpBEEGAATYCAEEUQQQoAgA2AgBBAUEQQQFBIBAEGkEIQQwQAhpBgARBgAgQAxpBGEGACDYCAEEcQQwoAgA2AgBBAUEYQQFBJBAEGkEoQYAQNgIAQSxBEDYCAEECQShBAUEwEAQaQQcQBRoLCxcBAEGAEAsQc3RkZXJyPW9ic2VydmVkCg==';
// Generated from tests/fixtures/wasi-runtime-process-signal.wat.
const rawWasiSignalProgram =
  'AGFzbQEAAAABCAJgAAF/YAAAAiYBFndhc2lfc25hcHNob3RfcHJldmlldzELc2NoZWRfeWllbGQAAAMCAQEFAwEAAQcTAgZtZW1vcnkCAAZfc3RhcnQAAQoMAQoAA0AQABoMAAsL';
// Generated from tests/fixtures/wasi-runtime-process-poll.wat.
const rawWasiPollingProgram =
  'AGFzbQEAAAABDAJgBH9/f38Bf2AAAAImARZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC3BvbGxfb25lb2ZmAAADAgEBBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAEKJAEiAEEQQQE2AgBBGEKAsJ3C3wE3AwBBAEHAAEEBQYABEAAaCw==';

const preview1Program =
  'AGFzbQEAAAABIQVgBH9/f38Bf2ABfwBgCX9/f39/fn5/fwF/YAABf2AAAAKKAQQWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQAAFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfcmVhZAAAFndhc2lfc25hcHNob3RfcHJldmlldzEJcGF0aF9vcGVuAAIWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQlwcm9jX2V4aXQAAQMDAgMEBQQBAwEBBx8DBm1lbW9yeQIACWludmFsaWRGZAAEBl9zdGFydAAFCmMCDQBB4wBBEEEBQRgQAQtTAEEAQfgANgIAQQRBATYCAEEQQfgANgIAQRRBATYCAEEDQQBBwABBCUEAQgJCAEEAQQwQAhpBDCgCAEEQQQFBGBABGkEBQQBBAUEIEAAaQQAQAwsLEAEAQcAACwlpbnB1dC50eHQ=';

const forbiddenFallbacks = ['falling back to registered command adapter', 'esm.sh', 'host Node', 'vfsPreviewFallback'] as const;

test(rawWasiRuntimeProcessClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async ({
    programBase64,
    pollingProgramBase64,
    readerProgramBase64,
    signalProgramBase64
  }) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const program = Uint8Array.from(atob(programBase64), (character) =>
      character.charCodeAt(0)
    );
    const signalProgram = Uint8Array.from(atob(signalProgramBase64), (character) =>
      character.charCodeAt(0)
    );
    const pollingProgram = Uint8Array.from(atob(pollingProgramBase64), (character) =>
      character.charCodeAt(0)
    );
    const readerProgram = Uint8Array.from(atob(readerProgramBase64), (character) =>
      character.charCodeAt(0)
    );

    return {
      initial: await runWitness('raw-wasi-process'),
      reboot: await runWitness('raw-wasi-process-reboot')
    };

    async function runWitness(name: string) {
      const runtime = await Mimic.boot({ workdir: `/home/${name}` });
      try {
        await runtime.fs.mount({
          'direct.wasm': { file: { contents: program } },
          'reader.wasm': { file: { contents: readerProgram } },
          'polling.wasm': { file: { contents: pollingProgram } },
          'signal.wasm': { file: { contents: signalProgram } },
          bin: {
            directory: {
              'path-wasi': { file: { contents: program } },
              'wrapper-wasi': {
                file: {
                  contents:
                    `#!/bin/sh\nexec "${runtime.workdir}/direct.wasm" "$@"\n`
                }
              }
            }
          },
          node_modules: {
            directory: {
              '.bin': {
                directory: {
                  'package-wasi': { symlink: { target: '../@scope/tool/bin/tool.wasm' } }
                }
              },
              '@scope': {
                directory: {
                  tool: {
                    directory: {
                      bin: {
                        directory: {
                          'tool.wasm': { file: { contents: program } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        });
        await runtime.fs.writeFile('/input.txt', new Uint8Array([90]));
        await runtime.fs.mkdir(`${runtime.workdir}/current`, { recursive: true });

        const commands = [
          {
            command: `${runtime.workdir}/direct.wasm`,
            argument: 'direct',
            env: {}
          },
          {
            command: 'path-wasi',
            argument: 'path',
            env: { PATH: `${runtime.workdir}/bin` }
          },
          {
            command: `${runtime.workdir}/bin/wrapper-wasi`,
            argument: 'wrapper',
            env: {}
          },
          {
            command: 'package-wasi',
            argument: 'package-bin',
            env: { PATH: `${runtime.workdir}/node_modules/.bin` }
          }
        ];
        const executions = [];
        for (const command of commands) {
          const child = await runtime.spawn(command.command, [command.argument], {
            cwd: `${runtime.workdir}/current`,
            env: { ...command.env, TOKEN: name }
          });
          const [stdout, stderr, exitCode] = await Promise.all([
            collect(child.stdout),
            collect(child.stderr),
            child.exit
          ]);
          executions.push({
            command: command.command,
            argument: command.argument,
            pid: child.pid,
            exitCode,
            stdout,
            stderr
          });
        }

        const reader = await runtime.spawn(`${runtime.workdir}/reader.wasm`, [], {
          cwd: `${runtime.workdir}/current`
        });
        const [readerStdout, readerStderr, readerExitCode] = await Promise.all([
          collect(reader.stdout),
          collect(reader.stderr),
          reader.exit
        ]);

        const unsupported = replaceAscii(program, 'fd_write', 'fd_writx');
        await runtime.fs.writeFile(`${runtime.workdir}/unsupported.wasm`, unsupported);
        let unsupportedError: { name: string; code?: string; message: string } | undefined;
        try {
          await runtime.spawn(`${runtime.workdir}/unsupported.wasm`);
        } catch (error) {
          const value = error as Error & { code?: string };
          unsupportedError = { name: value.name, code: value.code, message: value.message };
        }
        const signalled = await runtime.spawn(`${runtime.workdir}/signal.wasm`);
        signalled.kill('SIGTERM');
        const signalExitCode = await signalled.exit;
        const polling = await runtime.spawn(`${runtime.workdir}/polling.wasm`);
        const pollingRemainedPending = await Promise.race([
          polling.exit.then(() => false),
          sleep(100).then(() => true)
        ]);
        const teardownCompleted = await Promise.race([
          runtime.teardown().then(() => true),
          sleep(2_000).then(() => false)
        ]);
        const pollingExitCode = await polling.exit;
        return {
          workdir: runtime.workdir,
          executions,
          reader: {
            exitCode: readerExitCode,
            stdout: readerStdout,
            stderr: readerStderr
          },
          unsupportedError,
          signalExitCode,
          polling: {
            exitCode: pollingExitCode,
            remainedPending: pollingRemainedPending,
            teardownCompleted
          }
        };
      } finally {
        await runtime.teardown();
      }
    }

    function sleep(milliseconds: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }

    async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return output;
        output += decoder.decode(value, { stream: true });
      }
    }

    function replaceAscii(bytes: Uint8Array, source: string, replacement: string): Uint8Array {
      const result = bytes.slice();
      const sourceBytes = new TextEncoder().encode(source);
      const replacementBytes = new TextEncoder().encode(replacement);
      const index = result.findIndex((_value, offset) =>
        sourceBytes.every((value, innerOffset) => result[offset + innerOffset] === value)
      );
      if (index < 0 || sourceBytes.byteLength !== replacementBytes.byteLength) {
        throw new Error('Invalid raw WASI fixture mutation.');
      }
      result.set(replacementBytes, index);
      return result;
    }
  }, {
    programBase64: rawWasiRuntimeProcessProgram,
    pollingProgramBase64: rawWasiPollingProgram,
    readerProgramBase64: preview1Program,
    signalProgramBase64: rawWasiSignalProgram
  });

  for (const witness of [result.initial, result.reboot]) {
    expect(witness.executions).toHaveLength(4);
    for (const execution of witness.executions) {
      expect(execution.pid).toBeGreaterThan(0);
      expect(execution.exitCode).toBe(7);
      expect(execution.stdout).toContain(`${execution.argument}\0`);
      expect(execution.stdout).toContain(`TOKEN=${witness.workdir.slice('/home/'.length)}\0`);
      expect(execution.stdout).toContain(`PWD=${witness.workdir}/current\0`);
      expect(execution.stderr).toBe('stderr=observed\n');
    }
    expect(witness.reader).toEqual({
      exitCode: 0,
      stdout: 'Z',
      stderr: ''
    });
    expect(witness.unsupportedError).toMatchObject({
      name: 'RuntimeProcessExecutionError',
      code: 'UNKNOWN_WASI_IMPORT'
    });
    expect(witness.signalExitCode).toBe(143);
    expect(witness.polling).toEqual({
      exitCode: 137,
      remainedPending: true,
      teardownCompleted: true
    });
  }

  const evidence = JSON.stringify(result);
  for (const forbidden of forbiddenFallbacks) {
    expect(evidence, `forbidden fallback ${forbidden}`).not.toContain(forbidden);
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

test(wasiCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async ({ preview1Program }) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();

    return {
      initial: await runWitness('wasi-preview1'),
      reboot: await runWitness('wasi-preview1-reboot')
    };

    async function runWitness(workdirName: string) {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      const cleanup = { tornDown: false };

      try {
        await runtime.fs.mount({
          preopen: {
            directory: {
              'input.txt': { file: { contents: new Uint8Array([90]) } },
              folder: {
                directory: {
                  'a.txt': { file: { contents: 'A' } },
                  alias: { symlink: { target: 'a.txt' } }
                }
              },
              escape: { symlink: { target: '/outside-secret.txt' } }
            }
          },
          'outside-secret.txt': { file: { contents: 'secret' } },
          'entry.cjs': {
            file: {
              contents: [
                "const fs = require('node:fs');",
                "const bareWasi = require('wasi');",
                "const qualifiedWasi = require('node:wasi');",
                "if (bareWasi !== qualifiedWasi || bareWasi.WASI !== qualifiedWasi.WASI) throw new Error('WASI builtin identity mismatch');",
                "const wasi = new qualifiedWasi.WASI({ version: 'preview1', preopens: { '/sandbox': '/home/' + process.env.WASI_WORKDIR + '/preopen' }, returnOnExit: true });",
                `const program = Buffer.from(${JSON.stringify(preview1Program)}, 'base64');`,
                'const wasmModule = new WebAssembly.Module(program);',
                'const abiTrace = [];',
                'let instance;',
                'const tracedImports = { ...wasi.wasiImport,',
                '  path_open: (...args) => {',
                '    const result = wasi.wasiImport.path_open(...args);',
                '    abiTrace.push({ name: \'path_open\', result, openedFd: new DataView(instance.exports.memory.buffer).getUint32(args[8], true) });',
                '    return result;',
                '  },',
                '  fd_read: (...args) => {',
                '    const result = wasi.wasiImport.fd_read(...args);',
                '    const view = new DataView(instance.exports.memory.buffer);',
                '    const target = view.getUint32(args[1], true);',
                '    abiTrace.push({ name: \'fd_read\', result, target, byte: new Uint8Array(instance.exports.memory.buffer)[target], read: view.getUint32(args[3], true) });',
                '    return result;',
                '  }',
                '};',
                'instance = new WebAssembly.Instance(wasmModule, { wasi_snapshot_preview1: tracedImports });',
                'const exitCode = wasi.start(instance);',
                'const invalidDescriptorErrno = instance.exports.invalidFd();',
                'const memory = instance.exports.memory;',
                'const view = new DataView(memory.buffer);',
                'const bytes = new Uint8Array(memory.buffer);',
                'const encoder = new TextEncoder();',
                'const decoder = new TextDecoder();',
                'const writeText = (pointer, value) => bytes.set(encoder.encode(value), pointer);',
                'const readText = (pointer, length) => decoder.decode(Uint8Array.from(bytes.subarray(pointer, pointer + length)));',
                'const readDirectory = (pointer, length) => {',
                '  const entries = [];',
                '  const end = pointer + length;',
                '  while (pointer + 24 <= end) {',
                '    const nameLength = view.getUint32(pointer + 16, true);',
                '    if (pointer + 24 + nameLength > end) break;',
                '    entries.push({ cookie: String(view.getBigUint64(pointer, true)), name: readText(pointer + 24, nameLength), type: view.getUint8(pointer + 20) });',
                '    pointer += 24 + nameLength;',
                '  }',
                '  return entries;',
                '};',
                'const fileRights = (1n << 1n) | (1n << 2n) | (1n << 5n) | (1n << 21n);',
                'const writableFileRights = fileRights | (1n << 6n);',
                'const directoryRights = (1n << 13n) | (1n << 14n) | (1n << 15n) | (1n << 18n) | (1n << 21n);',
                "writeText(4096, 'input.txt');",
                'const authoritativeOpenErrno = wasi.wasiImport.path_open(3, 0, 4096, 9, 0, fileRights, 0n, 0, 4120);',
                'const authoritativeFd = view.getUint32(4120, true);',
                "fs.writeFileSync('/home/' + process.env.WASI_WORKDIR + '/preopen/input.txt', 'updated');",
                'view.setUint32(4136, 4200, true);',
                'view.setUint32(4140, 1, true);',
                'const authoritativeReadErrno = wasi.wasiImport.fd_read(authoritativeFd, 4136, 1, 4144);',
                'view.setUint32(4152, 4216, true);',
                'view.setUint32(4156, 2, true);',
                'const preadErrno = wasi.wasiImport.fd_pread(authoritativeFd, 4152, 1, 2n, 4160);',
                'const tellErrno = wasi.wasiImport.fd_tell(authoritativeFd, 4168);',
                'view.setUint32(4176, 4224, true);',
                'view.setUint32(4180, 7, true);',
                'const remainingReadErrno = wasi.wasiImport.fd_read(authoritativeFd, 4176, 1, 4184);',
                'const eofErrno = wasi.wasiImport.fd_read(authoritativeFd, 4176, 1, 4192);',
                "writeText(4256, 'folder');",
                'const directoryOpenErrno = wasi.wasiImport.path_open(3, 0, 4256, 6, 2, directoryRights, fileRights, 0, 4272);',
                'const directoryFd = view.getUint32(4272, true);',
                'const readdirErrno = wasi.wasiImport.fd_readdir(directoryFd, 4304, 128, 0n, 4296);',
                'const directoryEntries = readDirectory(4304, view.getUint32(4296, true));',
                "writeText(4480, 'alias');",
                'const linkStatusErrno = wasi.wasiImport.path_filestat_get(directoryFd, 0, 4480, 5, 4512);',
                'const targetStatusErrno = wasi.wasiImport.path_filestat_get(directoryFd, 1, 4480, 5, 4576);',
                'const readlinkErrno = wasi.wasiImport.path_readlink(directoryFd, 4480, 5, 4640, 32, 4672);',
                "writeText(4704, 'escape');",
                'const escapeErrno = wasi.wasiImport.path_open(3, 1, 4704, 6, 0, 1n << 1n, 0n, 0, 4720);',
                // A right the runtime does not track is left out of the descriptor, as Node's WASI opens it.
                'const untrackedRightErrno = wasi.wasiImport.path_open(3, 0, 4096, 9, 0, 1n << 8n, 0n, 0, 4736);',
                "writeText(8192, 'created.txt');",
                'const createOpenErrno = wasi.wasiImport.path_open(3, 0, 8192, 11, 1, writableFileRights, 0n, 0, 8224);',
                'const createdFd = view.getUint32(8224, true);',
                "writeText(9000, 'hello');",
                'view.setUint32(8240, 9000, true);',
                'view.setUint32(8244, 5, true);',
                'const createWriteErrno = wasi.wasiImport.fd_write(createdFd, 8240, 1, 8256);',
                'const seekForOverwriteErrno = wasi.wasiImport.fd_seek(createdFd, 1n, 0, 8264);',
                "writeText(9008, 'A');",
                'view.setUint32(8272, 9008, true);',
                'view.setUint32(8276, 1, true);',
                'const overwriteErrno = wasi.wasiImport.fd_write(createdFd, 8272, 1, 8288);',
                'const appendOpenErrno = wasi.wasiImport.path_open(3, 0, 8192, 11, 0, writableFileRights, 0n, 1, 8296);',
                'const appendFd = view.getUint32(8296, true);',
                "writeText(9016, '!');",
                'view.setUint32(8312, 9016, true);',
                'view.setUint32(8316, 1, true);',
                'const appendErrno = wasi.wasiImport.fd_write(appendFd, 8312, 1, 8328);',
                'const exclusiveErrno = wasi.wasiImport.path_open(3, 0, 8192, 11, 5, writableFileRights, 0n, 0, 8336);',
                'const truncateErrno = wasi.wasiImport.path_open(3, 0, 8192, 11, 8, writableFileRights, 0n, 0, 8344);',
                'const truncatedFd = view.getUint32(8344, true);',
                'const truncatedLength = fs.readFileSync(\'/home/\' + process.env.WASI_WORKDIR + \'/preopen/created.txt\').length;',
                "writeText(9024, 'after');",
                'view.setUint32(8360, 9024, true);',
                'view.setUint32(8364, 5, true);',
                'const postTruncateWriteErrno = wasi.wasiImport.fd_write(truncatedFd, 8360, 1, 8376);',
                "writeText(8400, 'generated');",
                'const mkdirErrno = wasi.wasiImport.path_create_directory(3, 8400, 9);',
                "writeText(8420, 'generated/nested.txt');",
                'const nestedOpenErrno = wasi.wasiImport.path_open(3, 0, 8420, 20, 1, writableFileRights, 0n, 0, 8448);',
                'const nonEmptyErrno = wasi.wasiImport.path_remove_directory(3, 8400, 9);',
                'const unlinkErrno = wasi.wasiImport.path_unlink_file(3, 8420, 20);',
                'const rmdirErrno = wasi.wasiImport.path_remove_directory(3, 8400, 9);',
                "writeText(8480, 'missing/file.txt');",
                'const missingParentErrno = wasi.wasiImport.path_open(3, 0, 8480, 16, 1, writableFileRights, 0n, 0, 8504);',
                "writeText(8520, 'denied');",
                'const directoryRightsErrno = wasi.wasiImport.path_create_directory(directoryFd, 8520, 6);',
                'const invalidFlagsErrno = wasi.wasiImport.path_open(3, 0, 8192, 11, 16, writableFileRights, 0n, 0, 8544);',
                'const unlinkDirectoryErrno = wasi.wasiImport.path_unlink_file(3, 4256, 6);',
                "if (exitCode !== 0) throw new Error('WASI returnOnExit did not return status 0: ' + exitCode);",
                "if (invalidDescriptorErrno !== 8) throw new Error('WASI invalid descriptor did not return EBADF: ' + invalidDescriptorErrno);",
                'const sharedMemoryCompatible = typeof SharedArrayBuffer === \'function\' && instance.exports.memory.buffer instanceof SharedArrayBuffer;',
                "if (!sharedMemoryCompatible) throw new Error('cross-origin-isolated shared WebAssembly memory is unavailable');",
                "fs.writeFileSync('/home/' + process.env.WASI_WORKDIR + '/receipt.json', JSON.stringify({",
                '  abiTrace,',
                '  builtinIdentity: bareWasi === qualifiedWasi && bareWasi.WASI === qualifiedWasi.WASI,',
                '  returnOnExit: exitCode,',
                '  invalidDescriptorErrno,',
                '  readableNamespace: {',
                '    authoritativeOpenErrno,',
                '    authoritativeReadErrno,',
                '    firstByte: readText(4200, 1),',
                '    preadErrno,',
                '    preadBytes: readText(4216, 2),',
                '    tellErrno,',
                '    offsetAfterPread: String(view.getBigUint64(4168, true)),',
                '    remainingReadErrno,',
                '    remainingBytes: readText(4224, view.getUint32(4184, true)),',
                '    eofErrno,',
                '    eofBytes: view.getUint32(4192, true),',
                '    directoryOpenErrno,',
                '    readdirErrno,',
                '    directoryEntries,',
                '    linkStatusErrno,',
                '    linkType: view.getUint8(4528),',
                '    targetStatusErrno,',
                '    targetType: view.getUint8(4592),',
                '    readlinkErrno,',
                '    linkTarget: readText(4640, view.getUint32(4672, true)),',
                '    escapeErrno,',
                '    untrackedRightErrno',
                '  },',
                '  writableNamespace: {',
                '    createOpenErrno,',
                '    createWriteErrno,',
                '    createWritten: view.getUint32(8256, true),',
                '    seekForOverwriteErrno,',
                '    overwriteErrno,',
                '    appendOpenErrno,',
                '    appendErrno,',
                '    exclusiveErrno,',
                '    truncateErrno,',
                '    truncatedLength,',
                '    postTruncateWriteErrno,',
                '    nodeVisibleBytes: fs.readFileSync(\'/home/\' + process.env.WASI_WORKDIR + \'/preopen/created.txt\', \'utf8\'),',
                '    mkdirErrno,',
                '    nestedOpenErrno,',
                '    nonEmptyErrno,',
                '    unlinkErrno,',
                '    rmdirErrno,',
                '    missingParentErrno,',
                '    directoryRightsErrno,',
                '    invalidFlagsErrno,',
                '    unlinkDirectoryErrno',
                '  },',
                '  sharedAbiByte: new Uint8Array(instance.exports.memory.buffer)[120],',
                '  sharedMemoryCompatible,',
                '  stdoutBufferIsBuffer: Buffer.isBuffer(program),',
                '  wasmImports: WebAssembly.Module.imports(wasmModule).map((entry) => entry.module + \'.\' + entry.name)',
                '}));'
              ].join('\n')
            }
          }
        });
        await runtime.fs.writeFile('/outside-secret.txt', 'secret');
        const revisionBeforeProcess = runtime.fs.revision;

        const process = await runtime.spawn('node', ['entry.cjs'], {
          cwd: runtime.workdir,
          env: { WASI_WORKDIR: workdirName }
        });
        const stdout = await collectBytes(process.output);
        const exitCode = await process.exit;
        const receipt =
          exitCode === 0
            ? (JSON.parse(await runtime.fs.readFile(`${runtime.workdir}/receipt.json`, 'utf8')) as unknown)
            : { processFailedBeforeReceipt: true };
        const publicVisibleBytes = await runtime.fs.readFile(
          `${runtime.workdir}/preopen/created.txt`,
          'utf8'
        );
        const generatedDirectoryExists = await runtime.fs.exists(
          `${runtime.workdir}/preopen/generated`
        );

        return {
          exitCode,
          stdout: Array.from(stdout),
          decodedStdout: decoder.decode(stdout),
          receipt,
          publicVisibleBytes,
          generatedDirectoryExists,
          revisionBeforeProcess,
          revisionAfterProcess: runtime.fs.revision,
          cleanup
        };
      } finally {
        await runtime.teardown();
        cleanup.tornDown = true;
      }

      async function collectBytes(output: ReadableStream<Uint8Array>): Promise<Uint8Array> {
        const reader = output.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            size += value.byteLength;
          }
        } finally {
          reader.releaseLock();
        }

        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return bytes;
      }
    }
  }, { preview1Program });

  for (const witness of [result.initial, result.reboot]) {
    expect(witness.exitCode, witness.decodedStdout).toBe(0);
    expect(witness.stdout, JSON.stringify(witness.receipt)).toEqual([90]);
    expect(witness.decodedStdout).toBe('Z');
    expect(witness.publicVisibleBytes).toBe('after');
    expect(witness.generatedDirectoryExists).toBe(false);
    expect(witness.revisionAfterProcess).toBeGreaterThan(witness.revisionBeforeProcess);
    expect(witness.receipt).toEqual({
      abiTrace: [
        { name: 'path_open', result: 0, openedFd: 4 },
        { name: 'fd_read', result: 0, target: 120, byte: 90, read: 1 },
        { name: 'fd_read', result: 8, target: 120, byte: 90, read: 1 }
      ],
      builtinIdentity: true,
      returnOnExit: 0,
      invalidDescriptorErrno: 8,
      readableNamespace: {
        authoritativeOpenErrno: 0,
        authoritativeReadErrno: 0,
        firstByte: 'u',
        preadErrno: 0,
        preadBytes: 'da',
        tellErrno: 0,
        offsetAfterPread: '1',
        remainingReadErrno: 0,
        remainingBytes: 'pdated',
        eofErrno: 0,
        eofBytes: 0,
        directoryOpenErrno: 0,
        readdirErrno: 0,
        directoryEntries: [
          { cookie: '1', name: 'a.txt', type: 4 },
          { cookie: '2', name: 'alias', type: 7 }
        ],
        linkStatusErrno: 0,
        linkType: 7,
        targetStatusErrno: 0,
        targetType: 4,
        readlinkErrno: 0,
        linkTarget: 'a.txt',
        escapeErrno: 76,
        untrackedRightErrno: 0
      },
      writableNamespace: {
        createOpenErrno: 0,
        createWriteErrno: 0,
        createWritten: 5,
        seekForOverwriteErrno: 0,
        overwriteErrno: 0,
        appendOpenErrno: 0,
        appendErrno: 0,
        exclusiveErrno: 20,
        truncateErrno: 0,
        truncatedLength: 0,
        postTruncateWriteErrno: 0,
        nodeVisibleBytes: 'after',
        mkdirErrno: 0,
        nestedOpenErrno: 0,
        nonEmptyErrno: 55,
        unlinkErrno: 0,
        rmdirErrno: 0,
        missingParentErrno: 44,
        directoryRightsErrno: 76,
        invalidFlagsErrno: 28,
        unlinkDirectoryErrno: 31
      },
      sharedAbiByte: 90,
      sharedMemoryCompatible: true,
      stdoutBufferIsBuffer: true,
      wasmImports: [
        'wasi_snapshot_preview1.fd_write',
        'wasi_snapshot_preview1.fd_read',
        'wasi_snapshot_preview1.path_open',
        'wasi_snapshot_preview1.proc_exit'
      ]
    });
    expect(witness.cleanup).toEqual({ tornDown: true });
  }

  const evidence = [
    result.initial.decodedStdout,
    result.reboot.decodedStdout,
    ...pageErrors,
    ...consoleErrors
  ].join('\n');
  for (const forbidden of forbiddenFallbacks) {
    expect(evidence, `forbidden fallback ${forbidden}`).not.toContain(forbidden);
  }
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

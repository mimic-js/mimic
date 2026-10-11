import { describe, expect, test } from 'vitest';

import {
  resolveExecutable,
  resolveInlineNodeEntry,
  type InlineNodeEntry
} from '../../src/runtime/modules/process-execution/executable-resolution';
import {
  inspectWasiPreview1Executable,
  WASI_PREVIEW1_RUNTIME_PROGRAM_ID
} from '../../src/runtime/modules/wasi-execution';

// Generated from tests/fixtures/wasi-runtime-process.wat.
const wasiRuntimeProcessProgram = Uint8Array.from(
  Buffer.from(
    'AGFzbQEAAAABFwRgAn9/AX9gBH9/f38Bf2ABfwF/YAAAAuABBhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmFyZ3Nfc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhhcmdzX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzERZW52aXJvbl9zaXplc19nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2Vudmlyb25fZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAIDAgEDBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAYKfQF7AEEAQQQQABpBwABBgAEQARpBEEGAATYCAEEUQQQoAgA2AgBBAUEQQQFBIBAEGkEIQQwQAhpBgARBgAgQAxpBGEGACDYCAEEcQQwoAgA2AgBBAUEYQQFBJBAEGkEoQYAQNgIAQSxBEDYCAEECQShBAUEwEAQaQQcQBRoLCxcBAEGAEAsQc3RkZXJyPW9ic2VydmVkCg==',
    'base64'
  )
);

describe('Process Execution executable resolution', () => {
  test('resolves an exact configured runtime program into an immutable descriptor without changing its request', async () => {
    const request = {
      command: 'node',
      args: ['entry.mjs', '--flag'],
      cwd: '/home/project',
      env: { PATH: '/tools:/bin', KEEP: 'value' },
      parentPid: 17
    };

    const result = await resolveExecutable(request, {
      fileSystem: files({}),
      runtimePrograms: [{ id: 'runtime-node', commands: ['node', '/usr/bin/node'] }],
      javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: ['/usr/bin/node'] }
    });

    expect(result).toEqual({
      ok: true,
      value: {
        programId: 'runtime-node',
        argv: ['entry.mjs', '--flag'],
        provenance: { kind: 'runtime-program', command: 'node', paths: [] }
      }
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.argv)).toBe(true);
    expect(Object.isFrozen(result.value.provenance)).toBe(true);
    expect(Object.isFrozen(result.value.provenance.paths)).toBe(true);
    expect(request).toEqual({
      command: 'node',
      args: ['entry.mjs', '--flag'],
      cwd: '/home/project',
      env: { PATH: '/tools:/bin', KEEP: 'value' },
      parentPid: 17
    });
  });

  test("runs a package's own copy of a toolchain the runtime provides as that runtime program", async () => {
    const options = {
      fileSystem: files({
        '/home/project/node_modules/node-gyp/bin/node-gyp.js': '#!/usr/bin/env node\nrequire("../lib/node-gyp")',
        '/home/project/node_modules/.bin/node-gyp': '#!/usr/bin/env node\nrequire("../node-gyp/lib/node-gyp")'
      }),
      runtimePrograms: [
        { id: 'runtime-node', commands: ['node', '/usr/bin/node'] },
        { id: 'node-gyp', commands: ['node-gyp'] }
      ],
      scriptPrograms: [{ programId: 'node-gyp', pathSuffix: '/node_modules/node-gyp/bin/node-gyp.js' }],
      javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: ['/usr/bin/node'] }
    };
    const request = (command: string, args: string[]) => ({ command, args, cwd: '/home/project', env: { PATH: '' }, parentPid: 1 });

    // node-gyp-build spawns the copy it resolves through `process.execPath`.
    const byNode = await resolveExecutable(
      request('/usr/bin/node', ['/home/project/node_modules/node-gyp/bin/node-gyp.js', 'rebuild']),
      options
    );
    const byFile = await resolveExecutable(request('./node_modules/node-gyp/bin/node-gyp.js', ['configure']), options);
    const otherScript = await resolveExecutable(request('node', ['/home/project/tools/node-gyp.js']), options);

    expect(byNode).toMatchObject({ ok: true, value: { programId: 'node-gyp', argv: ['rebuild'] } });
    expect(byFile).toMatchObject({ ok: true, value: { programId: 'node-gyp', argv: ['configure'] } });
    expect(otherScript).toMatchObject({ ok: true, value: { programId: 'runtime-node' } });
  });

  test('captures an immutable inline Node entry before process admission', async () => {
    const result = await resolveExecutable(
      {
        command: 'node',
        args: ['--require', './preload.cjs', '-e', 'console.log(process.argv)', 'application-arg'],
        cwd: '/home/project',
        env: {},
        parentPid: 7
      },
      {
        fileSystem: files({}),
        runtimePrograms: [{ id: 'runtime-node', commands: ['node', '/usr/bin/node'] }],
        javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: ['/usr/bin/node'] }
      }
    );

    expect(result).toEqual({
      ok: true,
      value: {
        programId: 'runtime-node',
        argv: ['--require', './preload.cjs', '-e', 'console.log(process.argv)', 'application-arg'],
        inlineEntry: {
          source: 'console.log(process.argv)',
          applicationArgs: ['application-arg'],
          execArgv: ['--require', './preload.cjs', '-e', 'console.log(process.argv)'],
          preloadArgv: ['--require', './preload.cjs']
        },
        provenance: { kind: 'runtime-program', command: 'node', paths: [] }
      }
    });
    if (!result.ok || !result.value.inlineEntry) throw new Error('Expected an inline Node entry.');
    expect(Object.isFrozen(result.value.inlineEntry)).toBe(true);
    expect(Object.isFrozen(result.value.inlineEntry.applicationArgs)).toBe(true);
    expect(Object.isFrozen(result.value.inlineEntry.execArgv)).toBe(true);
    expect(Object.isFrozen(result.value.inlineEntry.preloadArgv)).toBe(true);
  });

  test('exposes typed immutable inline-entry metadata for nested execution owners', () => {
    const resolution = resolveInlineNodeEntry([
      '--import',
      './preload.mjs',
      '--eval=console.log(process.argv)',
      'application-arg'
    ]);
    if (!resolution?.ok) {
      throw new Error('Expected typed inline Node entry metadata.');
    }

    const entry: InlineNodeEntry = resolution.value;
    expect(entry).toEqual({
      source: 'console.log(process.argv)',
      applicationArgs: ['application-arg'],
      execArgv: [
        '--import',
        './preload.mjs',
        '--eval=console.log(process.argv)'
      ],
      preloadArgv: ['--import', './preload.mjs']
    });
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.applicationArgs)).toBe(true);
    expect(Object.isFrozen(entry.execArgv)).toBe(true);
    expect(Object.isFrozen(entry.preloadArgv)).toBe(true);
  });

  test('uses PATH entries in order and forwards arguments to the resolved file program', async () => {
    const result = await resolveExecutable(
      {
        command: 'tool',
        args: ['one', 'two'],
        cwd: '/home/project',
        env: { PATH: '/first:/second' },
        parentPid: 0
      },
      {
        fileSystem: files({
          '/first/tool': 'console.log("first");',
          '/second/tool': 'console.log("second");'
        }),
        runtimePrograms: [{ id: 'runtime-node', commands: ['node', '/usr/bin/node'] }],
        javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: ['/usr/bin/node'] }
      }
    );

    expect(result).toEqual({
      ok: true,
      value: {
        programId: 'runtime-node',
        argv: ['/first/tool', 'one', 'two'],
        provenance: { kind: 'path', command: 'tool', paths: ['/first/tool'] }
      }
    });
  });

  test('recognizes configured JavaScript shebangs for a relative executable path', async () => {
    const result = await resolveExecutable(
      {
        command: './scripts/serve',
        args: ['--port', '4173'],
        cwd: '/home/project',
        env: { PATH: '/ignored' },
        parentPid: 0
      },
      {
        fileSystem: files({
          '/home/project/scripts/serve': '#!/usr/bin/env browser-js\nconsole.log("serve");\n'
        }),
        runtimePrograms: [{ id: 'runtime-node', commands: ['node'] }],
        javaScript: {
          programId: 'runtime-browser-js',
          interpreterNames: ['browser-js'],
          interpreterPaths: ['/runtime/browser-js']
        }
      }
    );

    expect(result).toEqual({
      ok: true,
      value: {
        programId: 'runtime-browser-js',
        argv: ['/home/project/scripts/serve', '--port', '4173'],
        provenance: { kind: 'shebang', command: './scripts/serve', paths: ['/home/project/scripts/serve'] }
      }
    });
  });

  test('follows a POSIX exec wrapper and preserves its fixed plus forwarded argv', async () => {
    const result = await resolveExecutable(
      {
        command: '/home/project/bin/wrapped',
        args: ['forwarded'],
        cwd: '/home/project',
        env: {},
        parentPid: 9
      },
      {
        fileSystem: files({
          '/home/project/bin/wrapped': '#!/bin/sh\nexec "/usr/bin/node" \'/home/project/program.mjs\' "$@"\n'
        }),
        runtimePrograms: [{ id: 'runtime-node', commands: ['node', '/usr/bin/node'] }],
        javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: ['/usr/bin/node'] }
      }
    );

    expect(result).toEqual({
      ok: true,
      value: {
        programId: 'runtime-node',
        argv: ['/home/project/program.mjs', 'forwarded'],
        provenance: { kind: 'shell-wrapper', command: '/home/project/bin/wrapped', paths: ['/home/project/bin/wrapped'] }
      }
    });
  });

  test('runs the file a package manager\'s bin link points at, under its own path', async () => {
    const options = {
      fileSystem: files(
        {
          '/home/project/node_modules/@scope/package/bin/tool.mjs': 'console.log("package bin");',
          '/home/project/scripts/command.mjs': 'console.log("command");'
        },
        {
          '/home/project/node_modules/.bin/tool': '/home/project/node_modules/@scope/package/bin/tool.mjs',
          '/home/project/bin/shortcut': '/home/project/scripts/command.mjs'
        }
      ),
      runtimePrograms: [] as const,
      javaScript: { programId: 'runtime-browser-js', interpreterNames: ['browser-js'], interpreterPaths: ['/runtime/browser-js'] }
    };

    const packageBin = await resolveExecutable(
      {
        command: 'tool',
        args: ['package-arg'],
        cwd: '/home/project',
        env: { PATH: '/home/project/node_modules/.bin' },
        parentPid: 0
      },
      options
    );
    const shortcut = await resolveExecutable(
      {
        command: '/home/project/bin/shortcut',
        args: ['command-arg'],
        cwd: '/home/project',
        env: {},
        parentPid: 0
      },
      options
    );

    expect(packageBin).toEqual({
      ok: true,
      value: {
        programId: 'runtime-browser-js',
        argv: ['/home/project/node_modules/@scope/package/bin/tool.mjs', 'package-arg'],
        provenance: {
          kind: 'path',
          command: 'tool',
          paths: ['/home/project/node_modules/@scope/package/bin/tool.mjs']
        }
      }
    });
    expect(shortcut).toEqual({
      ok: true,
      value: {
        programId: 'runtime-browser-js',
        argv: ['/home/project/scripts/command.mjs', 'command-arg'],
        provenance: {
          kind: 'file',
          command: '/home/project/bin/shortcut',
          paths: ['/home/project/scripts/command.mjs']
        }
      }
    });
  });

  test('classifies the final direct, PATH, wrapper, and bin-link target as one generic WASI Runtime Program', async () => {
    const options = {
      fileSystem: files(
        {
          '/home/project/wrapped-wasi':
            '#!/bin/sh\nexec "./direct.wasm" "$@"\n',
          '/home/project/direct.wasm': wasiRuntimeProcessProgram,
          '/home/project/bin/path-wasi': wasiRuntimeProcessProgram,
          '/home/project/node_modules/@scope/tool/bin/tool.wasm': wasiRuntimeProcessProgram
        },
        { '/home/project/node_modules/.bin/package-wasi': '/home/project/node_modules/@scope/tool/bin/tool.wasm' }
      ),
      runtimePrograms: [{
        id: WASI_PREVIEW1_RUNTIME_PROGRAM_ID,
        commands: [] as const,
        inspect: inspectWasiPreview1Executable
      }],
      javaScript: {
        programId: 'runtime-browser-js',
        interpreterNames: ['browser-js'],
        interpreterPaths: ['/runtime/browser-js']
      }
    };

    const requests = [
      { command: './direct.wasm', env: {}, expectedKind: 'file' },
      {
        command: './wrapped-wasi',
        env: {},
        expectedKind: 'shell-wrapper'
      },
      { command: 'path-wasi', env: { PATH: '/home/project/bin' }, expectedKind: 'path' },
      {
        command: 'package-wasi',
        env: { PATH: '/home/project/node_modules/.bin' },
        expectedKind: 'path'
      }
    ] as const;

    for (const request of requests) {
      const result = await resolveExecutable(
        {
          command: request.command,
          args: ['argument'],
          cwd: '/home/project',
          env: request.env,
          parentPid: 0
        },
        options
      );

      expect(result).toMatchObject({
        ok: true,
        value: {
          programId: WASI_PREVIEW1_RUNTIME_PROGRAM_ID,
          argv: [expect.stringMatching(/\.wasm$|path-wasi$/), 'argument'],
          provenance: { kind: request.expectedKind, command: request.command }
        }
      });
    }
  });

  test('fails closed for WASM libraries, unsupported ABIs, and unknown imports', async () => {
    const optionsFor = (bytes: Uint8Array) => ({
      fileSystem: files({ '/home/project/tool.wasm': bytes }),
      runtimePrograms: [{
        id: WASI_PREVIEW1_RUNTIME_PROGRAM_ID,
        commands: [] as const,
        inspect: inspectWasiPreview1Executable
      }],
      javaScript: {
        programId: 'runtime-browser-js',
        interpreterNames: ['browser-js'],
        interpreterPaths: ['/runtime/browser-js']
      }
    });

    const library = replaceAscii(wasiRuntimeProcessProgram, '_start', '_lib__');
    const unsupportedAbi = replaceAscii(
      wasiRuntimeProcessProgram,
      'wasi_snapshot_preview1',
      'wasi_unsupported_abi__'
    );
    const unknownImport = replaceAscii(wasiRuntimeProcessProgram, 'fd_write', 'fd_writx');

    for (const [bytes, code] of [
      [library, 'WASI_EXECUTABLE_LIBRARY'],
      [unsupportedAbi, 'UNSUPPORTED_WASI_ABI'],
      [unknownImport, 'UNKNOWN_WASI_IMPORT']
    ] as const) {
      await expect(
        resolveExecutable(
          {
            command: './tool.wasm',
            args: [],
            cwd: '/home/project',
            env: {},
            parentPid: 0
          },
          optionsFor(bytes)
        )
      ).resolves.toMatchObject({ ok: false, error: { code } });
    }
  });

  test('selects the interpreter by basename and passes shebang arguments before the script path', async () => {
    const options = {
      fileSystem: files({
        '/bin/env-split': '#!/usr/bin/env -S node --enable-source-maps --no-warnings\n',
        '/bin/env-args': '#!/usr/bin/env node --inspect\n',
        '/bin/env-attached': '#!/usr/bin/env -Snode\n',
        '/bin/local-node': '#!/usr/local/bin/node\n',
        '/bin/local-node-flag': '#! /opt/node/bin/node --max-old-space-size=64\n',
        '/bin/env-assignment': '#!/usr/bin/env -S NODE_ENV=test node\n',
        '/bin/env-python': '#!/usr/bin/env python3\n'
      }),
      runtimePrograms: [{ id: 'runtime-node', commands: ['node', '/usr/bin/node'] }] as const,
      javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: ['/usr/bin/node'] }
    };
    const resolve = (command: string) =>
      resolveExecutable({ command, args: ['arg'], cwd: '/', env: {}, parentPid: 0 }, options);
    const shebang = (path: string, argv: string[]) => ({
      ok: true,
      value: {
        programId: 'runtime-node',
        argv,
        provenance: { kind: 'shebang', command: path, paths: [path] }
      }
    });

    await expect(resolve('/bin/env-split')).resolves.toEqual(
      shebang('/bin/env-split', ['--enable-source-maps', '--no-warnings', '/bin/env-split', 'arg'])
    );
    await expect(resolve('/bin/env-args')).resolves.toEqual(
      shebang('/bin/env-args', ['--inspect', '/bin/env-args', 'arg'])
    );
    await expect(resolve('/bin/env-attached')).resolves.toEqual(
      shebang('/bin/env-attached', ['/bin/env-attached', 'arg'])
    );
    await expect(resolve('/bin/local-node')).resolves.toEqual(
      shebang('/bin/local-node', ['/bin/local-node', 'arg'])
    );
    await expect(resolve('/bin/local-node-flag')).resolves.toEqual(
      shebang('/bin/local-node-flag', ['--max-old-space-size=64', '/bin/local-node-flag', 'arg'])
    );
    for (const unsupported of ['/bin/env-assignment', '/bin/env-python']) {
      await expect(resolve(unsupported)).resolves.toMatchObject({
        ok: false,
        error: { code: 'UNSUPPORTED_INTERPRETER', command: unsupported }
      });
    }
  });

  test('runs shell shebang scripts through the configured Shell Program', async () => {
    const fileSystem = files({
      '/bin/posix': '#!/bin/sh\nset -e\nnode build.mjs\n',
      '/bin/env-sh': '#!/usr/bin/env sh\necho hi\n',
      '/bin/env-bash': '#!/usr/bin/env bash\necho hi\n',
      '/bin/bash-flag': '#!/bin/bash -e\necho hi\n',
      '/bin/wrapper': '#!/bin/sh\nexec node /lib/cli.mjs "$@"\n',
      '/lib/cli.mjs': 'console.log("cli")'
    });
    const options = {
      fileSystem,
      runtimePrograms: [
        { id: 'runtime-node', commands: ['node'] },
        { id: 'runtime-sh', commands: ['sh', '/bin/sh'] }
      ] as const,
      javaScript: { programId: 'runtime-node', interpreterNames: ['node'], interpreterPaths: [] },
      shell: { programId: 'runtime-sh', interpreterNames: ['sh', 'bash'] }
    };
    const resolve = (command: string, configured = options) =>
      resolveExecutable({ command, args: ['arg'], cwd: '/', env: {}, parentPid: 0 }, configured);

    for (const [path, flags] of [
      ['/bin/posix', []],
      ['/bin/env-sh', []],
      ['/bin/env-bash', []],
      ['/bin/bash-flag', ['-e']]
    ] as const) {
      await expect(resolve(path)).resolves.toEqual({
        ok: true,
        value: {
          programId: 'runtime-sh',
          argv: [...flags, path, 'arg'],
          provenance: { kind: 'shebang', command: path, paths: [path] }
        }
      });
    }
    // A pure `exec … "$@"` wrapper still resolves straight to its target.
    await expect(resolve('/bin/wrapper')).resolves.toMatchObject({
      ok: true,
      value: { programId: 'runtime-node', argv: ['/lib/cli.mjs', 'arg'], provenance: { kind: 'shell-wrapper' } }
    });
    const { shell: _shell, ...withoutShell } = options;
    await expect(resolve('/bin/posix', withoutShell)).resolves.toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_INTERPRETER' }
    });
  });

  test('reports structured not-found, unsupported-interpreter, and cycle failures', async () => {
    const options = {
      fileSystem: files({
        '/home/project/bin/python-tool': '#!/usr/bin/python3\nprint("unsupported")\n',
        '/home/project/bin/loop': '#!/bin/sh\nexec /home/project/bin/loop "$@"\n'
      }),
      runtimePrograms: [] as const,
      javaScript: { programId: 'runtime-browser-js', interpreterNames: ['browser-js'], interpreterPaths: ['/runtime/browser-js'] }
    };

    const missing = await resolveExecutable(
      { command: 'missing', args: [], cwd: '/home/project', env: { PATH: '/home/project/bin' }, parentPid: 0 },
      options
    );
    const unsupported = await resolveExecutable(
      { command: '/home/project/bin/python-tool', args: [], cwd: '/home/project', env: {}, parentPid: 0 },
      options
    );
    const cycle = await resolveExecutable(
      { command: '/home/project/bin/loop', args: [], cwd: '/home/project', env: {}, parentPid: 0 },
      options
    );

    expect(missing).toMatchObject({
      ok: false,
      error: { code: 'EXECUTABLE_NOT_FOUND', command: 'missing', paths: ['/home/project/bin/missing'] }
    });
    expect(unsupported).toMatchObject({
      ok: false,
      error: { code: 'UNSUPPORTED_INTERPRETER', command: '/home/project/bin/python-tool' }
    });
    expect(cycle).toMatchObject({
      ok: false,
      error: {
        code: 'RESOLUTION_CYCLE',
        command: '/home/project/bin/loop',
        paths: ['/home/project/bin/loop', '/home/project/bin/loop']
      }
    });
  });
});

/** Files by absolute path, and symbolic links by absolute path to their absolute target. */
function files(initial: Record<string, string | Uint8Array>, links: Record<string, string> = {}) {
  const source = new Map(Object.entries(initial));
  const realpath = (path: string): string => {
    let current = path;
    for (let hops = 0; links[current] !== undefined && hops < 32; hops += 1) current = links[current]!;
    return current;
  };
  return {
    normalizePath(input: string, cwd: string): string {
      const absolute = input.startsWith('/') ? input : `${cwd}/${input}`;
      const parts: string[] = [];
      for (const segment of absolute.split('/')) {
        if (!segment || segment === '.') continue;
        if (segment === '..') parts.pop();
        else parts.push(segment);
      }
      return `/${parts.join('/')}`;
    },
    isFile(path: string): boolean {
      return source.has(realpath(path));
    },
    realpath,
    readText(path: string): string {
      const value = source.get(realpath(path));
      if (value === undefined) throw new Error(`Missing test file: ${path}`);
      return typeof value === 'string' ? value : new TextDecoder().decode(value);
    },
    readBytes(path: string): Uint8Array {
      const value = source.get(realpath(path));
      if (value === undefined) throw new Error(`Missing test file: ${path}`);
      return typeof value === 'string' ? new TextEncoder().encode(value) : value.slice();
    }
  };
}

function replaceAscii(bytes: Uint8Array, source: string, replacement: string): Uint8Array {
  expect(replacement).toHaveLength(source.length);
  const result = bytes.slice();
  const sourceBytes = new TextEncoder().encode(source);
  const replacementBytes = new TextEncoder().encode(replacement);
  const index = result.findIndex((_value, offset) =>
    sourceBytes.every((value, innerOffset) => result[offset + innerOffset] === value)
  );
  expect(index).toBeGreaterThanOrEqual(0);
  result.set(replacementBytes, index);
  return result;
}

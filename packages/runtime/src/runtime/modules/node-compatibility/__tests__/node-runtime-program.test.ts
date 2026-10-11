import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import * as Babel from '../../runtime-host/runtime-artifact-compiler-babel';

import { createRuntimeArtifactTranslator } from '../../module-execution-engine';
import { NodeCommand } from '../node-runtime-program';
import { testMacrotaskQueue, testProcessPorts } from './test-process-ports';
import type { ProcessWriter } from '../../process-execution';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';
import { createVirtualNetworkAuthority } from '../../virtual-network';

const compile = createRuntimeArtifactTranslator(Babel);

type RuntimeProgramContext = Parameters<NodeCommand['run']>[1];

type NodeRun = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

async function runNode(
  args: readonly string[],
  files: Readonly<Record<string, string>> = {},
  context: Partial<RuntimeProgramContext> = {}
): Promise<NodeRun> {
  const fs = new VirtualFileSystem('/home/project');
  for (const [path, source] of Object.entries(files)) {
    await fs.mkdir(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    await fs.writeFile(path, source);
  }
  const collect = (chunks: string[]): ProcessWriter => ({
    write(chunk) {
      chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
    },
    close() {},
    fail() {},
    waitForKill: () => new Promise(() => undefined)
  });
  const stdout: string[] = [];
  const stderr: string[] = [];
  const exitCode = await new NodeCommand(compile, testMacrotaskQueue).run(args, {
    cwd: '/home/project',
    env: {},
    fs,
    writer: collect(stdout),
    errorWriter: collect(stderr),
    emitter: {},
    virtualNetwork: createVirtualNetworkAuthority(),
    ...testProcessPorts(),
    ...context
  });
  return { exitCode, stdout: stdout.join(''), stderr: stderr.join('') };
}

const PRINT_INVOCATION = "console.log(JSON.stringify({ argv: process.argv.slice(2), execArgv: process.execArgv }));";

describe('node command line', () => {
  test('accepts V8 and Node options with no effect here and reports them in process.execArgv', async () => {
    const options = [
      '--max-old-space-size=4096',
      '--max_semi_space_size',
      '64',
      '--enable-source-maps',
      '--no-warnings',
      '--experimental-vm-modules',
      '--inspect=9229',
      '--stack-trace-limit',
      '50',
      '--unhandled-rejections=strict',
      '--title',
      'worker'
    ];
    const run = await runNode([...options, 'a.cjs', '--flag', 'value'], {
      '/home/project/a.cjs': `${PRINT_INVOCATION}\nconsole.log(process.title);`
    });

    expect(run).toMatchObject({ exitCode: 0, stderr: '' });
    const [invocation, title] = run.stdout.trimEnd().split('\n');
    expect(JSON.parse(invocation!)).toEqual({ argv: ['--flag', 'value'], execArgv: options });
    expect(title).toBe('worker');
  });

  test.each([['--version'], ['-v']])('%s prints the Node version', async (option) => {
    await expect(runNode([option])).resolves.toEqual({ exitCode: 0, stdout: 'v22.22.3\n', stderr: '' });
  });

  test.each([
    { args: ['-p', '6 * 7'], stdout: '42\n' },
    { args: ['--print', "require('./package.json').version"], stdout: '1.2.3\n' },
    { args: ['-pe', '({ a: [1, 2] })'], stdout: '{ a: [ 1, 2 ] }\n' },
    { args: ['-p', '-e', 'const a = 2; a + 1'], stdout: '3\n' },
    { args: ['-p', 'process.argv.slice(1)', 'one', '--two'], stdout: "[ 'one', '--two' ]\n" }
  ])('prints the completion value of $args', async ({ args, stdout }) => {
    const run = await runNode(args, { '/home/project/package.json': '{"version":"1.2.3"}' });

    expect(run).toEqual({ exitCode: 0, stdout, stderr: '' });
  });

  test('evaluates inline source and keeps options after it out of the application arguments', async () => {
    const source = 'console.log(JSON.stringify({ argv: process.argv.slice(1), execArgv: process.execArgv }));';
    const run = await runNode(['-e', source, '--no-warnings', 'first', '--second']);

    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      argv: ['first', '--second'],
      execArgv: ['-e', source, '--no-warnings']
    });
  });

  test('--input-type evaluates inline source as an ES module and rejects a file entry', async () => {
    const source = "import { basename } from 'node:path'; console.log(basename(import.meta.url), typeof require);";

    const inline = await runNode(['--input-type=module', '-e', source]);
    expect(inline).toMatchObject({ exitCode: 0, stderr: '' });
    expect(inline.stdout).toMatch(/\.mjs undefined\n$/);

    await expect(runNode(['--input-type=module', 'a.cjs'], { '/home/project/a.cjs': '' })).resolves.toEqual({
      exitCode: 9,
      stdout: '',
      stderr: 'node: --input-type can only be used with string input via --eval or --print\n'
    });
    await expect(runNode(['--input-type=module', '-p', '1'])).resolves.toMatchObject({
      exitCode: 9,
      stderr: 'node: --print cannot be used with ESM input\n'
    });
  });

  test('--conditions selects conditional exports in either spelling', async () => {
    const files = {
      '/home/project/node_modules/conditional/package.json': JSON.stringify({
        name: 'conditional',
        exports: { custom: './custom.js', default: './default.js' }
      }),
      '/home/project/node_modules/conditional/custom.js': "module.exports = 'custom';",
      '/home/project/node_modules/conditional/default.js': "module.exports = 'default';",
      '/home/project/a.cjs': "console.log(require('conditional'));"
    };

    await expect(runNode(['a.cjs'], files)).resolves.toMatchObject({ stdout: 'default\n' });
    await expect(runNode(['--conditions=custom', 'a.cjs'], files)).resolves.toMatchObject({ stdout: 'custom\n' });
    await expect(runNode(['-C', 'custom', 'a.cjs'], files)).resolves.toMatchObject({ stdout: 'custom\n' });
    await expect(runNode(['-C', 'custom', '-p', "require('conditional')"], files)).resolves.toMatchObject({
      stdout: 'custom\n'
    });
  });

  test('-- ends the options, so what follows is the entry and its arguments', async () => {
    const run = await runNode(['--no-warnings', '--', '--entry.cjs', '--version'], {
      '/home/project/--entry.cjs': PRINT_INVOCATION
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ argv: ['--version'], execArgv: ['--no-warnings'] });
  });

  test.each([
    { args: ['--not-a-node-option', 'a.cjs'], stderr: 'node: bad option: --not-a-node-option\n' },
    { args: ['-x', 'a.cjs'], stderr: 'node: bad option: -x\n' },
    { args: ['--no-require', 'a.cjs'], stderr: 'node: bad option: --no-require\n' },
    { args: ['-e'], stderr: 'node: -e requires an argument\n' },
    { args: ['--input-type=script', '-e', '1'], stderr: 'node: --input-type must be "module" or "commonjs"\n' },
    { args: ['--env-file=missing.env', 'a.cjs'], stderr: 'node: missing.env: not found\n' }
  ])('fails $args with exit code 9', async ({ args, stderr }) => {
    await expect(runNode(args, { '/home/project/a.cjs': "console.log('ran');" })).resolves.toEqual({
      exitCode: 9,
      stdout: '',
      stderr
    });
  });

  test('--env-file adds variables the environment does not already define', async () => {
    const run = await runNode(
      ['--env-file=.env', '--env-file-if-exists=absent.env', '-p', '[process.env.FROM_FILE, process.env.KEPT]'],
      { '/home/project/.env': 'FROM_FILE=file\nKEPT=file\n' },
      { env: { KEPT: 'environment' } }
    );

    expect(run).toEqual({ exitCode: 0, stdout: "[ 'file', 'environment' ]\n", stderr: '' });
  });
  test('a cluster worker started from a file takes NODE_UNIQUE_ID out of its environment, as Node does', async () => {
    const probe = "const cluster = require('node:cluster'); " +
      'console.log(JSON.stringify([process.env.NODE_UNIQUE_ID ?? null, cluster.isWorker, cluster.worker.id]));';
    const fromFile = await runNode(['worker.js'], { '/home/project/worker.js': probe }, { env: { NODE_UNIQUE_ID: '3' } });
    // Node starts the cluster worker only for a file entry: inline source keeps the variable.
    const inline = await runNode(['-e', probe], {}, { env: { NODE_UNIQUE_ID: '3' } });

    expect(fromFile).toEqual({ exitCode: 0, stdout: '[null,true,3]\n', stderr: '' });
    expect(inline).toEqual({ exitCode: 0, stdout: '["3",true,3]\n', stderr: '' });
  });
});

describe('process and console', () => {
  test('console formats through util.format and util.inspect and writes to the process stdio', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "console.log('%d items %s', 3, 'x');",
        "console.log({ a: undefined, m: new Map([[1, 2]]), f() {} }, undefined, 'text', [1, 'two']);",
        "console.dir({ nested: { deep: { deeper: { deepest: 1 } } } }, { depth: 0 });",
        "console.group('group');",
        "console.info('inside');",
        'console.groupEnd();',
        "console.table([{ a: 1, b: 'x' }, { a: 2 }]);",
        "console.count(); console.count();",
        "console.time('t'); console.timeEnd('t');",
        "console.warn('warned %o', [1]);",
        "console.assert(false, 'broken %s', 'thing');",
        "const { log } = console; log('detached');",
        "const write = process.stdout.write; process.stdout.write = (chunk) => write.call(process.stdout, `patched:${chunk}`);",
        "console.log('through stdout');"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout.replace(/t: [\d.]+ms/, 't: <time>')).toBe(
      [
        '3 items x',
        "{ a: undefined, m: Map(1) { 1 => 2 }, f: [Function: f] } undefined text [ 1, 'two' ]",
        '{ nested: [Object] }',
        'group',
        '  inside',
        '┌─────────┬───┬─────┐',
        '│ (index) │ a │ b   │',
        '├─────────┼───┼─────┤',
        "│ 0       │ 1 │ 'x' │",
        '│ 1       │ 2 │     │',
        '└─────────┴───┴─────┘',
        'default: 1',
        'default: 2',
        't: <time>',
        'detached',
        'patched:through stdout',
        ''
      ].join('\n')
    );
    expect(run.stderr).toBe('warned [ 1, [length]: 1 ]\nAssertion failed: broken thing\n');
  });

  test('process stdio are stream instances with end, pipe, fd, columns, and rows', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "const { Readable, Writable } = require('node:stream');",
        "const { EventEmitter } = require('node:events');",
        'const describe = (stream) => [stream.fd, stream.isTTY, stream.columns, stream.rows];',
        'console.log(JSON.stringify({',
        '  types: [process.stdin instanceof Readable, process.stdout instanceof Writable, process.stderr instanceof Writable],',
        '  emitter: process instanceof EventEmitter,',
        '  methods: [typeof process.stdin.pipe, typeof process.stdout.end, typeof process.stderr.end],',
        '  stdin: process.stdin.fd,',
        '  stdout: describe(process.stdout),',
        '  stderr: describe(process.stderr)',
        '}));',
        "Readable.from(['piped ', 'through\\n']).pipe(process.stdout);"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    const [summary, piped] = run.stdout.trimEnd().split('\n');
    expect(JSON.parse(summary!)).toEqual({
      types: [true, true, true],
      emitter: true,
      methods: ['function', 'function', 'function'],
      stdin: 0,
      stdout: [1, false, 80, 24],
      stderr: [2, false, 80, 24]
    });
    expect(piped).toBe('piped through');
  });

  test('descriptors 1 and 2 write to the process stdout and stderr, past a patched write', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "const fs = require('node:fs');",
        "process.stdout.write = () => { throw new Error('patched'); };",
        "fs.writeSync(1, 'sync out\\n');",
        "fs.writeSync(2, Buffer.from('sync err\\n'));",
        "fs.write(1, 'async out\\n', (error, written) => fs.writeSync(1, `${error} ${written}\\n`));"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('sync out\nasync out\nnull 10\n');
    expect(run.stderr).toBe('sync err\n');
  });

  test('util.promisify of setTimeout and setImmediate resolves with the value, as timers/promises does', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "const { promisify } = require('node:util');",
        'void (async () => {',
        "  const values = [await promisify(setTimeout)(1, 'timeout'), await promisify(setImmediate)('immediate')];",
        '  console.log(JSON.stringify(values));',
        '})();'
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual(['timeout', 'immediate']);
  });

  test('Module._initPaths() takes up a NODE_PATH set at run time, as Nx does after installing a package', async () => {
    const run = await runNode(['a.cjs'], {
      '/opt/extra/late-lib/index.js': "module.exports = 'found';",
      '/home/project/a.cjs': [
        "const Module = require('node:module');",
        "process.env.NODE_PATH = '/opt/extra';",
        'let before;',
        "try { require('late-lib'); } catch (error) { before = error.code; }",
        'Module._initPaths();',
        "console.log(JSON.stringify({ before, after: require('late-lib'), first: Module.globalPaths[0] }));"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ before: 'MODULE_NOT_FOUND', after: 'found', first: '/opt/extra' });
  });

  test('a stdin paused and resumed while its read is pending holds the process again, as Node does', async () => {
    // Input that arrives only after the program paused and resumed stdin.
    const late = () => {
      let sent = false;
      return {
        read: async () => {
          if (sent) return undefined;
          sent = true;
          await new Promise((resolve) => setTimeout(resolve, 150));
          return new TextEncoder().encode('answer');
        }
      };
    };
    const program = (resume: boolean) => [
      "process.stdin.on('data', (data) => console.log('got', String(data)));",
      'setTimeout(() => {',
      '  process.stdin.pause();',
      resume ? '  setTimeout(() => process.stdin.resume(), 20);' : '',
      '}, 10);'
    ].join('\n');

    const resumed = await runNode(['a.cjs'], { '/home/project/a.cjs': program(true) }, { input: late() });
    const paused = await runNode(['a.cjs'], { '/home/project/a.cjs': program(false) }, { input: late() });

    expect(resumed).toEqual({ exitCode: 0, stdout: 'got answer\n', stderr: '' });
    // Left paused, stdin lets the process end, as in Node.
    expect(paused).toEqual({ exitCode: 0, stdout: '', stderr: '' });
  });

  test('Module.globalPaths is a plain property a program may replace, and _initPaths() gives it a new array, as in Node', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "'use strict';",
        "const Module = require('node:module');",
        "const { writable, enumerable } = Object.getOwnPropertyDescriptor(Module, 'globalPaths');",
        'const first = Module.globalPaths;',
        'const same = Module.globalPaths === first;',
        "Module.globalPaths = ['/assigned'];",
        'const assigned = Module.globalPaths;',
        'Module._initPaths();',
        "const replaced = Module.globalPaths !== first && !Module.globalPaths.includes('/assigned');",
        'console.log(JSON.stringify({ writable, enumerable, same, assigned, replaced }));'
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      writable: true,
      enumerable: true,
      same: true,
      assigned: ['/assigned'],
      replaced: true
    });
  });

  test("navigator is Node's, so code that checks the user agent for a browser takes its Node path", async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        'const { userAgent, platform, language, languages, hardwareConcurrency } = navigator;',
        'console.log(JSON.stringify({',
        '  userAgent, platform, language, languages, tag: String(navigator),',
        "  cores: Number.isInteger(hardwareConcurrency) && hardwareConcurrency > 0, storage: 'storage' in navigator",
        '}));'
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    const reported = JSON.parse(run.stdout);
    expect(reported).toEqual({
      userAgent: 'Node.js/22',
      platform: 'Linux wasm32',
      language: reported.language,
      languages: [reported.language],
      tag: '[object Navigator]',
      cores: true,
      storage: false
    });
    expect(reported.language).toMatch(/^[a-z]{2}/);
  });

  test('process.stdin delivers input as buffers, strings, and async iteration', async () => {
    const input = (chunks: readonly string[]) => {
      const pending = chunks.map((chunk) => new TextEncoder().encode(chunk));
      return { read: async () => pending.shift() };
    };

    const flowing = await runNode(
      ['a.cjs'],
      {
        '/home/project/a.cjs': [
          'const chunks = [];',
          "process.stdin.on('data', (chunk) => chunks.push([Buffer.isBuffer(chunk), String(chunk)]));",
          "process.stdin.on('end', () => console.log(JSON.stringify(chunks)));"
        ].join('\n')
      },
      { input: input(['one', 'two']) }
    );
    expect(flowing.stdout).toBe('[[true,"one"],[true,"two"]]\n');

    const iterated = await runNode(
      ['a.mjs'],
      {
        '/home/project/a.mjs': [
          "process.stdin.setEncoding('utf8');",
          "let text = '';",
          'for await (const chunk of process.stdin) text += chunk;',
          'console.log(text);'
        ].join('\n')
      },
      { input: input(['al', 'pha']) }
    );
    expect(iterated.stdout).toBe('alpha\n');
  });

  test('exposes the process members tools probe for', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        'const usage = process.cpuUsage();',
        'console.log(JSON.stringify({',
        '  uptime: typeof process.uptime(),',
        "  cpuUsage: [typeof usage.user, typeof usage.system, typeof process.cpuUsage(usage).user],",
        '  kill: typeof process.kill,',
        '  chdir: typeof process.chdir,',
        '  title: process.title,',
        '  ids: [process.getuid(), process.geteuid(), process.getgid(), process.getegid()],',
        '  argv0: process.argv0,',
        '  config: typeof process.config.variables,',
        '  report: typeof process.report.getReport().header,',
        '  send: process.send,',
        '  versions: [process.versions.node, typeof process.versions.v8, typeof process.versions.uv, process.versions.modules],',
        '  platform: [process.platform, process.arch],',
        '  self: process.kill(process.pid, 0)',
        '}));'
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      uptime: 'number',
      cpuUsage: ['number', 'number', 'number'],
      kill: 'function',
      chdir: 'function',
      title: 'node',
      ids: [1000, 1000, 1000, 1000],
      argv0: 'node',
      config: 'object',
      report: 'object',
      versions: ['22.22.3', 'string', 'string', '127'],
      platform: ['linux', 'wasm32'],
      self: true
    });
  });

  test('process.chdir moves relative resolution for path, fs, and child processes', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/nested/file.txt': 'nested file',
      '/home/project/a.cjs': [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "process.chdir('nested');",
        "console.log(process.cwd(), path.resolve('file.txt'), fs.readFileSync('file.txt', 'utf8'));",
        "try { process.chdir('missing'); } catch (error) { console.log(error.code, error.syscall); }",
        "process.chdir('..');",
        'console.log(process.cwd());'
      ].join('\n')
    });

    expect(run).toEqual({
      exitCode: 0,
      stdout: '/home/project/nested /home/project/nested/file.txt nested file\nENOENT chdir\n/home/project\n',
      stderr: ''
    });
  });

  test('a required builtin lists no default export, while import still gets the builtin as its default', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "const fs = require('fs');",
        "const path = require('path');",
        // webpack stringifies resolver options that hold a copy of fs, as graceful-fs makes.
        'const copy = Object.create(Object.getPrototypeOf(fs));',
        'for (const key of Object.getOwnPropertyNames(fs)) Object.defineProperty(copy, key, Object.getOwnPropertyDescriptor(fs, key));',
        'JSON.stringify({ fileSystem: { fileSystem: copy } });',
        "console.log(Object.keys(fs).includes('default'), Object.keys(fs.promises).includes('default'), Object.keys(path).includes('default'));",
        "import('node:fs').then((namespace) => console.log(namespace.default === fs, typeof namespace.readFileSync));"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('false false false\ntrue function\n');
  });

  test("reads an accessor the worker's global inherits on that global, and an assignment makes the program's own property", async () => {
    // A browser worker's `location` getter throws Illegal invocation for any other `this`; lodash copying the global met it.
    // Its `onerror` setter, run so, would make a program's function the worker's own error handler; on Node's global the name is inert.
    const workerGlobal = globalThis;
    let assigned: unknown;
    Object.defineProperty(Object.getPrototypeOf(workerGlobal), 'workerOnly', {
      configurable: true,
      get(this: unknown) {
        if (this !== workerGlobal) throw new TypeError('Illegal invocation');
        return 'from the worker';
      },
      set(this: unknown, value: unknown) {
        if (this !== workerGlobal) throw new TypeError('Illegal invocation');
        assigned = value;
      }
    });
    try {
      const run = await runNode(['a.cjs'], {
        '/home/project/a.cjs': [
          'console.log(globalThis.workerOnly, global.workerOnly);',
          "globalThis.workerOnly = 'set';",
          "console.log(globalThis.workerOnly, Object.getOwnPropertyDescriptor(globalThis, 'workerOnly').value);"
        ].join('\n')
      });

      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toBe('from the worker from the worker\nset set\n');
      expect(assigned).toBeUndefined();
    } finally {
      delete (Object.getPrototypeOf(workerGlobal) as Record<string, unknown>).workerOnly;
    }
  });

  test("modules do not see the runtime's own self and onmessage, but do see a self the program defines", async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        'console.log(typeof self, typeof onmessage);',
        'global.self = global;',
        "require('./b.cjs');"
      ].join('\n'),
      '/home/project/b.cjs': 'console.log(typeof self, self === globalThis, typeof onmessage);'
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('undefined undefined\nobject true undefined\n');
  });

  test("a location the program assigns over the worker's read-only one is its own global's, which modules see", async () => {
    // fake-indexeddb/auto, happy-dom and jsdom registrators assign browser names the worker has as accessors.
    const workerGlobal = globalThis;
    Object.defineProperty(Object.getPrototypeOf(workerGlobal), 'location', {
      configurable: true,
      get(this: unknown) {
        if (this !== workerGlobal) throw new TypeError('Illegal invocation');
        return { href: 'https://worker.invalid/' };
      }
    });
    try {
      const run = await runNode(['a.cjs'], {
        '/home/project/a.cjs': "'use strict';\nglobalThis.location = { href: 'http://localhost/' };\nrequire('./b.cjs');",
        '/home/project/b.cjs': 'console.log(location.href, globalThis.location.href);'
      });

      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toBe('http://localhost/ http://localhost/\n');
    } finally {
      delete (Object.getPrototypeOf(workerGlobal) as Record<string, unknown>).location;
    }
  });

  test('drains the nextTick queue before promise jobs in the entry, timers, and immediates', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        'const order = [];',
        'const turn = (name) => {',
        "  Promise.resolve().then(() => order.push(`${name}:promise`));",
        '  process.nextTick(() => {',
        "    order.push(`${name}:tick`);",
        "    process.nextTick(() => order.push(`${name}:nested-tick`));",
        '  });',
        '};',
        "turn('entry');",
        "setTimeout(() => turn('timer'), 0);",
        "setImmediate(() => turn('immediate'));",
        "setTimeout(() => console.log(order.join(' ')), 20);"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    for (const turn of ['entry', 'timer', 'immediate']) {
      expect(run.stdout).toContain(`${turn}:tick ${turn}:nested-tick ${turn}:promise`);
    }
  });

  test('process.exit runs exit listeners with the exit code and keeps output written before it', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "process.on('exit', (code) => console.log('exit', code, process.exitCode));",
        "console.log('before');",
        "process.stdout.write('written\\n');",
        'process.exit(3);',
        "console.log('unreachable');"
      ].join('\n')
    });

    expect(run).toEqual({ exitCode: 3, stdout: 'before\nwritten\nexit 3 3\n', stderr: '' });
  });

  test('process.kill on itself reaches a listener or ends the process with the signal status', async () => {
    const handled = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "process.on('SIGINT', (signal) => { console.log('handled', signal); });",
        "process.kill(process.pid, 'SIGINT');",
        "console.log('sent');"
      ].join('\n')
    });
    expect(handled).toEqual({ exitCode: 0, stdout: 'sent\nhandled SIGINT\n', stderr: '' });

    const fatal = await runNode(['a.cjs'], {
      '/home/project/a.cjs': "process.kill(process.pid, 'SIGTERM'); setTimeout(() => console.log('late'), 50);"
    });
    expect(fatal).toEqual({ exitCode: 143, stdout: '', stderr: '' });

    const missing = await runNode(['-p', "try { process.kill(999999) } catch (error) { error.code }"]);
    expect(missing.stdout).toBe('ESRCH\n');
  });

  test('NodeCommand composes process, console, and the event loop from Node Compatibility', () => {
    const source = readFileSync(new URL('../node-runtime-program.ts', import.meta.url), 'utf8');

    expect(source).toContain('createNodeProcess({');
    expect(source).toContain('createNodeConsole({');
    expect(source).toContain('createNodeEventLoop({');
    expect(/const (?:processLike|consoleLike|streamLike)\b|formatConsoleValue/.test(source)).toBe(false);
  });
});

describe('setImmediate', () => {
  test('runs immediates in order as unclamped macrotasks', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        'const order = [];',
        "setImmediate((a, b) => order.push(`first:${a}${b}`), 1, 2);",
        "setImmediate(() => { order.push('second'); setImmediate(() => order.push('nested')); });",
        "setImmediate(() => order.push('third'));",
        "Promise.resolve().then(() => order.push('promise'));",
        'const started = performance.now();',
        'let remaining = 1000;',
        'const chain = () => {',
        '  if (--remaining > 0) return setImmediate(chain);',
        "  console.log(order.join(' '));",
        // A 1 ms timer floor, which is what Node applies, would take over a second.
        "  console.log(performance.now() - started < 250 ? 'fast' : `slow:${performance.now() - started}`);",
        '};',
        'setImmediate(chain);'
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('promise first:12 second third nested\nfast\n');
  });

  test('keeps the process alive until referenced immediates ran and honours clear and unref', async () => {
    const run = await runNode(['a.cjs'], {
      '/home/project/a.cjs': [
        "const { setImmediate: promised } = require('node:timers/promises');",
        "const cleared = setImmediate(() => console.log('cleared'));",
        'clearImmediate(cleared);',
        "const handle = setImmediate(() => console.log('ran'));",
        'console.log(handle.hasRef(), handle.unref().hasRef(), handle.ref().hasRef());',
        "promised('value').then((value) => console.log('promised', value));",
        "const controller = new AbortController();",
        "promised('never', { signal: controller.signal }).catch((error) => console.log(error.code));",
        'controller.abort();'
      ].join('\n')
    });

    expect(run).toEqual({
      exitCode: 0,
      stdout: 'true false true\nABORT_ERR\nran\npromised value\n',
      stderr: ''
    });
  });
});

describe('process identity', () => {
  test('every constructor of the process prototype chain can be called on a copy, as Jest does', async () => {
    const run = await runNode(['copy.cjs'], {
      '/home/project/copy.cjs': [
        'const copy = Object.create(Object.getPrototypeOf(process));',
        'let proto = process;',
        'const names = [];',
        'while ((proto = Object.getPrototypeOf(proto))) {',
        "  if (typeof proto.constructor === 'function') { proto.constructor.call(copy); names.push(proto.constructor.name); }",
        '}',
        "console.log(names.join(' '));"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('process EventEmitter Object\n');
  });

  test('globals a module sets are visible to code built with Function, eval and vm.runInThisContext', async () => {
    const run = await runNode(['globals.cjs'], {
      '/home/project/globals.cjs': [
        'globalThis.definedByModule = 41;',
        'globalThis.definedByModule += 1;',
        "if (definedByModule !== 42) throw new Error(`stale ${definedByModule}`);",
        "if (!Object.prototype.hasOwnProperty.call(globalThis, 'definedByModule')) throw new Error('not own');",
        "(0, eval)('definedByModule = 42');",
        "console.log(Function('return typeof definedByModule')());",
        "console.log((0, eval)('typeof definedByModule'));",
        "console.log(require('vm').runInThisContext('typeof definedByModule'));",
        "console.log(Function('return typeof process.pid + typeof global')());",
        "require('./reader.cjs');"
      ].join('\n'),
      '/home/project/reader.cjs': "console.log(typeof definedByModule);"
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('number\nnumber\nnumber\nnumberobject\nnumber\n');
  });
});

describe('require.resolve of builtins', () => {
  test('answers a builtin name for the builtin, as Node does', async () => {
    const run = await runNode(['resolve.cjs'], {
      '/home/project/resolve.cjs': [
        "console.log(require.resolve('buffer'), require.resolve('node:fs'), require.resolve('path', { paths: ['/home'] }));",
        "console.log(require('module').createRequire('/home/project/x.js').resolve('events'));"
      ].join('\n')
    });

    expect(run.exitCode, run.stderr).toBe(0);
    expect(run.stdout).toBe('buffer node:fs path\nevents\n');
  });
});

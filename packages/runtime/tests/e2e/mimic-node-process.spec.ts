import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const nodeProcessClaim = defineCompatibilityClaim({
  id: 'node-compatibility-process-console-event-loop-v1',
  statement:
    'Mimic runs node with standard command-line options, a Node-shaped process and console, and unclamped immediates',
  target: {
    kind: 'runtime-capability',
    capability: 'node-compatibility-process-console-event-loop'
  }
});

test(nodeProcessClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/node-process' });
    try {
      await runtime.fs.mount({
        'package.json': { file: { contents: '{"name":"node-process","version":"4.5.6"}' } },
        'options.cjs': {
          file: {
            contents: 'console.log(JSON.stringify({ execArgv: process.execArgv, argv: process.argv.slice(2) }));'
          }
        },
        'console.cjs': {
          file: {
            contents: [
              "const { Writable } = require('node:stream');",
              "console.log('%d items %s', 3, 'x');",
              "console.log({ a: undefined, m: new Map([[1, 2]]), f() {} }, undefined);",
              "console.dir({ nested: { deep: { deeper: 1 } } }, { depth: 0 });",
              "console.group('group'); console.log('inside'); console.groupEnd();",
              "console.log(process.stdout instanceof Writable, typeof process.stdout.end, process.stdout.fd, process.stdout.columns, process.stdout.rows);",
              "console.log(typeof process.uptime(), typeof process.versions.v8, typeof process.versions.uv, process.versions.modules, process.platform, process.arch);"
            ].join('\n')
          }
        },
        'ticks.cjs': {
          file: {
            contents: [
              'const order = [];',
              "Promise.resolve().then(() => order.push('promise'));",
              "process.nextTick(() => order.push('tick'));",
              "setImmediate(() => console.log(order.join(' ')));"
            ].join('\n')
          }
        },
        'immediates.cjs': {
          file: {
            contents: [
              'const order = [];',
              "setImmediate((a, b) => order.push(`first:${a}${b}`), 1, 2);",
              "setImmediate(() => order.push('second'));",
              'const started = performance.now();',
              'let remaining = 1000;',
              'const chain = () => {',
              '  if (--remaining > 0) return setImmediate(chain);',
              '  console.log(JSON.stringify({ order, elapsed: performance.now() - started }));',
              '};',
              'setImmediate(chain);'
            ].join('\n')
          }
        }
      });

      return {
        options: await run(['--max-old-space-size=4096', '--enable-source-maps', '--no-warnings', 'options.cjs', '--flag']),
        version: await run(['--version']),
        print: await run(['-p', "require('./package.json').version"]),
        terminator: await run(['--', 'options.cjs', '--version']),
        badOption: await run(['--not-a-node-option', 'options.cjs']),
        console: await run(['console.cjs']),
        ticks: await run(['ticks.cjs']),
        immediates: await run(['immediates.cjs'])
      };
    } finally {
      await runtime.teardown();
    }

    async function run(args: string[]) {
      const process = await runtime.spawn('node', args);
      const reader = process.output.getReader();
      const decoder = new TextDecoder();
      let output = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        output += decoder.decode(value, { stream: true });
      }
      return { exitCode: await process.exit, output };
    }
  });

  expect(result.options.exitCode, result.options.output).toBe(0);
  expect(JSON.parse(result.options.output)).toEqual({
    execArgv: ['--max-old-space-size=4096', '--enable-source-maps', '--no-warnings'],
    argv: ['--flag']
  });
  expect(result.version).toEqual({ exitCode: 0, output: 'v22.22.3\n' });
  expect(result.print).toEqual({ exitCode: 0, output: '4.5.6\n' });
  expect(result.terminator.exitCode, result.terminator.output).toBe(0);
  expect(JSON.parse(result.terminator.output)).toEqual({ execArgv: [], argv: ['--version'] });
  expect(result.badOption.exitCode).toBe(9);
  expect(result.badOption.output).toContain('node: bad option: --not-a-node-option');
  expect(result.console).toEqual({
    exitCode: 0,
    output: [
      '3 items x',
      '{ a: undefined, m: Map(1) { 1 => 2 }, f: [Function: f] } undefined',
      '{ nested: [Object] }',
      'group',
      '  inside',
      'true function 1 80 24',
      'number string string 127 browser wasm32',
      ''
    ].join('\n')
  });
  expect(result.ticks).toEqual({ exitCode: 0, output: 'tick promise\n' });
  expect(result.immediates.exitCode, result.immediates.output).toBe(0);
  const immediates = JSON.parse(result.immediates.output) as { order: string[]; elapsed: number };
  expect(immediates.order).toEqual(['first:12', 'second']);
  // A timer floor of 4 ms per nested callback would put a thousand of them at four seconds.
  expect(immediates.elapsed).toBeLessThan(100);
  test.info().annotations.push({ type: 'chained-immediates-ms', description: String(immediates.elapsed) });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

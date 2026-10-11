import { describe, expect, test } from 'vitest';

import * as Babel from '../../runtime-host/runtime-artifact-compiler-babel';

import { createRuntimeArtifactTranslator } from '../../module-execution-engine';
import { NodeCommand } from '../node-runtime-program';
import { testMacrotaskQueue, testProcessPorts } from './test-process-ports';
import { createVirtualProcess, VirtualFileSystem } from '../../../../../tests/support/module-internals';
import { createVirtualNetworkAuthority } from '../../virtual-network';

const compile = createRuntimeArtifactTranslator(Babel);

type RuntimeProgramContext = Parameters<NodeCommand['run']>[1];

const EMPTY_EMITTER: RuntimeProgramContext['emitter'] = {};

// The same probe runs as CommonJS and as an ES module: the two formats are
// compiled by different rewrites of `await`.
const probes: Record<string, string> = {
  'keeps the store after await, in timers, ticks, microtasks and emitter listeners': `
    // Vitest reassigns the installed process.nextTick between tasks, so the probe keeps the runtime's.
    const { nextTick } = process;
    const als = new AsyncLocalStorage();
    const emitter = new EventEmitter();
    const seen = [];
    const done = als.run('store', async () => {
      emitter.on('event', () => seen.push(['emitter', als.getStore()]));
      await null;
      seen.push(['await', als.getStore()]);
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen.push(['await timer promise', als.getStore()]);
      try {
        await Promise.reject(new Error('rejected'));
      } catch {
        seen.push(['catch', als.getStore()]);
      } finally {
        seen.push(['finally', als.getStore()]);
      }
      await { then(resolve) { setTimeout(resolve, 1); } };
      seen.push(['await thenable', als.getStore()]);
      await new Promise((resolve) => setTimeout(() => { seen.push(['setTimeout', als.getStore()]); resolve(); }, 1));
      await new Promise((resolve) => setImmediate(() => { seen.push(['setImmediate', als.getStore()]); resolve(); }));
      await new Promise((resolve) => nextTick(() => { seen.push(['nextTick', als.getStore()]); resolve(); }));
      await new Promise((resolve) => queueMicrotask(() => { seen.push(['queueMicrotask', als.getStore()]); resolve(); }));
      await Promise.resolve().then(() => seen.push(['then', als.getStore()]));
      await new Promise((resolve) => fs.readFile('/home/project/missing', () => { seen.push(['fs callback', als.getStore()]); resolve(); }));
      emitter.emit('event');
      for await (const value of (async function* () { yield 1; await null; yield 2; })()) {
        seen.push(['for await ' + value, als.getStore()]);
      }
      for await (const value of [Promise.resolve(3)]) seen.push(['for await sync ' + value, als.getStore()]);
      const nested = await (async () => { await null; return als.getStore(); })();
      seen.push(['nested', nested]);
    });
    seen.push(['after run', als.getStore()]);
    done.then(() => {
      seen.push(['outside then', als.getStore()]);
      const wrong = seen.filter(([name, store]) =>
        store !== (name === 'after run' || name === 'outside then' ? undefined : 'store'));
      console.log('seen', seen.length, 'wrong', JSON.stringify(wrong));
    });
  `,
  'never lets interleaved runs observe each other': `
    const als = new AsyncLocalStorage();
    const wrong = [];
    const check = (expected, where) => {
      if (als.getStore() !== expected) wrong.push([where, expected, als.getStore()]);
    };
    const request = async (id) => {
      for (let step = 0; step < 5; step += 1) {
        await new Promise((resolve) => setTimeout(resolve, (id * 3 + step) % 4));
        check(id, 'timer');
        await null;
        check(id, 'tick');
        await Promise.all([Promise.resolve(), new Promise((resolve) => setImmediate(resolve))]);
        check(id, 'all');
      }
    };
    const runs = [0, 1, 2, 3, 4, 5, 6, 7].map((id) => als.run(id, () => request(id)));
    // A continuation that never entered a run sees no store, even between the runs' jobs.
    const bystander = (async () => {
      for (let step = 0; step < 40; step += 1) {
        await null;
        check(undefined, 'bystander');
        await new Promise((resolve) => setTimeout(resolve, 0));
        check(undefined, 'bystander timer');
      }
    })();
    Promise.all([...runs, bystander]).then(() => console.log('wrong', JSON.stringify(wrong)));
  `,
  'supports AsyncResource, bind, snapshot, exit and enterWith': `
    const als = new AsyncLocalStorage();
    const out = {};
    const resource = als.run('resource', () => new AsyncResource('probe'));
    const bound = als.run('bound', () => AsyncLocalStorage.bind(() => als.getStore()));
    const snapshot = als.run('snapshot', () => AsyncLocalStorage.snapshot());
    const staticBound = als.run('static', () => AsyncResource.bind(function () { return [this, als.getStore()]; }));
    out.resource = als.run('other', () => resource.runInAsyncScope(() => als.getStore()));
    out.resourceIds = resource.runInAsyncScope(() => executionAsyncId() === resource.asyncId());
    out.bound = bound();
    out.snapshot = als.run('other', () => snapshot(() => als.getStore()));
    out.staticBound = staticBound.call('receiver');
    out.exit = als.run('outer', () => als.exit(() => als.getStore()));
    out.afterExit = als.run('outer', () => { als.exit(() => {}); return als.getStore(); });
    const second = new AsyncLocalStorage();
    out.nested = als.run('a', () => second.run('b', () => [als.getStore(), second.getStore()]));
    const entered = (async () => {
      await null;
      als.enterWith('entered');
      await null;
      return als.getStore();
    })();
    entered.then(async (value) => {
      out.entered = value;
      await null;
      out.afterEntered = als.getStore();
      console.log(JSON.stringify(out));
    });
  `
};

const expectations: Record<string, (output: string) => void> = {
  'keeps the store after await, in timers, ticks, microtasks and emitter listeners': (output) => {
    expect(output).toContain('seen 18 wrong []');
  },
  'never lets interleaved runs observe each other': (output) => {
    expect(output).toContain('wrong []');
  },
  'supports AsyncResource, bind, snapshot, exit and enterWith': (output) => {
    expect(JSON.parse(output)).toEqual({
      resource: 'resource',
      resourceIds: true,
      bound: 'bound',
      snapshot: 'snapshot',
      staticBound: ['receiver', 'static'],
      exit: undefined,
      afterExit: 'outer',
      nested: ['a', 'b'],
      entered: 'entered',
      afterEntered: undefined
    });
  }
};

const formats = [
  {
    name: 'CommonJS',
    extension: 'cjs',
    prelude: [
      "const { AsyncLocalStorage, AsyncResource, executionAsyncId } = require('node:async_hooks');",
      "const { EventEmitter } = require('node:events');",
      "const fs = require('node:fs');"
    ]
  },
  {
    name: 'ES module',
    extension: 'mjs',
    prelude: [
      "import { AsyncLocalStorage, AsyncResource, executionAsyncId } from 'node:async_hooks';",
      "import { EventEmitter } from 'node:events';",
      "import fs from 'node:fs';"
    ]
  }
];

describe('AsyncLocalStorage across asynchronous continuations', () => {
  for (const format of formats) {
    for (const [name, body] of Object.entries(probes)) {
      test(`${name} (${format.name})`, async () => {
        const output = await runNode(`probe.${format.extension}`, [...format.prelude, body].join('\n'));
        expectations[name](output);
      });
    }
  }

  test('carries the store through top-level await and TypeScript sources', async () => {
    const output = await runNode('probe.mts', [
      "import { AsyncLocalStorage } from 'node:async_hooks';",
      'const als = new AsyncLocalStorage<string>();',
      "const inside: string | undefined = await als.run('store', async () => {",
      '  await null;',
      '  return als.getStore();',
      '});',
      'await null;',
      "console.log(inside, String(als.getStore()));"
    ].join('\n'));

    expect(output).toContain('store undefined');
  });
});

async function runNode(file: string, source: string): Promise<string> {
  const fs = new VirtualFileSystem('/home/project');
  await fs.writeFile(`/home/project/${file}`, source);
  const command = new NodeCommand(compile, testMacrotaskQueue);
  const process = createVirtualProcess(1, (writer) =>
    command.run([`/home/project/${file}`], {
      cwd: '/home/project',
      env: {},
      fs,
      writer,
      emitter: EMPTY_EMITTER,
      virtualNetwork: createVirtualNetworkAuthority(),
      ...testProcessPorts()
    })
  );
  const reader = process.output.getReader();
  const decoder = new TextDecoder();
  let output = '';
  for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
    output += decoder.decode(chunk.value);
  }
  expect(await process.exit, output).toBe(0);
  return output;
}

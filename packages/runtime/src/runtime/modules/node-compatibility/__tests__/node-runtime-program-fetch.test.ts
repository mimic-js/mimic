import { createServer } from 'node:http';

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

// Its own file: the real sockets of the server here would reorder the timers of the tests after it.
describe('fetch', () => {
  test('a fetch in flight keeps the process alive until its response is read', async () => {
    // create-expo-app awaits a fetch of Expo's versions endpoint before anything else keeps it alive.
    const server = createServer((_request, response) => {
      response.setHeader('connection', 'close');
      setTimeout(() => response.end('{"latest":54}'), 300);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as { port: number };
    try {
      // A bundled command-line tool starts its async main inside a module function and does not wait for it.
      const run = await runNode(['a.cjs'], {
        '/home/project/a.cjs': [
          '(function (modules) {',
          '  modules.main();',
          '})({',
          '  main() {',
          '    async function run() {',
          `      const response = await fetch('http://127.0.0.1:${port}/versions');`,
          "      await new Promise((resolve) => setTimeout(resolve, 0));",
          '      const body = await response.json();',
          "      console.log('latest', body.latest);",
          '    }',
          '    run();',
          '  }',
          '});'
        ].join('\n')
      });

      expect(run.exitCode, run.stderr).toBe(0);
      expect(run.stdout).toBe('latest 54\n');
    } finally {
      // An open socket would reorder the timers of the tests after this one.
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

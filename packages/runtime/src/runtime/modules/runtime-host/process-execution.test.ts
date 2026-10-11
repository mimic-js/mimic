import { expect, test } from 'vitest';

import type { RuntimeProgram } from '../process-execution';
import type { RuntimeProgramAdapterContext } from './runtime-program-host';
import { createRuntimeHostEpoch } from './worker-epoch';
import { markWorkerFailure } from './process-worker-protocol';
import { bootRuntimeHostTestPeer } from './test-peer';

const request = (command: string, args: readonly string[] = []) => ({
  command,
  args,
  cwd: '/home/project',
  env: {},
  parentPid: 0
});

test('runs Runtime Programs in the Runtime Host and projects their stdio, signals, and exit', async () => {
  const programs: RuntimeProgram<RuntimeProgramAdapterContext>[] = [
    {
      id: 'interleave',
      commands: ['interleave'],
      async run(args, context) {
        await context.writer.write('out-1 ');
        await context.errorWriter?.write('err-1 ');
        const input = await context.input?.read();
        await context.writer.write(`read:${new TextDecoder().decode(input)} `);
        void context.errorWriter?.write(args.join(','));
        return 4;
      }
    },
    {
      id: 'wait-for-signal',
      commands: ['wait-for-signal'],
      handlesSignals: true,
      async run(_args, context) {
        const signal = await context.signal;
        return signal === 'SIGINT' ? 130 : 143;
      }
    }
  ];
  const epoch = createRuntimeHostEpoch({
    closeWorker: () => undefined,
    executionCapacity: 1,
    runtimePrograms: programs
  });
  const { peer, processes } = await bootRuntimeHostTestPeer(epoch);

  const interleaved = await processes.spawn(request('interleave', ['a', 'b']));
  const writer = interleaved.stdin.getWriter();
  await writer.write(new TextEncoder().encode('typed'));
  await writer.close();
  const [output, stdout, exit] = await Promise.all([
    new Response(interleaved.output).text(),
    new Response(interleaved.stdout).text(),
    interleaved.exit
  ]);
  expect(exit).toBe(4);
  expect(output).toBe('out-1 err-1 read:typed a,b');
  expect(stdout).toBe('out-1 read:typed ');

  const signalled = await processes.spawn(request('wait-for-signal'));
  await expect(processes.spawn(request('wait-for-signal'))).rejects.toMatchObject({
    name: 'RuntimeProcessExecutionError',
    code: 'CAPACITY_EXHAUSTED'
  });
  signalled.kill('SIGINT');
  signalled.kill('SIGTERM');
  await expect(signalled.exit).resolves.toBe(130);
  await expect(signalled.termination).resolves.toEqual({ code: 130, signal: 'SIGINT' });
  await expect(processes.spawn(request('missing'))).rejects.toMatchObject({
    name: 'RuntimeProcessExecutionError',
    code: 'EXECUTABLE_NOT_FOUND'
  });

  await expect(peer.remote.runtimeHost.teardown()).resolves.toEqual({
    type: 'teardown-complete'
  });
  processes.close();
  peer.close();
  await epoch.closed;
});

test('crashes the projected process when its Runtime Program fails', async () => {
  const epoch = createRuntimeHostEpoch({
    closeWorker: () => undefined,
    runtimePrograms: [
      {
        id: 'crash',
        commands: ['crash'],
        run() {
          throw Object.assign(markWorkerFailure(new Error('crash marker')), {
            name: 'MimicWorkerCrash'
          });
        }
      }
    ]
  });
  const { peer, processes } = await bootRuntimeHostTestPeer(epoch);

  const crashed = await processes.spawn(request('crash'));
  await expect(crashed.exit).rejects.toMatchObject({
    name: 'MimicProcessCrashError',
    code: 'PROCESS_CRASH',
    message: `Runtime Process ${crashed.pid} crashed: crash marker`
  });

  await peer.remote.runtimeHost.teardown();
  processes.close();
  peer.close();
  await epoch.closed;
});

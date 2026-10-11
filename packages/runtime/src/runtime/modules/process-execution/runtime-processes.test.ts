import { describe, expect, test, vi } from 'vitest';

import { createProcessExecution } from './runtime-processes';
import type { ExecutableFileSystemPort } from './executable-resolution';

const noFiles: ExecutableFileSystemPort = {
  normalizePath: (path, cwd) => (path.startsWith('/') ? path : `${cwd}/${path}`),
  isFile: () => false,
  readBytes: () => {
    throw new Error('no files');
  },
  readText: () => {
    throw new Error('no files');
  }
};

function processExecution(capacity = 2) {
  return createProcessExecution({
    resolution: {
      runtimePrograms: [
        { id: 'tool', commands: ['tool'] },
        { id: 'node', commands: ['node'] }
      ],
      javaScript: { programId: 'node', interpreterNames: ['node'], interpreterPaths: [] }
    },
    fileSystem: noFiles,
    capacity
  });
}

const request = (command: string, parentPid = 0) => ({
  command,
  args: [],
  cwd: '/home/project',
  env: {},
  parentPid
});

describe('Process Execution', () => {
  test('resolves every spawn against the one registry and rejects an unknown command', async () => {
    const processes = processExecution();
    const runner = vi.fn(() => 0);

    const process = await processes.spawn(request('tool'), runner);
    await expect(process.exit).resolves.toBe(0);
    expect(runner).toHaveBeenCalledWith(
      expect.objectContaining({
        request: expect.objectContaining({
          executable: expect.objectContaining({ programId: 'tool' })
        })
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything()
    );
    await expect(processes.spawn(request('missing'), runner)).rejects.toMatchObject({
      code: 'EXECUTABLE_NOT_FOUND'
    });
    processes.dispose();
  });

  test('owns Execution Context workers until the Runtime Process exits', async () => {
    const processes = processExecution(1);
    const terminate = vi.fn();
    const worker = {
      addEventListener() {},
      postMessage() {},
      removeEventListener() {},
      terminate
    } as unknown as Worker;
    const createWorker = vi.fn(() => worker);

    const process = await processes.spawn(
      request('node'),
      (_admission, _stdout, _stdin, _stderr, executionContext) => {
        expect(executionContext.openWorker(createWorker)).toBe(worker);
        return 0;
      }
    );

    await expect(process.exit).resolves.toBe(0);
    expect(createWorker).toHaveBeenCalledOnce();
    expect(terminate).toHaveBeenCalledOnce();
    await expect(processes.spawn(request('tool'), () => 0)).resolves.toMatchObject({
      pid: 1_000_001
    });
    processes.dispose();
  });

  test('reports the first signal and releases a killed process only once its program settles', async () => {
    const processes = processExecution(1);
    let releaseProgram!: () => void;
    const programReleased = new Promise<void>((resolve) => {
      releaseProgram = resolve;
    });
    const interrupted = await processes.spawn(request('tool'), async (_admission, stdout) => {
      const signal = await stdout.waitForKill();
      return signal === 'SIGINT' ? 130 : 143;
    });
    interrupted.kill('SIGINT');
    interrupted.kill('SIGTERM');
    await expect(interrupted.exit).resolves.toBe(130);
    await expect(interrupted.termination).resolves.toEqual({ code: 130, signal: 'SIGINT' });

    const killed = await processes.spawn(request('tool'), async (_admission, stdout) => {
      await stdout.waitForKill();
      await programReleased;
      return 0;
    });
    killed.kill('SIGKILL');
    // The killed process keeps its Execution Capacity until its program settles.
    await expect(processes.spawn(request('tool'), () => 0)).rejects.toMatchObject({
      code: 'CAPACITY_EXHAUSTED'
    });
    releaseProgram();
    await expect(killed.exit).resolves.toBe(137);
    await expect(killed.termination).resolves.toEqual({ code: 137, signal: 'SIGKILL' });
    await expect(processes.spawn(request('tool'), () => 0)).resolves.toBeDefined();
    processes.dispose();
  });

  test('runs a child in its parent Execution Context and outlives the parent quietly', async () => {
    const processes = processExecution(1);
    let releaseChild!: () => void;
    const childReleased = new Promise<void>((resolve) => {
      releaseChild = resolve;
    });
    let child: Awaited<ReturnType<typeof processes.spawnChild>> | undefined;
    const parent = await processes.spawn(request('tool'), async (admission, _stdout, _stdin, _stderr, parentContext) => {
      child = await processes.spawnChild(
        request('tool', admission.pid),
        async (childAdmission, _childStdout, _childStdin, _childStderr, childContext) => {
          expect(childAdmission.contextId).toBe(admission.contextId);
          expect(childContext).toBe(parentContext);
          await childReleased;
          return 3;
        }
      );
      return 0;
    });

    await expect(parent.exit).resolves.toBe(0);
    expect(child?.pid).toBe(2);
    releaseChild();
    await expect(child?.exit).resolves.toBe(3);
    processes.dispose();
  });
});

import { describe, expect, test, vi } from 'vitest';

import {
  ProcessExecutionError,
  createProcessExecutionAuthority
} from './process-execution';
import { pipeProcessInput } from './process-streams';
import { createVirtualProcess } from './virtual-process';
import { executeSynchronousChildProcess } from './synchronous-child-execution';

const request = (command = 'node', parentPid = 0) => {
  const args = ['/home/project/app.mjs'];
  return {
    command,
    args,
    cwd: '/home/project',
    env: { MODE: 'test' },
    parentPid,
    executable: {
      programId: command,
      argv: args,
      provenance: { kind: 'runtime-program' as const, command, paths: [] }
    }
  };
};

describe('Process Execution authority', () => {
  test('forwards inherited process input through EOF', async () => {
    const chunks: Array<Uint8Array | undefined> = [
      new TextEncoder().encode('from parent'),
      undefined
    ];
    const written: string[] = [];
    let closed = false;

    await pipeProcessInput(
      {
        read: async () => chunks.shift()
      },
      new WritableStream<Uint8Array>({
        write(chunk) {
          written.push(new TextDecoder().decode(chunk));
        },
        close() {
          closed = true;
        }
      })
    );

    expect(written).toEqual(['from parent']);
    expect(closed).toBe(true);
  });

  test('cancels inherited process input after the destination process exits', async () => {
    const cancellation = new AbortController();
    let inputAborted = false;
    let destinationAborted = false;
    const forwarding = pipeProcessInput(
      {
        read: ({ signal } = {}) =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener(
              'abort',
              () => {
                inputAborted = true;
                reject(signal.reason);
              },
              { once: true }
            );
          })
      },
      new WritableStream<Uint8Array>({
        abort() {
          destinationAborted = true;
        }
      }),
      { signal: cancellation.signal }
    );

    cancellation.abort(new Error('child exited'));

    await expect(forwarding).resolves.toBeUndefined();
    expect(inputAborted).toBe(true);
    expect(destinationAborted).toBe(true);
  });

  test('executes a synchronous child with captured binary stdio and a non-zero status', async () => {
    let input = '';
    const result = await executeSynchronousChildProcess(
      {
        command: 'node',
        args: ['child.mjs'],
        cwd: '/home/project',
        env: { MODE: 'test' },
        parentPid: 41,
        input: new TextEncoder().encode('child-input'),
        stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
        timeout: 0,
        killSignal: 'SIGTERM',
        maxBuffer: 64
      },
      {
        spawn: async () =>
          createVirtualProcess(73, async (stdout, stdin, stderr) => {
            const chunk = await stdin.read();
            input = new TextDecoder().decode(chunk);
            await stdout.write('child-output');
            await stderr.write('child-error');
            return 7;
          }),
        parentStdout: { write: () => undefined },
        parentStderr: { write: () => undefined },
        cancelWait: async () => undefined
      }
    );

    expect(input).toBe('child-input');
    expect(result).toEqual({
      pid: 73,
      status: 7,
      signal: null,
      stdout: new TextEncoder().encode('child-output'),
      stderr: new TextEncoder().encode('child-error')
    });
  });

  test('stops inherited stdin forwarding when the synchronous child exits', async () => {
    const result = await executeSynchronousChildProcess(
      {
        command: 'node',
        args: ['child.mjs'],
        cwd: '/home/project',
        env: {},
        parentPid: 41,
        input: new Uint8Array(),
        stdio: { stdin: 'inherit', stdout: 'pipe', stderr: 'pipe' },
        timeout: 0,
        killSignal: 'SIGTERM',
        maxBuffer: 64
      },
      {
        spawn: async () => createVirtualProcess(73, () => 0),
        parentInput: {
          read: ({ signal } = {}) =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => reject(signal.reason),
                { once: true }
              );
            })
        },
        parentStdout: { write: () => undefined },
        parentStderr: { write: () => undefined },
        cancelWait: async () => undefined
      }
    );

    expect(result.status).toBe(0);
  });

  test('wakes a terminated parent without cascading its signal to the child', async () => {
    let resolveParentSignal!: (signal: 'SIGTERM') => void;
    const parentSignal = new Promise<'SIGTERM'>((resolve) => {
      resolveParentSignal = resolve;
    });
    const onChildKill = vi.fn();
    const cancelWait = vi.fn(async () => undefined);
    let child!: ReturnType<typeof createVirtualProcess>;
    const execution = executeSynchronousChildProcess(
      {
        command: 'node',
        args: ['child.mjs'],
        cwd: '/home/project',
        env: {},
        parentPid: 41,
        input: new Uint8Array(),
        stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
        timeout: 0,
        killSignal: 'SIGTERM',
        maxBuffer: 16
      },
      {
        spawn: async () => {
          child = createVirtualProcess(
            73,
            async (stdout) => {
              await new Promise((resolve) => setTimeout(resolve, 25));
              await stdout.write('x'.repeat(128));
              return 0;
            },
            onChildKill
          );
          return child;
        },
        parentStdout: { write: () => undefined },
        parentStderr: { write: () => undefined },
        parentSignal,
        cancelWait
      }
    );
    resolveParentSignal('SIGTERM');

    await expect(execution).resolves.toMatchObject({
      pid: 73,
      status: null,
      signal: null,
      error: { code: 'PARENT_TERMINATED' }
    });
    expect(onChildKill).not.toHaveBeenCalled();
    expect(cancelWait).toHaveBeenCalledWith(child, 'SIGTERM');
    await expect(child.exit).resolves.toBe(0);
  });

  test('releases a canceled synchronous parent before wakeup', () => {
    const terminated: Array<{
      readonly contextId: number;
      readonly signal: string | undefined;
    }> = [];
    const authority = createProcessExecutionAuthority({
      capacity: 1,
      createExecutionContext: (contextId) => ({
        onCrash: () => () => undefined,
        terminate: (signal) => terminated.push({ contextId, signal })
      })
    });
    const parent = authority.spawn(request('parent'));
    const child = authority.spawnSynchronousChild(
      request('child', parent.pid)
    );

    expect(authority.cancelSynchronousWait(child.pid, 'SIGTERM')).toBe(true);
    expect(authority.cancelSynchronousWait(child.pid, 'SIGTERM')).toBe(false);
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({
        code: 'CAPACITY_EXHAUSTED'
      })
    );
    expect(terminated).toContainEqual({
      contextId: parent.contextId,
      signal: 'SIGTERM'
    });
    expect(authority.snapshot().processes).not.toContainEqual(
      expect.objectContaining({ pid: parent.pid })
    );
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({
        code: 'CAPACITY_EXHAUSTED'
      })
    );
    authority.complete({
      pid: child.pid,
      contextId: child.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(authority.spawn(request('replacement'))).toMatchObject({
      parentPid: 0
    });
  });

  test.each([
    [1, 1],
    [2, 1],
    [5, 4],
    [64, 8]
  ])('clamps hardware concurrency %i to runtime-owned capacity %i', (hardwareConcurrency, expected) => {
    const authority = createProcessExecutionAuthority({ hardwareConcurrency });
    expect(authority.capacity).toBe(expected);
  });

  test('owns bounded PID and single-use Execution Context admission', () => {
    const createdContexts: number[] = [];
    const terminatedContexts: number[] = [];
    const authority = createProcessExecutionAuthority({
      capacity: 2,
      createExecutionContext: (contextId) => {
        createdContexts.push(contextId);
        return { onCrash: () => () => undefined, terminate: () => terminatedContexts.push(contextId) };
      }
    });

    expect(createdContexts).toEqual([1]);

    const first = authority.spawn(request());
    const second = authority.spawn(request('runtime-program'));

    expect(first).toMatchObject({ pid: 1, parentPid: 0, contextId: 1 });
    expect(second).toMatchObject({ pid: 1_000_001, parentPid: 0, contextId: 2 });
    expect(createdContexts).toEqual([1, 2]);
    expect(() => authority.spawn(request('third'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );

    authority.complete({ pid: first.pid, contextId: first.contextId, outcome: { type: 'exit', code: 0, signal: null } });
    expect(terminatedContexts).toEqual([1]);
    const replacement = authority.spawn(request('replacement'));

    expect(replacement.contextId).toBe(3);
    expect(createdContexts).toEqual([1, 2, 3]);
    expect(replacement.pid).toBe(2_000_001);
    expect(authority.snapshot().processes).toHaveLength(2);
  });

  test('transfers one runnable capacity lease down a nested synchronous wait chain', () => {
    const authority = createProcessExecutionAuthority({ capacity: 1 });
    const parent = authority.spawn(request('parent'));

    const child = authority.spawnSynchronousChild(request('child', parent.pid));
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );

    const grandchild = authority.spawnSynchronousChild(
      request('grandchild', child.pid)
    );
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );

    authority.complete({
      pid: grandchild.pid,
      contextId: grandchild.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );

    authority.complete({
      pid: child.pid,
      contextId: child.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );

    authority.complete({
      pid: parent.pid,
      contextId: parent.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(authority.spawn(request('replacement'))).toMatchObject({
      parentPid: 0
    });
  });

  test('transfers the Execution Context lease when an active descendant starts a synchronous child', () => {
    const authority = createProcessExecutionAuthority({ capacity: 1 });
    const root = authority.spawn(request('root'));
    const descendant = authority.admitChild(root.pid);

    const synchronousChild = authority.spawnSynchronousChild(
      request('synchronous-child', descendant.pid)
    );

    expect(synchronousChild).toMatchObject({ parentPid: descendant.pid });
    expect(() => authority.spawn(request('unrelated'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
    authority.complete({
      pid: synchronousChild.pid,
      contextId: synchronousChild.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(authority.snapshot().processes).toContainEqual(
      expect.objectContaining({ pid: root.pid })
    );
  });

  test('parks two callers of one Execution Context at the same time', () => {
    const authority = createProcessExecutionAuthority({ capacity: 2 });
    const root = authority.spawn(request('npm'));
    const firstScript = authority.admitChild(root.pid);
    const secondScript = authority.admitChild(root.pid);

    const first = authority.spawnSynchronousChild(request('first-child', firstScript.pid));
    const second = authority.spawnSynchronousChild(request('second-child', secondScript.pid));

    expect(first).toMatchObject({ parentPid: firstScript.pid });
    expect(second).toMatchObject({ parentPid: secondScript.pid });
    // The parked context counts once, so its two synchronous children both run.
    expect(authority.snapshot().processes.map((process) => process.pid)).toEqual([
      root.pid,
      first.pid,
      second.pid
    ]);
    expect(authority.cancelSynchronousWait(second.pid, 'SIGTERM')).toBe(true);
    expect(authority.snapshot().processes.map((process) => process.pid)).toEqual([first.pid, second.pid]);
  });

  test('rejects a ninth parked synchronous caller before admitting its child', () => {
    const authority = createProcessExecutionAuthority({ capacity: 8 });
    const parents = Array.from({ length: 8 }, (_, index) =>
      authority.spawn(request(`parent-${index}`))
    );
    const children = parents.map((parent, index) =>
      authority.spawnSynchronousChild(
        request(`child-${index}`, parent.pid)
      )
    );

    expect(() =>
      authority.spawnSynchronousChild(
        request('ninth-park', children[0]?.pid ?? 0)
      )
    ).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'PARK_LIMIT_EXHAUSTED' })
    );
    expect(authority.snapshot().processes).toHaveLength(16);
  });

  test('owns the process tree, reparenting, signals, and cleanup after exit or crash', async () => {
    const deliveredSignal = vi.fn();
    const authority = createProcessExecutionAuthority({ capacity: 4, deliverSignal: deliveredSignal });
    const parent = authority.spawn(request('parent'));
    const child = authority.spawn(request('child', parent.pid));
    const crashed = authority.spawn(request('crashed'));

    expect(authority.signal(parent.pid, 'SIGTERM')).toBe(true);
    expect(deliveredSignal).toHaveBeenCalledWith(parent.pid, 'SIGTERM');
    expect(deliveredSignal).not.toHaveBeenCalledWith(child.pid, 'SIGTERM');

    authority.complete({ pid: parent.pid, contextId: parent.contextId, outcome: { type: 'exit', code: 143, signal: 'SIGTERM' } });
    expect(authority.snapshot().processes.find((process) => process.pid === child.pid)?.parentPid).toBe(0);

    authority.complete({
      pid: crashed.pid,
      contextId: crashed.contextId,
      outcome: { type: 'crash', message: 'execution context crashed' }
    });
    expect(authority.snapshot().processes.map((process) => process.pid)).toEqual([child.pid]);

    const shutdown = authority.shutdown('SIGKILL');
    expect(deliveredSignal).toHaveBeenCalledWith(child.pid, 'SIGKILL');
    await expect(shutdown).resolves.toBeUndefined();
    expect(authority.snapshot().processes).toEqual([]);
  });

  test('refuses a child or worker thread past the per-context worker limit with EAGAIN-shaped capacity exhaustion', () => {
    const authority = createProcessExecutionAuthority({
      capacity: 2,
      contextWorkerLimit: 3,
      epochWorkerLimit: 8
    });
    const root = authority.spawn(request('node'));
    const first = authority.admitChild(root.pid);
    const second = authority.admitChild(first.pid);
    const thread = authority.admitThread({ pid: root.pid, threadId: 1, parentThreadId: 0 });

    expect(authority.snapshot().workerLimits).toEqual({ context: 3, epoch: 8 });
    expect(() => authority.admitChild(root.pid)).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
    expect(() =>
      authority.admitThread({ pid: root.pid, threadId: 2, parentThreadId: 0 })
    ).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
    // A refused admission leaves nothing behind: the next PID and the counts are unchanged.
    expect(authority.snapshot().children).toHaveLength(2);
    expect(authority.snapshot().threads).toHaveLength(1);

    // Another context is unaffected by a full one.
    const other = authority.spawn(request('node'));
    expect(authority.admitChild(other.pid)).toMatchObject({ contextId: other.contextId });

    // Child exit and thread termination release their share.
    authority.completeChild(second.pid);
    expect(authority.admitChild(root.pid)).toMatchObject({ pid: root.pid + 3, contextId: root.contextId });
    authority.completeThread(thread.pid, thread.threadId);
    expect(authority.admitThread({ pid: root.pid, threadId: 2, parentThreadId: 0 })).toMatchObject({ threadId: 2 });
    expect(() => authority.admitChild(root.pid)).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );

    // Completing a child also releases the threads it owned.
    const grandchild = authority.admitChild(other.pid);
    authority.admitThread({ pid: grandchild.pid, threadId: 1, parentThreadId: 0 });
    expect(() => authority.admitChild(other.pid)).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
    authority.completeChild(grandchild.pid);
    expect(authority.snapshot().threads.filter((entry) => entry.pid === grandchild.pid)).toEqual([]);
    expect(authority.admitChild(other.pid)).toMatchObject({ contextId: other.contextId });
  });

  test('bounds live child processes and worker threads across the epoch and releases them with their context', () => {
    const authority = createProcessExecutionAuthority({
      capacity: 4,
      contextWorkerLimit: 4,
      epochWorkerLimit: 5
    });
    const first = authority.spawn(request('first'));
    const second = authority.spawn(request('second'));
    for (let index = 0; index < 3; index += 1) authority.admitChild(first.pid);
    authority.admitChild(second.pid);
    authority.admitThread({ pid: second.pid, threadId: 1, parentThreadId: 0 });

    // Neither context is at its own limit; the epoch is.
    expect(() => authority.admitChild(first.pid)).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
    expect(() =>
      authority.admitThread({ pid: first.pid, threadId: 1, parentThreadId: 0 })
    ).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
    // Root processes stay governed by Execution Capacity, not by the worker limit.
    expect(authority.spawn(request('third'))).toMatchObject({ parentPid: 0 });

    // A root's exit releases every worker its context held.
    authority.complete({
      pid: first.pid,
      contextId: first.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(authority.snapshot().children).toHaveLength(1);
    expect(authority.admitChild(second.pid)).toMatchObject({ contextId: second.contextId });
    expect(authority.admitThread({ pid: second.pid, threadId: 2, parentThreadId: 0 })).toMatchObject({ threadId: 2 });
  });

  test('keeps the synchronous park limit beside the worker limits and rejects invalid limits', () => {
    expect(() => createProcessExecutionAuthority({ contextWorkerLimit: 0 })).toThrow(RangeError);
    expect(() => createProcessExecutionAuthority({ epochWorkerLimit: 1.5 })).toThrow(RangeError);
    expect(() => createProcessExecutionAuthority({ contextWorkerLimit: 8, epochWorkerLimit: 4 })).toThrow(RangeError);
    const authority = createProcessExecutionAuthority({ capacity: 8, contextWorkerLimit: 1, epochWorkerLimit: 1 });
    const root = authority.spawn(request('root'));
    authority.admitChild(root.pid);
    // A synchronous child is a root in its own context, so the worker limit does not apply to it.
    expect(authority.spawnSynchronousChild(request('sync', root.pid))).toMatchObject({ parentPid: root.pid });
    expect(authority.snapshot().workerLimits).toEqual({ context: 1, epoch: 1 });
    expect(createProcessExecutionAuthority().snapshot().workerLimits).toEqual({ context: 32, epoch: 64 });
  });

  test('owns context-local child and worker-thread identities in the authoritative snapshot', () => {
    const authority = createProcessExecutionAuthority({ capacity: 1 });
    const root = authority.spawn(request('node'));
    const child = authority.admitChild(root.pid);
    const nested = authority.admitChild(child.pid);
    const firstThread = authority.admitThread({
      pid: root.pid,
      threadId: 1,
      parentThreadId: 0
    });
    const nestedThread = authority.admitThread({
      pid: root.pid,
      threadId: 2,
      parentThreadId: firstThread.threadId
    });
    expect(firstThread.threadId).toBe(1);
    expect(nestedThread.threadId).toBe(2);

    expect(authority.snapshot()).toMatchObject({
      children: [
        { pid: root.pid + 1, parentPid: root.pid, contextId: root.contextId },
        {
          pid: root.pid + 2,
          parentPid: child.pid,
          contextId: root.contextId
        }
      ],
      threads: [
        {
          pid: root.pid,
          threadId: 1,
          parentThreadId: 0,
          contextId: root.contextId
        },
        {
          pid: root.pid,
          threadId: 2,
          parentThreadId: 1,
          contextId: root.contextId
        }
      ]
    });

    authority.completeThread(root.pid, 2);
    expect(() => authority.completeThread(root.pid, 2)).toThrow(
      'Worker thread 1:2 is not active.'
    );
    authority.completeChild(nested.pid);
    authority.complete({
      pid: root.pid,
      contextId: root.contextId,
      outcome: { type: 'exit', code: 0, signal: null }
    });
    expect(() => authority.completeThread(root.pid, firstThread.threadId)).not.toThrow();
    expect(authority.snapshot()).toMatchObject({
      processes: [],
      children: [],
      threads: []
    });
  });

  test('replaces an admitted Runtime Program without changing process identity or capacity', () => {
    const authority = createProcessExecutionAuthority({ capacity: 1 });
    const admitted = authority.spawn(request('sh'));

    const replacement = authority.replace({
      pid: admitted.pid,
      contextId: admitted.contextId,
      request: request('node')
    });

    expect(replacement).toMatchObject({
      pid: admitted.pid,
      parentPid: admitted.parentPid,
      contextId: admitted.contextId,
      request: { command: 'node', executable: { programId: 'node' } }
    });
    expect(authority.snapshot().processes).toEqual([replacement]);
    expect(() => authority.spawn(request('second'))).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'CAPACITY_EXHAUSTED' })
    );
  });

  test('rejects stale context completion without disturbing the admitted process', () => {
    const authority = createProcessExecutionAuthority({ capacity: 1 });
    const admitted = authority.spawn(request());

    expect(() =>
      authority.complete({ pid: admitted.pid, contextId: admitted.contextId + 1, outcome: { type: 'exit', code: 0, signal: null } })
    ).toThrowError(expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'INVALID_CONTEXT' }));
    expect(authority.snapshot().processes).toHaveLength(1);
  });

  test('terminal disposal destroys admitted and prewarmed contexts without reuse', () => {
    const terminated: number[] = [];
    const authority = createProcessExecutionAuthority({
      capacity: 2,
      createExecutionContext: (contextId) => ({
        onCrash: () => () => undefined,
        terminate: () => terminated.push(contextId)
      })
    });
    authority.spawn(request());

    authority.dispose();

    expect(terminated).toEqual([2, 1]);
    expect(authority.snapshot()).toMatchObject({ state: 'closed', processes: [] });
    expect(() => authority.spawn(request())).toThrowError(
      expect.objectContaining<Partial<ProcessExecutionError>>({ code: 'PROCESS_EXECUTION_CLOSED' })
    );
  });

  test('releases an admitted process and its capacity when the Execution Context crashes', () => {
    const crashListeners = new Map<number, (reason: unknown) => void>();
    const terminated: number[] = [];
    const deliverCrash = vi.fn();
    const authority = createProcessExecutionAuthority({
      capacity: 1,
      deliverCrash,
      createExecutionContext: (contextId) => ({
        onCrash(listener) {
          crashListeners.set(contextId, listener);
          return () => crashListeners.delete(contextId);
        },
        terminate: () => terminated.push(contextId)
      })
    });
    const admitted = authority.spawn(request());

    crashListeners.get(admitted.contextId)?.(new Error('worker crashed'));

    expect(authority.snapshot().processes).toEqual([]);
    expect(deliverCrash).toHaveBeenCalledWith(admitted.pid, 'worker crashed');
    expect(terminated).toContain(admitted.contextId);
    expect(() => authority.spawn(request('replacement'))).not.toThrow();
  });

  test('completes mandatory context cleanup when a process-release hook throws', () => {
    const terminated: number[] = [];
    const authority = createProcessExecutionAuthority({
      capacity: 1,
      onProcessReleased: () => {
        throw new Error('release hook failed');
      },
      createExecutionContext: (contextId) => ({
        onCrash: () => () => undefined,
        terminate: () => terminated.push(contextId)
      })
    });
    const admitted = authority.spawn(request());

    expect(() =>
      authority.complete({
        pid: admitted.pid,
        contextId: admitted.contextId,
        outcome: { type: 'exit', code: 0, signal: null }
      })
    ).toThrowError('release hook failed');

    expect(authority.snapshot().processes).toEqual([]);
    expect(terminated).toContain(admitted.contextId);
    expect(() => authority.spawn(request('replacement'))).not.toThrow();
  });

  test('keeps admission valid when opportunistic prewarming fails', () => {
    const authority = createProcessExecutionAuthority({
      capacity: 2,
      createExecutionContext: (contextId) => {
        if (contextId === 2) throw new Error('Worker construction failed');
        return {
          onCrash: () => () => undefined,
          terminate: () => undefined
        };
      }
    });

    const admitted = authority.spawn(request());

    expect(authority.snapshot().processes).toEqual([admitted]);
  });
});

import { describe, expect, test } from 'vitest';

import { createReferencedChildProcessExecutionPort } from '../child-process';
import type { ProcessExecutionChildHandle } from '../child-process';

describe('Node Compatibility child-process execution port adapters', () => {
  test('retains delegated child activity across admission and ref lifecycle', async () => {
    let active = 0;
    let resolveAdmission!: (handle: ProcessExecutionChildHandle) => void;
    const admission = new Promise<ProcessExecutionChildHandle>((resolve) => {
      resolveAdmission = resolve;
    });
    let resolveExit!: (result: { readonly code: number; readonly signal: null }) => void;
    const exit = new Promise<{ readonly code: number; readonly signal: null }>((resolve) => {
      resolveExit = resolve;
    });
    const port = createReferencedChildProcessExecutionPort(
      {
        spawn: () => admission,
        signal: async () => true
      },
      {
        acquire: () => {
          active += 1;
          let released = false;
          return () => {
            if (released) return;
            released = true;
            active -= 1;
          };
        }
      }
    );
    const spawned = port.spawn({
      command: 'helper',
      args: ['installed-bin'],
      cwd: '/home/project',
      env: {},
      parentPid: 41,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }
    });

    expect(active).toBe(1);
    resolveAdmission({
      pid: 73,
      stdin: new WritableStream<Uint8Array>(),
      stdout: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      stderr: new ReadableStream<Uint8Array>({ start: (controller) => controller.close() }),
      exit
    });
    const child = await spawned;
    expect(child.hasRef?.()).toBe(true);

    child.unref?.();
    expect(active).toBe(0);
    expect(child.hasRef?.()).toBe(false);
    child.ref?.();
    expect(active).toBe(1);
    expect(child.hasRef?.()).toBe(true);

    resolveExit({ code: 0, signal: null });
    await exit;
    await Promise.resolve();
    expect(active).toBe(0);
    expect(child.hasRef?.()).toBe(false);
  });
});

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, test } from 'vitest';

import {
  serveVirtualFileSystem
} from '../../src/runtime/modules/virtual-file-system';

describe('Virtual File System execution-client cutover', () => {
  test('serves one typed RPC interface instead of tier-specific clients', () => {
    expect(serveVirtualFileSystem().api).toMatchObject({
      readFile: expect.any(Function),
      commit: expect.any(Function)
    });
    expect(existsSync('src/runtime/modules/virtual-file-system/worker-peer.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/virtual-file-system/client-relay.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/virtual-file-system/execution-context-client.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/virtual-file-system/transaction-client.ts')).toBe(false);
    expect(existsSync('src/runtime/modules/virtual-file-system/transaction.ts')).toBe(false);
  });

  test('deletes the VFS Migration Bridge and its shrink-only policy', () => {
    expect(existsSync('src/runtime/vfs.ts')).toBe(false);
    expect(existsSync('architecture/vfs-migration-bridge.cjs')).toBe(false);
  });

  test('removes full-tree startup projection and mutation fan-out from the worker protocol', () => {
    const protocol = readFileSync(
      'src/runtime/modules/runtime-host/process-worker-protocol.ts',
      'utf8'
    );
    const program = readFileSync(
      'src/runtime/modules/runtime-host/runtime-program-host.ts',
      'utf8'
    );
    const worker = readFileSync(
      'src/runtime/modules/runtime-host/node-process-worker.ts',
      'utf8'
    );
    const entryPoint = readFileSync(
      'src/runtime/modules/virtual-file-system/index.ts',
      'utf8'
    );

    expect(protocol).not.toContain('snapshot: FileSystemTree');
    expect(protocol).not.toContain("type: 'fs-mutation'");
    expect(program).not.toContain('snapshotTree(');
    expect(program).not.toContain('watchMutations(');
    expect(program).not.toContain('executionFileSystem');
    expect(worker).not.toContain('message.snapshot');
    expect(worker).not.toContain('watchMutations(');
    expect(entryPoint).not.toContain('serveVirtualFileSystemClientRelay');
    expect(entryPoint).not.toContain('createExecutionContextVirtualFileSystemClient');
    expect(entryPoint).not.toContain('createAsyncVirtualFileSystemTransaction');
    expect(worker).toContain(
      'execution-context:${message.contextId}:process:${message.pid}'
    );
  });
});

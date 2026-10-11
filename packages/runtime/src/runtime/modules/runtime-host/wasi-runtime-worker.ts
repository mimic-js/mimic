/// <reference lib="webworker" />

import {
  executeWasiPreview1Command
} from '../wasi-execution';
import {
  connectRpc,
  connectSynchronousRpc,
  synchronousChannelWords,
  transfer
} from '../worker-transport';
import { createSynchronousVirtualFileSystemClient } from '../virtual-file-system';
import { wasiVfsPort } from '../node-compatibility';
import {
  WASI_STDIN_AVAILABLE_WORD,
  type WasiRuntimeHostApi,
  type WasiRuntimeWorkerApi,
  type WasiRuntimeWorkerStart,
  type WasiStdinApi
} from './wasi-runtime-program';

const scope = self as DedicatedWorkerGlobalScope;
const host = connectRpc<WasiRuntimeHostApi>(scope, {
  run
} satisfies WasiRuntimeWorkerApi).notify;

async function run(message: WasiRuntimeWorkerStart): Promise<number> {
  const fileSystem = createSynchronousVirtualFileSystemClient(message.fileSystem);
  const stdin = connectSynchronousRpc<WasiStdinApi>(message.stdin).remote;
  const stdinAvailable = synchronousChannelWords(message.stdin);
  try {
    return await executeWasiPreview1Command({
      bytes: message.bytes,
      args: message.args,
      env: message.env,
      stdin: {
        available: () => Atomics.load(stdinAvailable, WASI_STDIN_AVAILABLE_WORD),
        wait: (observed, timeoutMilliseconds) => {
          Atomics.wait(stdinAvailable, WASI_STDIN_AVAILABLE_WORD, observed, timeoutMilliseconds);
        },
        read: (maximumBytes) => stdin.read(maximumBytes) ?? undefined
      },
      stdout: writer('stdout'),
      stderr: writer('stderr'),
      // The synchronous client has no isFile/isDirectory: the port stats the path.
      vfs: wasiVfsPort(fileSystem)
    });
  } catch (error) {
    const normalized = error instanceof Error ? error : new Error(String(error));
    throw new Error(normalized.stack ?? normalized.message);
  } finally {
    fileSystem.close();
  }
}

function writer(stream: 'stdout' | 'stderr') {
  return {
    write(chunk: Uint8Array): void {
      const data = chunk.slice().buffer;
      host.output(stream, transfer(data, [data]));
    }
  };
}

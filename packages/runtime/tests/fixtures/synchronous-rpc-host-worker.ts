import { parentPort, workerData } from 'node:worker_threads';

import {
  serveSynchronousRpc,
  synchronousChannelWords,
  type SynchronousChannel
} from '../../src/runtime/modules/worker-transport/index';

/**
 * Serves a synchronous channel from a worker thread so a unit test can block
 * on it the way a process worker blocks on the Runtime Host.
 */
if (!parentPort) throw new Error('The synchronous RPC host fixture must run as a worker thread.');
const port = parentPort;
const channel = (workerData as { channel: SynchronousChannel }).channel;
const words = synchronousChannelWords(channel);

const server = serveSynchronousRpc(channel, {
  echo: (value: unknown) => value,
  math: {
    add: (left: number, right: number) => left + right
  },
  later: (value: unknown, milliseconds: number) =>
    new Promise((resolve) => setTimeout(() => resolve(value), milliseconds)),
  bytes: (length: number) => Uint8Array.from({ length }, (_, index) => index % 251),
  fail(code: string) {
    throw Object.assign(new RangeError(`failed with ${code}`), { code });
  },
  publish(value: number) {
    Atomics.store(words, 0, value);
  }
});

port.on('message', (command: { readonly type: 'stall' | 'close' | 'fail'; readonly milliseconds?: number }) => {
  if (command.type === 'stall') {
    port.postMessage('stalling');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, command.milliseconds);
    return;
  }
  if (command.type === 'close') server.close();
  else server.fail();
  port.postMessage(command.type);
});
port.postMessage('ready');

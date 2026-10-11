import { once } from 'node:events';
import { Worker } from 'node:worker_threads';

import { afterEach, describe, expect, test } from 'vitest';

import {
  connectSynchronousRpc,
  createSynchronousChannel,
  serveSynchronousRpc,
  synchronousChannelWords,
  type SynchronousChannelOptions
} from '../../src/runtime/modules/worker-transport/index';
import { decodeValue } from '../../src/runtime/modules/worker-transport/value-codec';

// The channel's control header, as a caller that does not use the transport sees it.
const STATE = 0;
const CHUNK_LENGTH = 1;
const CHUNK_FINAL = 2;
const MESSAGE_LENGTH = 3;
const HEADER_INTS = 5;
const REQUEST = 1;
const PROCESSING = 3;
const RESPONSE = 4;
const RESPONSE_TAKEN = 5;
const TIMED_OUT = 6;

// The host fixture is TypeScript, so its worker thread registers the loader before importing it.
const TYPESCRIPT_WORKER_BOOTSTRAP = `
  import('tsx/esm/api').then(({ register }) => {
    register();
    return import(require('node:worker_threads').workerData.fixture);
  });
`;

type HostApi = {
  echo(value: unknown): unknown;
  math: { add(left: number, right: number): number };
  later(value: unknown, milliseconds: number): Promise<unknown>;
  bytes(length: number): Uint8Array;
  fail(code: string): never;
  publish(value: number): void;
};

const workers: Worker[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

async function serve(options: SynchronousChannelOptions = {}) {
  const channel = createSynchronousChannel({ words: 1, ...options });
  const worker = new Worker(TYPESCRIPT_WORKER_BOOTSTRAP, {
    eval: true,
    workerData: { fixture: new URL('../fixtures/synchronous-rpc-host-worker.ts', import.meta.url).href, channel }
  });
  workers.push(worker);
  await once(worker, 'message');
  const command = async (type: 'stall' | 'close' | 'fail', milliseconds?: number) => {
    worker.postMessage({ type, milliseconds });
    await once(worker, 'message');
  };
  return { channel, connection: connectSynchronousRpc<HostApi>(channel), command };
}

function code(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('synchronous RPC', () => {
  test('calls nested methods and returns values directly', async () => {
    const { connection } = await serve();
    expect(connection.remote.math.add(2, 3)).toBe(5);
    expect(connection.remote.echo({ nested: [new Map([['a', 1]])] })).toEqual({ nested: [new Map([['a', 1]])] });
    expect(connection.diagnostics.calls).toBe(2);
  });

  test('moves messages larger than the payload window in chunks both ways', async () => {
    const { connection } = await serve({ capacity: 64 });
    const sent = Uint8Array.from({ length: 70_000 }, (_, index) => (index * 31) % 256);

    expect(connection.remote.echo(sent)).toEqual(sent);
    expect(connection.remote.bytes(5_000)).toEqual(Uint8Array.from({ length: 5_000 }, (_, index) => index % 251));
    expect(connection.diagnostics.requestChunks).toBeGreaterThan(1_000);
    expect(connection.diagnostics.responseChunks).toBeGreaterThan(1_000);
  });

  test('waits for an asynchronous answer beyond the watchdog once the call is picked up', async () => {
    const { connection } = await serve({ watchdogMs: 50 });
    expect(connection.remote.later('late', 200)).toBe('late');
  });

  test('rethrows what the callee throws, and the channel keeps serving', async () => {
    const { connection } = await serve();
    let thrown: unknown;
    try {
      connection.remote.fail('E_CUSTOM');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ name: 'RangeError', message: 'failed with E_CUSTOM', code: 'E_CUSTOM' });
    expect(code(() => (connection.remote as unknown as { missing(): void }).missing())).toBeUndefined();
    expect(connection.remote.math.add(1, 1)).toBe(2);
  });

  test('fails only the call whose request or response exceeds the message limit', async () => {
    const { connection } = await serve({ capacity: 128, maxMessageBytes: 1_024 });
    expect(code(() => connection.remote.echo(new Uint8Array(4_096)))).toBe('SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE');
    expect(code(() => connection.remote.bytes(4_096))).toBe('SYNCHRONOUS_RPC_MESSAGE_TOO_LARGE');
    expect(connection.remote.math.add(20, 22)).toBe(42);
  });

  test('times out a call the callee does not pick up and recovers once it catches up', async () => {
    const { connection, command } = await serve({ watchdogMs: 100 });
    await command('stall', 400);
    expect(code(() => connection.remote.math.add(1, 2))).toBe('SYNCHRONOUS_RPC_TIMEOUT');
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(connection.remote.math.add(1, 2)).toBe(3);
  });

  test('publishes status words without a call', async () => {
    const { channel, connection } = await serve();
    connection.remote.publish(17);
    expect(Atomics.load(synchronousChannelWords(channel), 0)).toBe(17);
  });

  test('names a closed and a failed channel', async () => {
    const closed = await serve();
    await closed.command('close');
    expect(code(() => closed.connection.remote.math.add(1, 2))).toBe('SYNCHRONOUS_RPC_CLOSED');
    const failed = await serve();
    await failed.command('fail');
    expect(code(() => failed.connection.remote.math.add(1, 2))).toBe('SYNCHRONOUS_RPC_FAILED');
  });

  test('rejects a request whose announced length its chunks do not honour, without allocating it', async () => {
    const { channel, connection } = await serve({ capacity: 128, maxMessageBytes: 64 * 1024 * 1024 });
    const control = new Int32Array(channel.buffer, 0, HEADER_INTS);
    const payload = new Uint8Array(channel.buffer, (HEADER_INTS + channel.words) * 4, channel.capacity);
    const sendOneChunk = (announced: number, length: number, final: boolean) => {
      Atomics.store(control, CHUNK_LENGTH, length);
      Atomics.store(control, CHUNK_FINAL, final ? 1 : 0);
      Atomics.store(control, MESSAGE_LENGTH, announced);
      Atomics.store(control, STATE, REQUEST);
      Atomics.notify(control, STATE);
      while (Atomics.load(control, STATE) === REQUEST) Atomics.wait(control, STATE, REQUEST, 1_000);
      if (Atomics.load(control, STATE) === PROCESSING) {
        while (Atomics.load(control, STATE) === PROCESSING) Atomics.wait(control, STATE, PROCESSING, 1_000);
      }
      // The answer may span several chunks; each one but the last is acknowledged.
      const parts: Uint8Array[] = [];
      while (true) {
        expect(Atomics.load(control, STATE)).toBe(RESPONSE);
        parts.push(payload.slice(0, Atomics.load(control, CHUNK_LENGTH)));
        if (Atomics.load(control, CHUNK_FINAL) === 1) break;
        Atomics.store(control, STATE, RESPONSE_TAKEN);
        Atomics.notify(control, STATE);
        while (Atomics.load(control, STATE) === RESPONSE_TAKEN) Atomics.wait(control, STATE, RESPONSE_TAKEN, 1_000);
      }
      Atomics.store(control, STATE, 0);
      Atomics.notify(control, STATE);
      const joined = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.byteLength;
      }
      return decodeValue(joined) as [number, { message: string }];
    };

    // A final chunk of 16 bytes for a request announced as 48 MiB: no 48 MiB buffer, one error.
    const short = sendOneChunk(48 * 1024 * 1024, 16, true);
    expect(short[0]).toBe(1);
    expect(short[1].message).toMatch(/ended after 16 of its announced 50331648 bytes/u);
    const overflow = sendOneChunk(8, 16, false);
    expect(overflow[0]).toBe(1);
    expect(overflow[1].message).toMatch(/does not fit its announced length of 8/u);
    const negative = sendOneChunk(-1, 16, true);
    expect(negative[0]).toBe(1);
    expect(negative[1].message).toMatch(/announced a length of -1/u);
    // The channel is intact for an honest caller.
    expect(connection.remote.math.add(2, 2)).toBe(4);
    expect(connection.remote.echo(new Uint8Array(70_000))).toHaveLength(70_000);
  });

  test('the serving loop yields to other work while a caller keeps the control header busy', async () => {
    const channel = createSynchronousChannel({ capacity: 64 });
    const control = new Int32Array(channel.buffer, 0, HEADER_INTS);
    // A caller that always wins the race: the moment the callee publishes a
    // transition, the header is busy again. Driving it from the callee's own
    // notify makes the spin deterministic, where a spinning thread would not be.
    const notify = Atomics.notify;
    let transitions = 0;
    Atomics.notify = (array, index, count) => {
      if (array.buffer === channel.buffer && index === STATE) {
        transitions += 1;
        Atomics.store(control, STATE, TIMED_OUT);
        return 0;
      }
      return notify(array, index, count);
    };
    let server: ReturnType<typeof serveSynchronousRpc> | undefined;
    try {
      Atomics.store(control, STATE, TIMED_OUT);
      server = serveSynchronousRpc(channel, { noop: () => undefined });
      // Without a yield the loop never leaves its task and this timer never fires.
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(transitions).toBeGreaterThan(64);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    } finally {
      Atomics.notify = notify;
      server?.close();
    }
  });
});

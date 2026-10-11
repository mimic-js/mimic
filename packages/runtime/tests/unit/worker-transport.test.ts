import { globSync, readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

import { expect, test, vi } from 'vitest';

import {
  connectRpc,
  transfer,
  workerTransportBrowserArtifactSource,
  type RpcConnection
} from '../../src/runtime/modules/worker-transport/index';

type Calculator = {
  double(value: number): Promise<number>;
  fail(code: string): never;
  stream(): ReadableStream<number>;
  readonly nested: {
    record(value: string): void;
  };
};

class DomainError extends Error {
  readonly code: string;
  readonly detail: number;

  constructor(code: string) {
    super(`domain failure ${code}`);
    this.name = 'DomainError';
    this.code = code;
    this.detail = 7;
  }
}

function connectPair<Api extends object>(implementation: Api): {
  readonly client: RpcConnection<Api>;
  readonly server: RpcConnection<Record<never, never>>;
} {
  const channel = new MessageChannel();
  return {
    server: connectRpc(channel.port1, implementation),
    client: connectRpc<Api>(channel.port2)
  };
}

test('only Worker Transport speaks the RPC wire vocabulary and the WorkerPeer layer is gone', () => {
  const productionSources = globSync('src/runtime/**/*.{ts,js}')
    .filter((path) => !path.endsWith('.test.ts'))
    .filter((path) => !path.includes('/__tests__/'))
    .filter((path) => !path.includes('/worker-transport/'))
    .filter((path) => path !== 'src/runtime/modules/published-endpoint/service-worker.js');
  const wireVocabulary = /rpc:(?:call|return|throw|close)|worker-transport\/|WorkerPeer|handleRequest|maxInFlightRequests/;

  expect(globSync('src/runtime/modules/*/worker-peer.ts')).toEqual([]);
  expect(
    productionSources.filter((path) => wireVocabulary.test(readFileSync(path, 'utf8')))
  ).toEqual([]);
});

test('a throwing handler rejects only that call and the connection keeps serving', async () => {
  const recorded: string[] = [];
  const { client, server } = connectPair<Calculator>({
    double: async (value) => value * 2,
    fail(code) {
      throw new DomainError(code);
    },
    stream: () => new ReadableStream(),
    nested: {
      record(value) {
        recorded.push(value);
      }
    }
  });

  await expect(client.remote.fail('E_DOMAIN')).rejects.toMatchObject({
    name: 'DomainError',
    message: 'domain failure E_DOMAIN',
    code: 'E_DOMAIN',
    detail: 7
  });
  await expect(client.remote.double(21)).resolves.toBe(42);
  client.notify.nested.record('first');
  client.notify.nested.record('second');
  await expect(client.remote.double(1)).resolves.toBe(2);
  expect(recorded).toEqual(['first', 'second']);
  await expect(
    (client.remote as unknown as { missing(): Promise<void> }).missing()
  ).rejects.toThrow('RPC method missing is not implemented.');
  await expect(
    (client.remote as unknown as { constructor(): Promise<void> }).constructor()
  ).rejects.toThrow('is not implemented');

  client.close();
  await server.closed;
});

test('calls correlate out of order, transfer marked values, and reject when either side closes', async () => {
  const completions = new Map<number, (value: number) => void>();
  let pulls = 0;
  const { client, server } = connectPair<Calculator & { echo(value: ArrayBuffer): ArrayBuffer }>({
    double: (value) => new Promise<number>((resolve) => completions.set(value, resolve)),
    fail: () => {
      throw new Error('unused');
    },
    stream() {
      const stream = new ReadableStream<number>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(pulls);
          if (pulls === 100) controller.close();
        }
      }, { highWaterMark: 0 });
      return transfer(stream, [stream]);
    },
    nested: { record: () => undefined },
    echo: (value) => value
  });

  const first = client.remote.double(1);
  const second = client.remote.double(2);
  await vi.waitFor(() => expect(completions.size).toBe(2));
  completions.get(2)?.(4);
  await expect(second).resolves.toBe(4);
  completions.get(1)?.(2);
  await expect(first).resolves.toBe(2);

  const buffer = new Uint8Array([1, 2, 3]).buffer;
  const echoed = client.remote.echo(transfer(buffer, [buffer]));
  expect(buffer.byteLength).toBe(0);
  await expect(echoed).resolves.toEqual(new Uint8Array([1, 2, 3]).buffer);

  const reader = (await client.remote.stream()).getReader();
  await expect(reader.read()).resolves.toEqual({ done: false, value: 1 });
  expect(pulls).toBeLessThan(100);
  await reader.cancel();

  await expect(
    client.remote.echo((() => undefined) as unknown as ArrayBuffer)
  ).rejects.toThrow();

  const pending = client.remote.double(3);
  await vi.waitFor(() => expect(completions.has(3)).toBe(true));
  server.close();
  await expect(pending).rejects.toMatchObject({ code: 'RPC_CONNECTION_CLOSED' });
  await client.closed;
  await expect(client.remote.double(4)).rejects.toMatchObject({
    code: 'RPC_CONNECTION_CLOSED'
  });
  expect(() => client.notify.nested.record('dropped')).not.toThrow();
});

test('the browser artifact embeds the same self-contained transport', async () => {
  const transport = runInThisContext(
    `(() => {\n${workerTransportBrowserArtifactSource()}\nreturn { connectRpc, transfer, openMessageStream };\n})()`
  ) as {
    connectRpc: typeof connectRpc;
    openMessageStream: (port: MessagePort) => {
      send(message: unknown): void;
      subscribe(listener: (message: unknown) => void): () => void;
      close(): void;
    };
  };
  const channel = new MessageChannel();
  transport.connectRpc(channel.port1, {
    fail() {
      throw new DomainError('E_ARTIFACT');
    }
  });
  const client = connectRpc<{ fail(): void }>(channel.port2);
  await expect(client.remote.fail()).rejects.toMatchObject({ code: 'E_ARTIFACT' });
  client.close();

  const streams = new MessageChannel();
  const left = transport.openMessageStream(streams.port1);
  const right = transport.openMessageStream(streams.port2);
  const received = new Promise<unknown>((resolve) => right.subscribe(resolve));
  left.send({ type: 'marker' });
  await expect(received).resolves.toEqual({ type: 'marker' });
  left.close();
  right.close();
});

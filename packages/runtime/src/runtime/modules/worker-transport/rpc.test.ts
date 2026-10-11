import { expect, test, vi } from 'vitest';

import { connectRpc, reviveError, serializeError, type RpcConnection } from './index';

type Api = {
  double(value: number): number;
  readonly nested: {
    record(value: string): void;
    explode(): void;
    rejectLater(): Promise<void>;
  };
};

function connectPair(implementation: Api, onNotificationError?: (error: unknown, path: readonly string[]) => void): {
  readonly client: RpcConnection<Api>;
  readonly server: RpcConnection<Record<never, never>>;
  /** Posts a raw frame to the server, as a context running untrusted code can. */
  readonly raw: (frame: unknown) => void;
} {
  const channel = new MessageChannel();
  return {
    server: connectRpc(channel.port1, implementation, { onNotificationError }),
    client: connectRpc<Api>(channel.port2),
    raw: (frame) => channel.port2.postMessage(frame)
  };
}

test('malformed frames and failing notifications never escape the listener, and the connection keeps serving', async () => {
  const recorded: string[] = [];
  const failures: string[] = [];
  const { client, server, raw } = connectPair(
    {
      double: (value) => value * 2,
      nested: {
        record: (value) => void recorded.push(value),
        explode() {
          throw new Error('exploded');
        },
        rejectLater: () => Promise.reject(new Error('rejected later'))
      }
    },
    (error, path) => failures.push(`${path.join('.')}: ${(error as Error).message}`)
  );

  // Frames with a shape the transport never produces.
  raw(null);
  raw('rpc:call');
  raw({ kind: 'rpc:call', id: 0, path: 'nested', args: [] });
  raw({ kind: 'rpc:call', id: 0, path: ['nested', 7], args: [] });
  raw({ kind: 'rpc:call', id: 0, path: ['double'], args: 'not-an-array' });
  raw({ kind: 'rpc:call', id: -1, path: ['double'], args: [1] });
  raw({ kind: 'rpc:call', id: 1.5, path: ['double'], args: [1] });
  raw({ kind: 'rpc:return', id: 'x', value: 1 });
  raw({ kind: 'rpc:throw', id: 99 });
  // Notifications whose method is missing, is Object.prototype's, throws, or rejects.
  raw({ kind: 'rpc:call', id: 0, path: ['missing'], args: [] });
  raw({ kind: 'rpc:call', id: 0, path: ['constructor'], args: [] });
  client.notify.nested.explode();
  client.notify.nested.rejectLater();
  client.notify.nested.record('kept');

  await expect(client.remote.double(21)).resolves.toBe(42);
  await vi.waitFor(() => expect(failures).toHaveLength(4));
  expect(failures).toEqual([
    'missing: RPC method missing is not implemented.',
    'constructor: RPC method constructor is not implemented.',
    'nested.explode: exploded',
    'nested.rejectLater: rejected later'
  ]);
  expect(recorded).toEqual(['kept']);

  client.close();
  await server.closed;
});

test('a notification failure is logged when no hook receives it', async () => {
  const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    const channel = new MessageChannel();
    const server = connectRpc(channel.port1, {});
    const client = connectRpc<{ missing(): void }>(channel.port2);
    client.notify.missing();
    await vi.waitFor(() => expect(logged).toHaveBeenCalledTimes(1));
    expect(logged.mock.calls[0]?.[0]).toBe('RPC notification missing failed:');
    client.close();
    await server.closed;
  } finally {
    logged.mockRestore();
  }
});

test('an rpc:throw without a well-formed error still rejects only that call', async () => {
  const channel = new MessageChannel();
  const client = connectRpc<{ ask(): string; ask2(): string }>(channel.port1);
  const frames: { readonly id: number }[] = [];
  channel.port2.addEventListener('message', (event) => frames.push(event.data as { readonly id: number }));
  channel.port2.start();

  const first = client.remote.ask();
  const second = client.remote.ask2();
  await vi.waitFor(() => expect(frames).toHaveLength(2));
  channel.port2.postMessage({ kind: 'rpc:throw', id: frames[0]!.id });
  channel.port2.postMessage({ kind: 'rpc:throw', id: frames[1]!.id, error: 'nope' });
  await expect(first).rejects.toMatchObject({
    name: 'Error',
    message: 'The RPC peer rejected the call without an error.'
  });
  await expect(second).rejects.toMatchObject({ name: 'Error' });
  client.close();
});

test('a revived error takes its name, message and stack from the named fields only', () => {
  const revived = reviveError({
    name: 'DomainError',
    message: 'the message',
    stack: 'the stack',
    properties: {
      name: 'Forged',
      message: 'forged message',
      stack: 'forged stack',
      code: 'E_CODE',
      detail: 7
    }
  });
  expect(revived).toMatchObject({ name: 'DomainError', message: 'the message', stack: 'the stack', code: 'E_CODE', detail: 7 });
  expect(revived).toBeInstanceOf(Error);

  const roundTripped = reviveError(serializeError(Object.assign(new RangeError('ranged'), { code: 'E_RANGE' })));
  expect(roundTripped).toMatchObject({ name: 'RangeError', message: 'ranged', code: 'E_RANGE' });
  // A frame from an untrusted context may lack the fields altogether.
  expect(reviveError({ message: 'bare' } as never)).toMatchObject({ name: 'Error', message: 'bare' });
});

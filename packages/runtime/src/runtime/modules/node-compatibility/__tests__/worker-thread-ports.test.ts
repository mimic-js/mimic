import { describe, expect, test } from 'vitest';

import type { WorkerThreadMessage } from '..';
import {
  createWorkerThreadPortRelay,
  PORT_DELIVERY_SEEN_WORD,
  PORT_NOTIFICATIONS_SENT_WORD,
  PROCESS_CHANNEL_WORDS
} from '../worker-thread-ports';

function thread(relay: ReturnType<typeof createWorkerThreadPortRelay>, name: string) {
  const words = new Int32Array(new SharedArrayBuffer(PROCESS_CHANNEL_WORDS * 4));
  const delivered: Array<{ id: string; seq: number; delivery: number; value: unknown }> = [];
  const closed: string[] = [];
  const api = relay.connect(name, {
    words,
    deliver: (id, seq, delivery, message) => delivered.push({ id, seq, delivery, value: message.value }),
    closed: (id) => closed.push(id)
  });
  // Every notification counts, as the process worker counts what it sends.
  const notify = new Proxy(api, {
    get: (target, property) => (...args: unknown[]) => {
      Atomics.add(words, PORT_NOTIFICATIONS_SENT_WORD, 1);
      return Reflect.apply(Reflect.get(target, property) as (...values: unknown[]) => unknown, target, args);
    }
  });
  return { words, delivered, closed, notify };
}

const message = (value: unknown): WorkerThreadMessage => ({ value, references: [] });

describe('worker_threads port relay', () => {
  test('keeps messages for an end until its thread listens, then delivers them in order', () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    main.notify.open('a', 'b', [message('pending')]);
    main.notify.post('a', message('first'));

    expect(worker.delivered).toEqual([]);
    worker.notify.listen('b');
    expect(worker.delivered.map(({ value, delivery }) => [value, delivery])).toEqual([
      ['pending', 1],
      ['first', 2]
    ]);
    worker.notify.post('b', message('reply'));
    expect(main.delivered.map(({ id, value }) => [id, value])).toEqual([['a', 'reply']]);
  });

  test('receives the next message synchronously, including one delivered but not yet taken in', async () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    main.notify.open('a', 'b', []);
    worker.notify.listen('b');
    main.notify.post('a', message('in-flight'));
    main.notify.post('a', message('also-in-flight'));

    await expect(relay.receive('worker', 'b')).resolves.toEqual({ message: message('in-flight'), delivery: 1 });
    // Once the worker took the second delivery in, it is no longer the relay's to give.
    Atomics.store(worker.words, PORT_DELIVERY_SEEN_WORD, 2);
    await expect(relay.receive('worker', 'b')).resolves.toBeUndefined();
  });

  test('waits for a message posted before the receive asked, while it is still on its way', async () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    thread(relay, 'worker');
    main.notify.open('a', 'b', []);
    // The post has been sent but has not arrived yet.
    Atomics.add(main.words, PORT_NOTIFICATIONS_SENT_WORD, 1);
    const received = relay.receive('worker', 'b');
    await Promise.resolve();
    Atomics.sub(main.words, PORT_NOTIFICATIONS_SENT_WORD, 1);
    main.notify.post('a', message('late'));

    await expect(received).resolves.toEqual({ message: message('late') });
  });

  test('restores a delivery that reached a thread after its end moved on', () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const first = thread(relay, 'first');
    const second = thread(relay, 'second');
    main.notify.open('a', 'b', []);
    main.notify.open('c', 'd', []);
    first.notify.listen('b');
    main.notify.post('a', message('in-flight'));
    // The first thread hands its end on to the second inside a message of another channel.
    first.notify.post('d', { value: { moved: true }, references: [{ port: 'b' }] });
    second.notify.listen('b');

    first.notify.restore('b', 1, message('in-flight'));
    expect(second.delivered.map(({ value, seq }) => [value, seq])).toEqual([['in-flight', 1]]);
  });

  test('closes both ends and tells the listener of the other one', () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    main.notify.open('a', 'b', []);
    worker.notify.listen('b');

    main.notify.close('a');
    main.notify.post('a', message('after-close'));

    expect(worker.closed).toEqual(['b']);
    expect(worker.delivered).toEqual([]);
  });

  test('keeps what was posted before a close receivable synchronously', async () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    // The pair is opened by the thread that keeps `a`; nothing listens on it.
    main.notify.open('a', 'b', []);
    main.notify.unlisten('a');
    worker.notify.post('b', message('answer'));
    worker.notify.close('b');

    await expect(relay.receive('main', 'a')).resolves.toEqual({ message: message('answer') });
    await expect(relay.receive('main', 'a')).resolves.toBeUndefined();
    expect(main.closed).toEqual([]);
  });

  test('keeps a delivery receivable synchronously after the close that followed it', async () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    // `a` listens, as the end a thread keeps does: the answer is delivered, then the close.
    main.notify.open('a', 'b', []);
    worker.notify.post('b', message('answer'));
    worker.notify.close('b');

    expect(main.delivered.map(({ value, delivery }) => [value, delivery])).toEqual([['answer', 1]]);
    expect(main.closed).toEqual(['a']);
    // The thread blocked before either arrived and now asks for the message.
    await expect(relay.receive('main', 'a')).resolves.toEqual({ message: message('answer'), delivery: 1 });
    await expect(relay.receive('main', 'a')).resolves.toBeUndefined();
  });

  test('delivers what was posted before a close to a thread that listens afterwards', () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    main.notify.open('a', 'b', []);
    main.notify.post('a', message('last words'));
    main.notify.close('a');

    worker.notify.listen('b');

    expect(worker.delivered.map(({ value }) => value)).toEqual(['last words']);
    expect(worker.closed).toEqual(['b']);
  });

  test('closes the ends a finished thread listened to', () => {
    const relay = createWorkerThreadPortRelay();
    const main = thread(relay, 'main');
    const worker = thread(relay, 'worker');
    main.notify.open('worker-end', 'parent-port', []);
    worker.notify.listen('parent-port');

    relay.disconnect('worker');

    expect(main.closed).toEqual(['worker-end']);
  });
});

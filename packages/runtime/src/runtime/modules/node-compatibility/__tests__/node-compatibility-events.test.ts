import { expect, test } from 'vitest';

import {
  nodeEvents,
  type EventEmitter,
  type EventListener
} from '../events';

test('EventEmitter.once removes its pending event listener when error rejects the wait', async () => {
  const events = nodeEvents as {
    EventEmitter: {
      new (): {
        emit(event: string, ...args: unknown[]): boolean;
        listenerCount(event: string): number;
      };
      once(
        emitter: { emit(event: string, ...args: unknown[]): boolean; listenerCount(event: string): number },
        event: string
      ): Promise<unknown[]>;
    };
  };
  const emitter = new events.EventEmitter();
  const completed = events.EventEmitter.once(emitter, 'ready');

  emitter.emit('error', new Error('stop'));

  await expect(completed).rejects.toThrow('stop');
  expect(emitter.listenerCount('ready')).toBe(0);
  expect(emitter.listenerCount('error')).toBe(0);
});

test('EventEmitter.removeListener removes only the most recently added matching listener', () => {
  const events = nodeEvents as {
    EventEmitter: new () => {
      emit(event: string): boolean;
      listenerCount(event: string): number;
      on(event: string, listener: () => void): unknown;
      removeListener(event: string, listener: () => void): unknown;
    };
  };
  const emitter = new events.EventEmitter();
  let calls = 0;
  const listener = () => {
    calls += 1;
  };

  emitter.on('ready', listener);
  emitter.on('ready', listener);
  emitter.removeListener('ready', listener);

  expect(emitter.listenerCount('ready')).toBe(1);
  expect(emitter.emit('ready')).toBe(true);
  expect(calls).toBe(1);
});

test('EventEmitter.off bypasses an overriding removeListener without recursive delegation', () => {
  const events = nodeEvents as {
    EventEmitter: new () => {
      off(event: string, listener: () => void): unknown;
      on(event: string, listener: () => void): unknown;
      removeListener(event: string, listener: () => void): unknown;
    };
  };
  class DerivedEmitter extends events.EventEmitter {
    override removeListener(event: string, listener: () => void): this {
      this.off(event, listener);
      return this;
    }
  }
  const emitter = new DerivedEmitter();
  const listener = () => undefined;
  emitter.on('ready', listener);

  expect(() => emitter.off('ready', listener)).not.toThrow();
});

test('EventEmitter.listeners exposes the original once listener', () => {
  const events = nodeEvents as {
    EventEmitter: new () => {
      listeners(event: string): EventListener[];
      once(event: string, listener: EventListener): unknown;
    };
  };
  const emitter = new events.EventEmitter();
  const listener: EventListener = () => {};

  emitter.once('ready', listener);

  expect(emitter.listeners('ready')).toEqual([listener]);
});

test('EventEmitter prepend listeners run first and prependOnceListener removes itself', () => {
  const events = nodeEvents as {
    EventEmitter: new () => {
      emit(event: string): boolean;
      on(event: string, listener: () => void): unknown;
      prependListener(event: string, listener: () => void): unknown;
      prependOnceListener(event: string, listener: () => void): unknown;
    };
  };
  const emitter = new events.EventEmitter();
  const observed: string[] = [];

  emitter.on('ready', () => observed.push('on'));
  emitter.prependOnceListener('ready', () => observed.push('prepend-once'));
  emitter.prependListener('ready', () => observed.push('prepend'));

  expect(emitter.emit('ready')).toBe(true);
  expect(emitter.emit('ready')).toBe(true);
  expect(observed).toEqual(['prepend', 'prepend-once', 'on', 'prepend', 'on']);
});

test('EventEmitter throws an unhandled error event', () => {
  const events = nodeEvents as {
    EventEmitter: new () => {
      emit(event: string, error: Error): boolean;
    };
  };
  const emitter = new events.EventEmitter();
  const error = new Error('unhandled');

  expect(() => emitter.emit('error', error)).toThrow(error);
});

test('events preserves the EventEmitter export, max-listener, and legacy-construction contracts', () => {
  const events = nodeEvents as {
    EventEmitter: {
      new (): {
        emit(event: string, value: string): boolean;
        getMaxListeners(): number;
        on(event: string, listener: (this: unknown, value: string) => void): unknown;
        setMaxListeners(count: number): unknown;
      };
      (this: unknown): void;
      prototype: object;
      default: unknown;
      EventEmitter: unknown;
      getMaxListeners(target: object): number;
      setMaxListeners(count: number, ...targets: object[]): void;
    };
    default: unknown;
  };
  const emitter = new events.EventEmitter();
  const observed: string[] = [];

  emitter.on('message', function (value) {
    observed.push(`${this === emitter ? 'bound' : 'unbound'}:${value}`);
  });
  expect(emitter.setMaxListeners(0)).toBe(emitter);
  expect(emitter.getMaxListeners()).toBe(0);
  events.EventEmitter.setMaxListeners(12, emitter);
  expect(events.EventEmitter.getMaxListeners(emitter)).toBe(12);
  expect(emitter.emit('message', 'payload')).toBe(true);
  expect(observed).toEqual(['bound:payload']);

  function LegacyEmitter(this: unknown) {
    events.EventEmitter.call(this);
  }
  LegacyEmitter.prototype = Object.create(events.EventEmitter.prototype) as object;
  const legacyEmitter = new LegacyEmitter() as unknown as {
    emit(event: string, value: string): boolean;
    once(event: string, listener: (value: string) => void): unknown;
  };
  const legacyValues: string[] = [];

  legacyEmitter.once('ready', (value) => legacyValues.push(value));
  expect(legacyEmitter.emit('ready', 'first')).toBe(true);
  expect(legacyEmitter.emit('ready', 'second')).toBe(false);
  expect(legacyValues).toEqual(['first']);
  expect(events.default).toBe(events.EventEmitter);
  expect(events.EventEmitter.default).toBe(events.EventEmitter);
  expect(events.EventEmitter.EventEmitter).toBe(events.EventEmitter);
});

test('EventEmitterAsyncResource exposes Piscina-compatible async resource identity', () => {
  const events = nodeEvents as {
    EventEmitterAsyncResource: new (options: { name: string; triggerAsyncId?: number }) =>
      EventEmitter & {
        readonly asyncId: number;
        readonly triggerAsyncId: number;
        readonly asyncResource: {
          asyncId(): number;
          triggerAsyncId(): number;
        };
        emitDestroy(): EventEmitter;
      };
  };
  const emitter = new events.EventEmitterAsyncResource({ name: 'Piscina', triggerAsyncId: 7 });
  const observed: string[] = [];

  emitter.on('ready', () => observed.push('ready'));
  emitter.emit('ready');

  expect(observed).toEqual(['ready']);
  expect(emitter.asyncResource.asyncId()).toBe(emitter.asyncId);
  expect(emitter.asyncResource.triggerAsyncId()).toBe(7);
  expect(emitter.triggerAsyncId).toBe(7);
  expect(emitter.emitDestroy()).toBe(emitter);
});

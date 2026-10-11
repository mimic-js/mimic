import EventEmitter from 'events/events.js';
import { asyncContext } from '../module-execution-engine';

export { EventEmitter };
export type EventListener = (this: unknown, ...args: any[]) => void;

/**
 * `node:events` is the `events` port (ADR-0026), Node's EventEmitter for every
 * engine. Its emitter predates these Node statics, which this module adds to
 * it, and `EventEmitterAsyncResource`, whose listeners run in the Async Context
 * frame the emitter was created in (ADR-0018).
 */
type EventsBuiltin = typeof EventEmitter & {
  readonly default: typeof EventEmitter;
  readonly EventEmitterAsyncResource: typeof EventEmitterAsyncResource;
  getMaxListeners(target: object): number;
  setMaxListeners(count: number, ...targets: object[]): void;
  addAbortListener(signal: AbortSignal, listener: () => void): Disposable;
};

const targetMaxListeners = new WeakMap<object, number>();
let nextAsyncId = 1;

class EventEmitterAsyncResource extends EventEmitter {
  private readonly resourceId = nextAsyncId++;
  private readonly parentResourceId: number;
  private readonly frame = asyncContext.frame();

  constructor(options: { name: string; triggerAsyncId?: number }) {
    super();
    if (typeof options?.name !== 'string') {
      throw new TypeError('The "options.name" property must be of type string');
    }
    this.parentResourceId = options.triggerAsyncId ?? 0;
  }

  override emit(event: string | symbol, ...args: unknown[]): boolean {
    return asyncContext.run(this.frame, () => super.emit(event, ...args));
  }

  get asyncId(): number {
    return this.resourceId;
  }

  get triggerAsyncId(): number {
    return this.parentResourceId;
  }

  get asyncResource(): { asyncId(): number; triggerAsyncId(): number; emitDestroy(): EventEmitterAsyncResource } {
    return {
      asyncId: () => this.resourceId,
      triggerAsyncId: () => this.parentResourceId,
      emitDestroy: () => this
    };
  }

  emitDestroy(): this {
    return this;
  }
}

type Disposable = Record<symbol, () => void>;

function isEmitter(target: object): target is EventEmitter {
  return typeof (target as Partial<EventEmitter>).getMaxListeners === 'function';
}

Object.assign(EventEmitter, {
  default: EventEmitter,
  EventEmitterAsyncResource,
  captureRejectionSymbol: Symbol.for('nodejs.rejection'),
  getMaxListeners: (target: object) =>
    isEmitter(target) ? target.getMaxListeners() : targetMaxListeners.get(target) ?? EventEmitter.defaultMaxListeners,
  setMaxListeners: (count: number, ...targets: object[]) => {
    for (const target of targets) {
      if (isEmitter(target)) target.setMaxListeners(count);
      else targetMaxListeners.set(target, count);
    }
  },
  addAbortListener: (signal: AbortSignal, listener: () => void): Disposable => {
    if (signal.aborted) queueMicrotask(listener);
    else signal.addEventListener('abort', listener, { once: true });
    const dispose = (Symbol as SymbolConstructor & { dispose?: symbol }).dispose ?? Symbol.for('nodejs.dispose');
    return {
      [dispose]() {
        signal.removeEventListener('abort', listener);
      }
    };
  }
});

export const nodeEvents = EventEmitter as EventsBuiltin;

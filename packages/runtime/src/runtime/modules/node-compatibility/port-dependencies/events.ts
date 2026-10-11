import { portDependencies } from './registry';

type EventsModule = { readonly EventEmitter: unknown; readonly addAbortListener: unknown };

/** `events` as the adopted ports import it: the runtime's `node:events`. */
export const { EventEmitter, addAbortListener } = portDependencies().events as EventsModule;

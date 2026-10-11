import { asyncContext } from '../../module-execution-engine';
import { nodeBuffer } from '../buffer';
import { nodeEvents } from '../events';
import { parse, stringify } from '../querystring';
import { providePortDependencies } from './registry';

providePortDependencies({
  buffer: nodeBuffer,
  events: nodeEvents,
  querystring: { parse: (query) => parse(query), stringify: (query) => stringify(query) },
  nextTick(callback, ...args) {
    const frame = asyncContext.frame();
    queueMicrotask(() => asyncContext.run(frame, () => callback(...args)));
  }
});

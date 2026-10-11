import { queueMacrotask } from './macrotask';
import type { Remote } from './rpc';

/**
 * Drives an interface served in this same context the way another context
 * would: every call runs as its own task and works on copies of its arguments
 * and result, so neither side observes the other's later mutations and a long
 * sequence of calls leaves room for the context's other work.
 */
export function localRemote<Api extends object>(local: Api): Remote<Api> {
  const proxy = (target: object): unknown =>
    new Proxy(target, {
      get(source, property) {
        if (typeof property === 'symbol' || property === 'then') return undefined;
        const member = Reflect.get(source, property) as unknown;
        if (typeof member !== 'function') {
          return typeof member === 'object' && member !== null ? proxy(member) : undefined;
        }
        return (...args: unknown[]) =>
          new Promise((resolve, reject) => {
            queueMacrotask(() => {
              try {
                Promise.resolve(member.apply(source, structuredClone(args))).then(
                  (value: unknown) => resolve(structuredClone(value)),
                  reject
                );
              } catch (error) {
                reject(error);
              }
            });
          });
      }
    });
  return proxy(local) as Remote<Api>;
}

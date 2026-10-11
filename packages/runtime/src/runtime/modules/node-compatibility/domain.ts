import { EventEmitter } from './events';

type Callback = (...args: unknown[]) => unknown;

/**
 * `node:domain`, deprecated in Node and kept for the packages that still load
 * it. A domain routes the errors of what it runs, binds or intercepts to its
 * `error` listeners; without one an error propagates as it would without the
 * domain. Errors of asynchronous work started inside `run()` stay with that
 * work, since the runtime does not carry a domain across async boundaries.
 */
export function createDomainBuiltin(): unknown {
  const stack: Domain[] = [];

  class Domain extends EventEmitter {
    members: unknown[] = [];

    enter(): void {
      stack.push(this);
      domain.active = this;
    }

    exit(): void {
      const index = stack.lastIndexOf(this);
      if (index >= 0) stack.length = index;
      domain.active = stack.at(-1);
    }

    add(member: unknown): void {
      if (!this.members.includes(member)) this.members.push(member);
    }

    remove(member: unknown): void {
      const index = this.members.indexOf(member);
      if (index >= 0) this.members.splice(index, 1);
    }

    run<T>(callback: (...args: unknown[]) => T, ...args: unknown[]): T | undefined {
      this.enter();
      try {
        return callback.apply(this, args);
      } catch (error) {
        this.handle(error);
        return undefined;
      } finally {
        this.exit();
      }
    }

    bind<T extends Callback>(callback: T): T {
      const bound = (...args: unknown[]) => this.run(() => callback(...args));
      return Object.assign(bound, { domain: this }) as unknown as T;
    }

    intercept<T extends Callback>(callback: T): T {
      const intercepted = (error: unknown, ...args: unknown[]) => {
        if (error) {
          this.handle(error);
          return undefined;
        }
        return this.run(() => callback(...args));
      };
      return Object.assign(intercepted, { domain: this }) as unknown as T;
    }

    dispose(): void {
      this.exit();
      this.members = [];
      this.removeAllListeners();
    }

    private handle(error: unknown): void {
      if (this.listenerCount('error') === 0) throw error;
      if (error !== null && typeof error === 'object') {
        Object.assign(error, { domain: this, domainThrown: true });
      }
      this.emit('error', error);
    }
  }

  const create = () => new Domain();
  const domain: { Domain: typeof Domain; active: Domain | undefined; create: () => Domain; createDomain: () => Domain } = {
    Domain,
    active: undefined,
    create,
    createDomain: create
  };
  return Object.assign(domain, { default: domain });
}

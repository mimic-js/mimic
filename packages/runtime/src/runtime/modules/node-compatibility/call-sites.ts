/**
 * Has a structured stack trace name the file of each compiled module, as
 * Node's does. A module here is compiled into a function whose source names
 * its file with `sourceURL`: the stack string shows the file, but V8's
 * `CallSite.getFileName()` answers only a script's own name, which evaluated
 * code has none of. Tools find themselves through it: pino resolves a log
 * transport from its callers' files, ember-cli its commands from its own.
 *
 * `Error.prepareStackTrace` becomes an accessor: the function a program sets
 * receives, for each frame without a file name, a stand-in whose
 * `getFileName()` answers the source URL. Its frame methods are frozen, so the
 * frames themselves cannot answer.
 */
export function installCallSiteFileNames(errorConstructor: ErrorConstructor = Error): void {
  if (INSTALLED.has(errorConstructor)) return;
  const current = Object.getOwnPropertyDescriptor(errorConstructor, 'prepareStackTrace');
  if (current && !current.configurable) return;
  INSTALLED.add(errorConstructor);
  let prepare: unknown = current && 'value' in current ? current.value : undefined;
  const wrappers = new WeakMap<Function, PrepareStackTrace>();
  const originals = new WeakMap<Function, Function>();
  Object.defineProperty(errorConstructor, 'prepareStackTrace', {
    configurable: true,
    enumerable: false,
    get() {
      if (typeof prepare !== 'function') return prepare;
      const program = prepare as PrepareStackTrace;
      let wrapper = wrappers.get(program);
      if (!wrapper) {
        wrapper = function (this: unknown, error: Error, frames: readonly CallSite[]) {
          return program.call(this, error, Array.isArray(frames) ? frames.map(withFileName) : frames);
        };
        wrappers.set(program, wrapper);
        originals.set(wrapper, program);
      }
      return wrapper;
    },
    set(value: unknown) {
      // A program that saved the function it read puts it back.
      prepare = typeof value === 'function' ? (originals.get(value) ?? value) : value;
    }
  });
}

type CallSite = Record<string, unknown> & {
  getFileName(): string | undefined | null;
  getScriptNameOrSourceURL?(): string | undefined | null;
};

type PrepareStackTrace = (this: unknown, error: Error, frames: readonly CallSite[]) => unknown;

const INSTALLED = new WeakSet<object>();

function withFileName(frame: CallSite): CallSite {
  if (!frame || typeof frame.getFileName !== 'function' || frame.getFileName()) return frame;
  const sourceUrl = frame.getScriptNameOrSourceURL?.();
  if (!sourceUrl) return frame;
  // The frame's own methods check their receiver, so the stand-in calls them on the frame.
  const standIn: Record<string, unknown> = {};
  for (let owner: object | null = Object.getPrototypeOf(frame); owner && owner !== Object.prototype; owner = Object.getPrototypeOf(owner)) {
    for (const name of Object.getOwnPropertyNames(owner)) {
      if (name === 'constructor' || Object.hasOwn(standIn, name)) continue;
      const method = (frame as Record<string, unknown>)[name];
      if (typeof method === 'function') standIn[name] = (...args: unknown[]) => method.apply(frame, args);
    }
  }
  standIn.getFileName = () => sourceUrl;
  return Object.setPrototypeOf(standIn, Object.getPrototypeOf(frame)) as CallSite;
}

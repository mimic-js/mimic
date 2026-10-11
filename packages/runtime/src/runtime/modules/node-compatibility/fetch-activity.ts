type Fetch = typeof globalThis.fetch;

const BODY_READERS = ['arrayBuffer', 'blob', 'bytes', 'formData', 'json', 'text'] as const;

let currentAcquire: (() => () => void) | undefined;

/**
 * Has each `fetch` the process makes keep it alive, as the socket under Node's
 * own `fetch` does: from the call until the response arrives, and again while
 * the program reads the body through `text()`, `json()` and the like. A tool
 * that starts its async main from a module function and awaits a download
 * (create-expo-app, Next.js fetching its SWC binary) otherwise ends the moment
 * nothing else is pending, with exit code 0.
 *
 * The worker's global `fetch` is replaced once: free identifiers and the
 * process's `globalThis` both reach it, and the worker runs one process.
 */
export function installFetchActivity(target: { fetch?: Fetch }, acquire: () => () => void): void {
  currentAcquire = acquire;
  const original = target.fetch;
  if (typeof original !== 'function' || FETCH_WITH_ACTIVITY.has(original)) return;
  const bound = original.bind(target);
  const fetchWithActivity = function fetch(input: Parameters<Fetch>[0], init?: Parameters<Fetch>[1]) {
    const release = hold();
    let pending: Promise<Response>;
    try {
      pending = bound(input, init);
    } catch (error) {
      release();
      throw error;
    }
    return pending.then(
      (response) => {
        release();
        return holdBodyReads(response);
      },
      (error: unknown) => {
        release();
        throw error;
      }
    );
  } as Fetch;
  FETCH_WITH_ACTIVITY.add(fetchWithActivity);
  Object.defineProperty(target, 'fetch', { configurable: true, enumerable: true, writable: true, value: fetchWithActivity });
}

const FETCH_WITH_ACTIVITY = new WeakSet<Function>();

function hold(): () => void {
  return currentAcquire?.() ?? (() => undefined);
}

function holdBodyReads(response: Response): Response {
  for (const name of BODY_READERS) {
    const read = (response as unknown as Record<string, unknown>)[name];
    if (typeof read !== 'function') continue;
    Object.defineProperty(response, name, {
      configurable: true,
      writable: true,
      value: function (this: Response, ...args: unknown[]) {
        const release = hold();
        let reading: Promise<unknown>;
        try {
          reading = (read as (...args: unknown[]) => Promise<unknown>).apply(this, args);
        } catch (error) {
          release();
          throw error;
        }
        return reading.finally(release);
      }
    });
  }
  return response;
}

// Execution Capacity derives from the Runtime Host Worker's
// navigator.hardwareConcurrency. Compatibility evidence must not change with
// the machine that runs it, so every page reports one pinned value and the
// Runtime Host Worker observes whatever the page reports when it boots.

export const DEFAULT_RUNTIME_HARDWARE_CONCURRENCY = 8;

const RUNTIME_HOST_WORKER_NAME = 'mimic-runtime-host';

export function pinRuntimeHardwareConcurrency(
  options: Readonly<{ hardwareConcurrency: number; runtimeHostWorkerName: string }>
): void {
  const NativeWorker = globalThis.Worker;
  if (typeof NativeWorker !== 'function') return;
  Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', {
    configurable: true,
    value: options.hardwareConcurrency
  });

  class PinnedHardwareConcurrencyWorker extends NativeWorker {
    constructor(scriptURL: string | URL, workerOptions?: WorkerOptions) {
      if (workerOptions?.name !== options.runtimeHostWorkerName || workerOptions.type !== 'module') {
        super(scriptURL, workerOptions);
        return;
      }
      // Static imports evaluate in order, so the pin is in place before the
      // Runtime Host Worker module reads navigator.hardwareConcurrency.
      const moduleUrl = (source: string) =>
        URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      const pin = moduleUrl(
        `Object.defineProperty(globalThis.navigator, 'hardwareConcurrency', { configurable: true, value: ${Number(
          globalThis.navigator.hardwareConcurrency
        )} });`
      );
      const runtimeHostUrl = new URL(scriptURL, globalThis.location.href).href;
      const entry = moduleUrl(`import ${JSON.stringify(pin)};\nimport ${JSON.stringify(runtimeHostUrl)};`);
      // The fragment keeps the Runtime Host Worker identifiable by its URL.
      super(`${entry}#${runtimeHostUrl}`, workerOptions);
    }
  }
  Object.defineProperty(globalThis, 'Worker', {
    configurable: true,
    writable: true,
    value: PinnedHardwareConcurrencyWorker
  });
}

export const defaultRuntimeHardwareConcurrencyPin = {
  hardwareConcurrency: DEFAULT_RUNTIME_HARDWARE_CONCURRENCY,
  runtimeHostWorkerName: RUNTIME_HOST_WORKER_NAME
} as const;

import type { Page } from '@playwright/test';
import {
  disposeRuntimeHostWorkerHook,
  installRuntimeHostWorkerHook
} from './runtime-host-worker-hook';

type FaultInjectionGlobal = typeof globalThis & {
  /** Resolves once the fault is armed; a spawn the page awaits next takes the faulting worker. */
  __armNextMimicExecutionWorkerFault?: () => Promise<void>;
  __postToMimicRuntimeHostWorker?: (message: unknown) => Promise<void>;
};

const ARM_MESSAGE = 'mimic:arm-execution-worker-fault';

/**
 * Lets a test replace the Execution Context worker of the next process the
 * Runtime Host starts with `workerSource`. The page arms the fault with
 * `__armNextMimicExecutionWorkerFault()` before the spawn it
 * targets. The Runtime Host keeps a process worker ahead of demand
 * (ADR-0031); arming fails that spare, so that the spawn creates the faulting
 * worker instead of taking a healthy one.
 */
export async function installExecutionWorkerFault(
  page: Page,
  workerSource: string
): Promise<void> {
  await installRuntimeHostWorkerHook(
    page,
    [
      `const faultUrl = URL.createObjectURL(new Blob([${JSON.stringify(workerSource)}], { type: 'text/javascript' }));`,
      'const NativeWorker = globalThis.Worker;',
      'const spares = new Set();',
      'let armed = false;',
      'self.addEventListener("message", (event) => {',
      `  if (event.data?.type !== ${JSON.stringify(ARM_MESSAGE)}) return;`,
      '  armed = true;',
      '  for (const spare of spares) {',
      '    spares.delete(spare);',
      '    spare.terminate();',
      "    spare.dispatchEvent(new ErrorEvent('error', { message: 'execution worker fault armed', cancelable: true }));",
      '  }',
      '});',
      'globalThis.Worker = class extends NativeWorker {',
      '  constructor(scriptURL, options) {',
      "    const isProcessWorker = String(scriptURL).includes('node-process-worker');",
      '    const shouldFault = armed && isProcessWorker;',
      '    if (shouldFault) armed = false;',
      '    super(shouldFault ? faultUrl : scriptURL, options);',
      '    if (!isProcessWorker || shouldFault) return;',
      '    // A process worker nothing has been posted to yet is a spare.',
      '    spares.add(this);',
      '    const post = this.postMessage.bind(this);',
      '    this.postMessage = (...args) => {',
      '      spares.delete(this);',
      '      return post(...args);',
      '    };',
      '  }',
      '};'
    ].join('\n')
  );
  await page.evaluate((type) => {
    const target = globalThis as FaultInjectionGlobal;
    target.__armNextMimicExecutionWorkerFault = () =>
      target.__postToMimicRuntimeHostWorker?.({ type }) ?? Promise.resolve();
  }, ARM_MESSAGE);
}

export async function disposeExecutionWorkerFault(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete (globalThis as FaultInjectionGlobal)
      .__armNextMimicExecutionWorkerFault;
  });
  await disposeRuntimeHostWorkerHook(page);
}

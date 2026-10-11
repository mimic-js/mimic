import { afterEach, describe, expect, test } from 'vitest';

import { installCallSiteFileNames } from '../../src/runtime/modules/node-compatibility/call-sites';
import { hideBrowserWorkerGlobals } from '../../src/runtime/modules/node-compatibility/perf-hooks';

const NAMES = ['requestAnimationFrame', 'cancelAnimationFrame', 'WorkerGlobalScope', 'DedicatedWorkerGlobalScope', 'importScripts'];

describe('process worker global', () => {
  afterEach(() => {
    for (const name of NAMES) delete (globalThis as Record<string, unknown>)[name];
  });

  test('hides the browser-only names from code that reads the real global, and lets a program define them', () => {
    const host = globalThis as Record<string, unknown>;
    host.requestAnimationFrame = () => 1;
    host.WorkerGlobalScope = class {};

    hideBrowserWorkerGlobals();

    // As code a dev server's module runner evaluates through Function sees it.
    const seen = new Function('return [typeof requestAnimationFrame, typeof WorkerGlobalScope, typeof importScripts]')();
    expect(seen).toEqual(['undefined', 'undefined', 'undefined']);
    host.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 16);
    expect(typeof new Function('return requestAnimationFrame')()).toBe('function');
  });
});

describe('stack frames of compiled modules', () => {
  test('name the file their source names to a program reading its callers, as pino and ember-cli do', () => {
    const saved = Object.getOwnPropertyDescriptor(Error, 'prepareStackTrace');
    try {
      installCallSiteFileNames();
      const callers = (0, eval)(
        [
          '(function getCallers() {',
          '  const original = Error.prepareStackTrace;',
          '  Error.prepareStackTrace = (_error, frames) => frames;',
          '  const frames = new Error().stack;',
          '  Error.prepareStackTrace = original;',
          '  return { file: frames[0].getFileName(), line: frames[0].getLineNumber(), text: String(frames[0]), restored: Error.prepareStackTrace === original };',
          '})',
          '//# sourceURL=/home/project/node_modules/pino/lib/caller.js'
        ].join('\n')
      ) as () => { file: string; line: number; text: string; restored: boolean };

      expect(callers()).toEqual({
        file: '/home/project/node_modules/pino/lib/caller.js',
        line: 4,
        text: expect.stringContaining('caller.js:4'),
        restored: true
      });
      expect(typeof new Error().stack).toBe('string');
    } finally {
      if (saved) Object.defineProperty(Error, 'prepareStackTrace', saved);
      else delete (Error as { prepareStackTrace?: unknown }).prepareStackTrace;
    }
  });
});

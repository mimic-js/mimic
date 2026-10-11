import { afterEach, describe, expect, test, vi } from 'vitest';

import { installPublishedEndpointDocumentNavigationProgram } from './document-navigation-program';

const endpoint = '/assets/__mimic__/epoch/epoch%3Aroute-1/5173';
const origin = 'http://127.0.0.1:4173';

/** Installs the program in a window served at `path`, whose workers record their script URL. */
function documentAt(path: string) {
  class RecordingWorker {
    readonly scriptUrl: string;
    constructor(scriptUrl: string | URL, readonly options?: WorkerOptions) {
      this.scriptUrl = String(scriptUrl);
    }
  }
  const documentWindow = {
    location: new URL(`${origin}${path}`),
    addEventListener() {},
    Worker: RecordingWorker,
    SharedWorker: RecordingWorker
  };
  vi.stubGlobal('window', documentWindow);
  vi.stubGlobal('document', { baseURI: `${origin}${path}` });
  installPublishedEndpointDocumentNavigationProgram();
  return documentWindow as unknown as {
    Worker: new (scriptUrl: string | URL, options?: WorkerOptions) => RecordingWorker;
    SharedWorker: new (scriptUrl: string | URL, options?: WorkerOptions) => RecordingWorker;
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Published Endpoint document navigation program', () => {
  test('starts a worker named by a root-relative URL from the same path under the endpoint', () => {
    const documentWindow = documentAt(`${endpoint}/`);
    const worker = new documentWindow.Worker('/node_modules/binding/wasi-worker-browser.mjs?worker_file&type=module', {
      type: 'module'
    });
    const shared = new documentWindow.SharedWorker(new URL(`${origin}/shared.js`));

    expect(worker.scriptUrl).toBe(`${endpoint}/node_modules/binding/wasi-worker-browser.mjs?worker_file&type=module`);
    expect(worker.options).toEqual({ type: 'module' });
    expect(shared.scriptUrl).toBe(`${endpoint}/shared.js`);
    expect(worker).toBeInstanceOf(documentWindow.Worker);
  });

  test('leaves a worker already on the endpoint, on another origin or from a blob alone', () => {
    const documentWindow = documentAt(`${endpoint}/nested/page`);

    expect(new documentWindow.Worker('worker.js').scriptUrl).toBe('worker.js');
    expect(new documentWindow.Worker('https://cdn.example/worker.js').scriptUrl).toBe('https://cdn.example/worker.js');
    expect(new documentWindow.Worker('blob:http://127.0.0.1:4173/id').scriptUrl).toBe('blob:http://127.0.0.1:4173/id');
  });

  test('leaves workers alone in a document that is not served under an endpoint path', () => {
    const documentWindow = documentAt('/');

    expect(new documentWindow.Worker('/worker.js').scriptUrl).toBe('/worker.js');
  });
});

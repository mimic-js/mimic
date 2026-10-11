import type { FrameLocator, Page } from '@playwright/test';

import { eventually, expect, styleOf, textOf, type Stack, type StackServer } from './stack-scenario';

type SocketProbe = {
  id: string;
  url: string;
  messages: string[];
  closed: boolean;
  closeCode?: number;
};

type DocumentProbe = {
  documentId: string;
  sockets: SocketProbe[];
};

type ProbeWindow = typeof globalThis & {
  __viteWorkflowProbe?: DocumentProbe;
  __viteWorkflowRegistry?: { documents: Record<string, DocumentProbe> };
};

/**
 * What a case says about its development workflow. Its application follows the
 * suite's conventions: it styles `.workflow-card` from `src/workflow.css`, red
 * at first, and counts from 0 to 1 when its trigger is clicked.
 */
export type ViteDevelopmentWorkflow = Readonly<{
  /** The file whose heading the workflow rewrites, relative to the working directory. */
  appPath: string;
  sourceHeading: string;
  recoveredHeading: string;
  applicationState: Readonly<{
    triggerSelector: string;
    valueSelector: string;
    /** Whether a source update keeps the state the application already has, or starts it again. */
    sourceUpdateState: 'initialize-after-update' | 'preserve-existing';
  }>;
  /** The file the transform error is written to and recovered in, when it is not `appPath`. */
  transformErrorPath?: string;
  transformErrorSource: string;
  /** What recovers `transformErrorPath`, when it is not `appPath` with the recovered heading. */
  recoveredSource?: string;
  transformErrorDocument?: 'preserve' | 'replace';
  transformErrorReloadPaths?: readonly string[];
  transformErrorHttpResponse?: 'required' | 'absent';
}>;

const stylePath = 'src/workflow.css';
const updatedStyle = '.workflow-card { color: rgb(0, 128, 0); }';

/**
 * Records, in every document the page loads from now on, the WebSockets the
 * document opens and the type of each Vite payload they receive. The test page
 * keeps the record of a document after the document is gone.
 */
export async function installViteDevelopmentWorkflowProbe(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const workflowWindow = globalThis as ProbeWindow;
    const probe: DocumentProbe = {
      documentId: crypto.randomUUID(),
      sockets: []
    };
    workflowWindow.__viteWorkflowProbe = probe;
    const registryWindow = globalThis.top as unknown as ProbeWindow;
    const registry = registryWindow.__viteWorkflowRegistry ?? { documents: {} };
    registryWindow.__viteWorkflowRegistry = registry;
    registry.documents[probe.documentId] = probe;

    const observeConstructor = (Constructor: typeof WebSocket): typeof WebSocket =>
      new Proxy(Constructor, {
        construct(target, args) {
          const socket = Reflect.construct(target, args, target) as WebSocket;
          const socketProbe: SocketProbe = {
            id: crypto.randomUUID(),
            url: String(args[0]),
            messages: [],
            closed: false
          };
          probe.sockets.push(socketProbe);
          socket.addEventListener('message', (event) => {
            if (typeof event.data !== 'string') return;
            try {
              const payload: unknown = JSON.parse(event.data);
              if (
                typeof payload === 'object' &&
                payload !== null &&
                'type' in payload &&
                typeof payload.type === 'string'
              ) {
                socketProbe.messages.push(payload.type);
              }
            } catch {
              // Upstream clients may exchange non-JSON frames; they are not Vite payload evidence.
            }
          });
          socket.addEventListener('close', (event) => {
            socketProbe.closed = true;
            socketProbe.closeCode = event.code;
          });
          return socket;
        }
      });

    let observedWebSocket = observeConstructor(globalThis.WebSocket);
    Object.defineProperty(globalThis, 'WebSocket', {
      configurable: true,
      enumerable: true,
      get: () => observedWebSocket,
      set: (next: typeof WebSocket) => {
        observedWebSocket = observeConstructor(next);
      }
    });
  });
}

/**
 * Drives one development session of the application `server` serves in `app`:
 * a source update, a CSS update, a transform error, its recovery and a hard
 * reload, all through the socket of Vite's own client, then stops the server
 * and proves the client saw the socket close.
 */
export async function runViteDevelopmentWorkflow(
  stack: Stack,
  server: StackServer,
  app: FrameLocator,
  scenario: Readonly<{ expectedHeading: string; resourcePath: string }>,
  workflow: ViteDevelopmentWorkflow
): Promise<void> {
  const { page } = stack;
  const heading = app.locator('h1');
  const card = app.locator('.workflow-card');
  const state = app.locator(workflow.applicationState.valueSelector);
  const keepsState = workflow.applicationState.sourceUpdateState === 'preserve-existing';
  const replacesDocument = workflow.transformErrorDocument === 'replace';
  const source = await stack.readFile(workflow.appPath);
  const increment = async (): Promise<void> => {
    await app.locator(workflow.applicationState.triggerSelector).click();
    await eventually(() => textOf(state)).toBe('1');
  };
  const endpointEvents = await stack.endpointEvents();

  const initial = await connectedDocument(page, app);
  const initialSocket = (): Promise<SocketProbe> => socketOf(page, initial.documentId, initial.socket.id);
  const updates = async (): Promise<number> =>
    (await initialSocket()).messages.filter((message) => message === 'update').length;
  await eventually(() => styleOf(card, 'color')).toBe('rgb(179, 0, 0)');
  await eventually(() => textOf(state)).toBe('0');
  if (keepsState) await increment();

  // A source update reaches the document that is already open.
  await stack.writeFile(workflow.appPath, withHeading(source, scenario.expectedHeading, workflow.sourceHeading));
  await eventually(() => textOf(heading)).toBe(workflow.sourceHeading);
  await eventually(() => textOf(state)).toBe(keepsState ? '1' : '0');
  await eventually(updates).toBeGreaterThanOrEqual(1);
  expect(await currentDocument(app)).toBe(initial.documentId);
  if (!keepsState) await increment();

  // So does a CSS update, and it keeps the state.
  await stack.writeFile(stylePath, updatedStyle);
  await eventually(() => styleOf(card, 'color')).toBe('rgb(0, 128, 0)');
  await eventually(() => textOf(state)).toBe('1');
  await eventually(updates).toBeGreaterThanOrEqual(2);
  expect(await currentDocument(app)).toBe(initial.documentId);

  // A transform error arrives over the same socket and shows Vite's overlay.
  const errorPath = workflow.transformErrorPath ?? workflow.appPath;
  await stack.writeFile(errorPath, workflow.transformErrorSource);
  await eventually(() => overlayText(app)).toContain(scenario.resourcePath);
  await eventually(async () => (await initialSocket()).messages).toEqual(
    expect.arrayContaining(['connected', 'update', 'error'])
  );
  await eventually(async () => {
    const current = await currentDocument(app);
    return current !== undefined && (current !== initial.documentId) === replacesDocument;
  }, replacesDocument ? 'the transform error did not replace the document' : 'the transform error replaced the document').toBe(
    true
  );

  // The recovery clears the overlay, in the same document unless the error replaced it.
  await stack.writeFile(
    errorPath,
    workflow.recoveredSource ?? withHeading(source, scenario.expectedHeading, workflow.recoveredHeading)
  );
  await eventually(() => app.locator('vite-error-overlay').count().catch(() => undefined)).toBe(0);
  await eventually(() => textOf(heading)).toBe(workflow.recoveredHeading);
  const recovered = await connectedDocument(page, app);
  const session = replacesDocument ? recovered.socket : await initialSocket();
  expect(session.closed).toBe(false);
  if (replacesDocument) {
    expect(recovered.documentId).not.toBe(initial.documentId);
    expect(session.id).not.toBe(initial.socket.id);
  } else {
    expect(recovered.documentId).toBe(initial.documentId);
    expect(session.messages).toEqual(expect.arrayContaining(['connected', 'update', 'error']));
    expect(await updates()).toBeGreaterThanOrEqual(2);
  }
  const sessionUrl = new URL(session.url);
  expect(sessionUrl.pathname).toBe('/');
  expect(sessionUrl.searchParams.has('token')).toBe(true);

  // All of it ran in one server process, on the endpoint the preview was opened at.
  expect(await stack.endpointEvents()).toEqual(endpointEvents);
  await expect(page.locator('iframe[data-stack-preview]')).toHaveAttribute('src', server.url);

  // A hard reload loads a new document that connects again.
  await app
    .locator('html')
    .evaluate(() => location.reload())
    .catch(() => undefined);
  const reloaded = await connectedDocument(page, app, recovered.documentId);
  await eventually(() => textOf(heading)).toBe(workflow.recoveredHeading);

  // The client watches the server go: its socket closes.
  expect(await server.stop('SIGTERM', { keepPreview: true })).toBe(143);
  await eventually(async () => (await socketOf(page, reloaded.documentId, reloaded.socket.id)).closed).toBe(true);
  await page.locator('iframe[data-stack-preview]').evaluate((preview) => preview.remove());
}

/** The application's file with its heading replaced. */
export function withHeading(source: string, heading: string, replacement: string): string {
  expect(source.split(heading), `the application names its heading "${heading}" other than once`).toHaveLength(2);
  return source.replace(heading, replacement);
}

/** The document the frame shows now, or undefined while it loads one. */
function currentDocument(app: FrameLocator): Promise<string | undefined> {
  return app
    .locator('html')
    .evaluate(() => (globalThis as ProbeWindow).__viteWorkflowProbe?.documentId)
    .catch(() => undefined);
}

function documents(page: Page): Promise<Record<string, DocumentProbe>> {
  return page.evaluate(() => (globalThis as ProbeWindow).__viteWorkflowRegistry?.documents ?? {});
}

async function socketOf(page: Page, documentId: string, socketId: string): Promise<SocketProbe> {
  const socket = (await documents(page))[documentId]?.sockets.find((candidate) => candidate.id === socketId);
  if (socket === undefined) throw new Error(`The socket ${socketId} of the document ${documentId} was not recorded`);
  return socket;
}

/** Waits for the frame to show a document other than `previous` whose Vite client is connected. */
async function connectedDocument(
  page: Page,
  app: FrameLocator,
  previous?: string
): Promise<Readonly<{ documentId: string; socket: SocketProbe }>> {
  let connected: { documentId: string; socket: SocketProbe } | undefined;
  await eventually(async () => {
    const documentId = await currentDocument(app);
    if (documentId === undefined || documentId === previous) return false;
    const socket = (await documents(page))[documentId]?.sockets.find((candidate) =>
      candidate.messages.includes('connected')
    );
    connected = socket && { documentId, socket };
    return socket !== undefined;
  }, "Vite's client did not connect").toBe(true);
  if (connected === undefined) throw new Error("Vite's client did not connect");
  return connected;
}

function overlayText(app: FrameLocator): Promise<string> {
  return app
    .locator('vite-error-overlay')
    .evaluate((overlay) => (overlay.shadowRoot?.textContent ?? overlay.textContent ?? '').trim(), undefined, {
      timeout: 1_000
    })
    .catch(() => '');
}

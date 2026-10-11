import { defineCompatibilityClaim } from './compatibility-claim';
import { test } from './compatibility-test';

const publishedEndpointWebSocketClaim = defineCompatibilityClaim({
  id: 'published-endpoint-websocket-publication-v1',
  statement:
    'Mimic routes document WebSockets through revisioned Published Endpoint routes and Virtual Network',
  target: {
    kind: 'runtime-capability',
    capability: 'published-endpoint-websocket-publication'
  }
});

test(publishedEndpointWebSocketClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
const consoleErrors: string[] = [];
const pageErrors: string[] = [];
const badResponses: string[] = [];
const failedRequests: string[] = [];

  page.on('console', (message) => {
    if (message.text().startsWith('Failed to load resource:')) return;
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('requestfailed', (request) => failedRequests.push(`${request.failure()?.errorText ?? 'failed'} ${request.url()}`));
  page.on('response', (response) => {
    if (response.status() >= 400 && !response.url().endsWith('/favicon.ico')) {
      badResponses.push(`${response.status()} ${response.statusText()} ${response.url()}`);
    }
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 10_000 });

  const result = await page.evaluate(async ({ serverSource }) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/published-endpoint-websocket' });
    const outputChunks: string[] = [];
    const decoder = new TextDecoder();
    let process: import('/src/runtime/index.ts').MimicProcess | undefined;
    try {
      await runtime.fs.mount({
        'server.mjs': {
          file: {
            contents: serverSource
          }
        }
      });
      const ready = new Promise<string>((resolve) => {
        const current = runtime.endpoints.current[0];
        if (current) {
          resolve(current.url);
          return;
        }
        const unsubscribe = runtime.endpoints.on('published', ({ url }) => {
          unsubscribe();
          resolve(url);
        });
      });
      process = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`], { cwd: runtime.workdir });
      const outputDone = (async () => {
        const reader = process!.output.getReader();
        while (true) {
          const { value, done } = await reader.read();
          if (done) return;
          outputChunks.push(decoder.decode(value));
        }
      })();
      void outputDone.catch((error) => outputChunks.push(error instanceof Error ? error.stack ?? error.message : String(error)));
      const endpointUrl = await timeout(
        ready,
        15_000,
        () => `published endpoint\nprocess output:\n${outputChunks.join('')}`
      );
      const resultPromise = new Promise<{
        protocol: string;
        preOpenProtocol: string;
        openProtocol: string;
        messages: string[];
        binaryMessages: string[];
        blobMessages: string[];
        closeEvents: string[];
        sharedListenerEvents: string[];
        closeValidationEvents: string[];
        missingCloseCodeEvents: string[];
        fragmentedMessages: string[];
        protocolValidationEvents: string[];
        rejectedUpgradeEvents: string[];
        mismatchedProtocolEvents: string[];
        fallbackProtocolEvents: string[];
        emptyCloseEvents: string[];
        invalidCloseEvents: string[];
        malformedCloseEvents: string[];
        invalidCloseReasonEvents: string[];
        maskedServerFrameEvents: string[];
        invalidUtf8TextEvents: string[];
        reservedOpcodeEvents: string[];
        serverPingEvents: string[];
        fragmentedPingEvents: string[];
        clientEmptyCloseEvents: string[];
        connectingCloseEvents: string[];
        bufferedAmountEvents: string[];
        sendLifecycleEvents: string[];
        heading: string;
        close?: string;
      }>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for published endpoint WebSocket result\nprocess output:\n${outputChunks.join('')}\niframe html:\n${iframe.contentDocument?.documentElement.outerHTML ?? '<unavailable>'}`
            )
          );
        }, 10_000);
        window.addEventListener('message', (event) => {
          if (event.origin !== window.location.origin || event.data?.type !== 'published-endpoint-websocket-result') return;
          window.clearTimeout(timer);
          resolve(event.data);
        });
      });
      const iframe = document.createElement('iframe');
      iframe.title = 'Published Endpoint WebSocket smoke';
      iframe.src = endpointUrl;
      document.body.appendChild(iframe);
      const result = await resultPromise;
      await waitForOutput(outputChunks, 'generic-frame endpoint-client', 5_000);
      await waitForOutput(outputChunks, 'invalid-utf8-close 1007 Invalid WebSocket text frame UTF-8', 5_000);
      const outputText = await waitForOutput(outputChunks, 'invalid-close-reason-close 1007 Invalid WebSocket close reason UTF-8', 5_000);
      await waitForOutput(outputChunks, 'reserved-opcode-close 1002 Reserved WebSocket opcode 3', 5_000);
      await waitForOutput(outputChunks, 'client-empty-close-frame 1005 0', 5_000);
      process.kill('SIGTERM');
      const exitCode = await process.exit.catch(() => 1);
      return { result, endpointUrl, outputText, exitCode };
    } finally {
      process?.kill('SIGKILL');
      await runtime.teardown();
    }

    function timeout<T>(promise: Promise<T>, ms: number, label: string | (() => string)): Promise<T> {
      return new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error(`timed out waiting for ${typeof label === 'function' ? label() : label}`)), ms);
        promise.then(
          (value) => {
            window.clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            window.clearTimeout(timer);
            reject(error);
          }
        );
      });
    }

    async function waitForOutput(chunks: string[], expected: string, ms: number): Promise<string> {
      const startedAt = Date.now();
      while (Date.now() - startedAt < ms) {
        const output = chunks.join('');
        if (output.includes(expected)) return output;
        await new Promise((resolve) => window.setTimeout(resolve, 50));
      }
      throw new Error(`timed out waiting for process output "${expected}":\n${chunks.join('')}`);
    }
  }, { serverSource: genericWebSocketServerSource() });

  const resultMessages = result.result.messages.join('|');
  const diagnostics = result.outputText;
  if (result.exitCode !== 143) {
    throw new Error(`published endpoint WebSocket server did not preserve SIGTERM exit status: ${result.exitCode}`);
  }
  if (result.result.protocol !== 'published-endpoint') {
    throw new Error(`published endpoint WebSocket did not preserve the requested protocol: ${JSON.stringify(result.result)}`);
  }
  if (result.result.preOpenProtocol !== '' || result.result.openProtocol !== 'published-endpoint') {
    throw new Error(`published endpoint WebSocket did not expose protocol according to handshake timing: ${JSON.stringify(result.result)}`);
  }
  if (!resultMessages.includes('server-ready:/echo?kind=generic') || !resultMessages.includes('echo:endpoint-client')) {
    throw new Error(`published endpoint WebSocket did not preserve server/client text frames: ${JSON.stringify(result.result)}`);
  }
  if (result.result.binaryMessages.join('|') !== '21,13,8,5') {
    throw new Error(`published endpoint WebSocket did not preserve binary frames as ArrayBuffer payloads: ${JSON.stringify(result.result)}`);
  }
  if (result.result.blobMessages.join('|') !== '3,7,31') {
    throw new Error(`published endpoint WebSocket did not preserve Blob send/default receive semantics: ${JSON.stringify(result.result)}`);
  }
  if (result.result.closeEvents.join('|') !== '1000:done:true') {
    throw new Error(`published endpoint WebSocket did not dispatch exactly one clean server close event: ${JSON.stringify(result.result)}`);
  }
  if (result.result.sharedListenerEvents.join('|') !== 'message:server-ready:/echo?kind=generic|close:1000:done:true') {
    throw new Error(`published endpoint WebSocket did not remove shared event listeners by event type: ${JSON.stringify(result.result)}`);
  }
  if (result.result.closeValidationEvents.join('|') !== 'invalid-code:InvalidAccessError|long-reason:SyntaxError|state-after-invalid:1') {
    throw new Error(`published endpoint WebSocket did not validate close(code, reason) like a browser WebSocket: ${JSON.stringify(result.result)}`);
  }
  if (result.result.missingCloseCodeEvents.join('|') !== 'open:published-endpoint|missing-code:SyntaxError:1|close:1000:missing-code-complete:true:3') {
    throw new Error(`published endpoint WebSocket did not require close code when a close reason is provided: ${JSON.stringify(result.result)}`);
  }
  if (result.result.fragmentedMessages.join('|') !== 'open:published-endpoint|message:fragmented:split-message|close:1000:fragmented-complete:true:3') {
    throw new Error(`published endpoint WebSocket did not reassemble fragmented server text messages: ${JSON.stringify(result.result)}`);
  }
  if (result.result.protocolValidationEvents.join('|') !== 'duplicate:SyntaxError|invalid-token:SyntaxError|empty:SyntaxError') {
    throw new Error(`published endpoint WebSocket did not validate constructor protocols like a browser WebSocket: ${JSON.stringify(result.result)}`);
  }
  if (result.result.rejectedUpgradeEvents.join('|') !== 'error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not expose rejected upgrades like a browser WebSocket: ${JSON.stringify(result.result)}`);
  }
  if (result.result.mismatchedProtocolEvents.join('|') !== 'error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject mismatched accepted protocols like a browser WebSocket: ${JSON.stringify(result.result)}`);
  }
  if (
    result.result.fallbackProtocolEvents.join('|') !==
    'open:fallback-endpoint|message:{"type":"custom","event":"fallback-protocol"}|close:1000:fallback-complete:true:3'
  ) {
    throw new Error(`published endpoint WebSocket did not preserve all requested protocol offers: ${JSON.stringify(result.result)}`);
  }
  if (result.result.emptyCloseEvents.join('|') !== 'open:published-endpoint|close:1005::true:3') {
    throw new Error(`published endpoint WebSocket did not preserve empty server close frame semantics: ${JSON.stringify(result.result)}`);
  }
  if (result.result.invalidCloseEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject invalid server close frame status codes: ${JSON.stringify(result.result)}`);
  }
  if (result.result.malformedCloseEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject malformed one-byte server close frames: ${JSON.stringify(result.result)}`);
  }
  if (result.result.invalidCloseReasonEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject invalid UTF-8 server close reasons: ${JSON.stringify(result.result)}`);
  }
  if (result.result.maskedServerFrameEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject masked server frames: ${JSON.stringify(result.result)}`);
  }
  if (result.result.invalidUtf8TextEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject invalid UTF-8 server text frames: ${JSON.stringify(result.result)}`);
  }
  if (result.result.reservedOpcodeEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject reserved server opcodes: ${JSON.stringify(result.result)}`);
  }
  if (result.result.serverPingEvents.join('|') !== 'open:published-endpoint|message:ping-complete|close:1000:server-ping-complete:true:3') {
    throw new Error(`published endpoint WebSocket did not respond to server ping control frames without exposing them to user code: ${JSON.stringify(result.result)}`);
  }
  if (result.result.fragmentedPingEvents.join('|') !== 'open:published-endpoint|error|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not reject fragmented server ping control frames: ${JSON.stringify(result.result)}`);
  }
  if (result.result.clientEmptyCloseEvents.join('|') !== 'open:published-endpoint|close:1005::true:3') {
    throw new Error(`published endpoint WebSocket did not preserve close() without code as an empty close frame: ${JSON.stringify(result.result)}`);
  }
  if (result.result.connectingCloseEvents.join('|') !== 'before-close:0|after-close:2|error:3|close:1006::false:3') {
    throw new Error(`published endpoint WebSocket did not preserve close() during CONNECTING semantics: ${JSON.stringify(result.result)}`);
  }
  if (!result.result.bufferedAmountEvents.includes('before:0')) {
    throw new Error(`published endpoint WebSocket did not start with empty bufferedAmount: ${JSON.stringify(result.result)}`);
  }
  if (result.result.bufferedAmountEvents.join('|') !== 'before:0|after-send:15|after-send:19|after-close:0') {
    throw new Error(`published endpoint WebSocket did not expose queued payload bytes through bufferedAmount: ${JSON.stringify(result.result)}`);
  }
  if (result.result.sendLifecycleEvents.join('|') !== 'connecting:InvalidStateError|closing:ok:2:0|closed:ok:3:0') {
    throw new Error(`published endpoint WebSocket did not preserve send() lifecycle semantics: ${JSON.stringify(result.result)}`);
  }
  if (!result.result.heading.includes('Published Endpoint WebSocket works')) {
    throw new Error(`published endpoint WebSocket did not update the iframe DOM: ${JSON.stringify(result.result)}`);
  }
  if (
    !diagnostics.includes('generic-upgrade /echo?kind=generic published-endpoint') ||
    !diagnostics.includes('generic-upgrade /blob?kind=generic published-endpoint') ||
    !diagnostics.includes('generic-upgrade /fallback-protocol?kind=generic published-endpoint, fallback-endpoint') ||
    !diagnostics.includes('generic-frame endpoint-client') ||
    !diagnostics.includes('generic-binary 5,8,13,21') ||
    !diagnostics.includes('generic-binary 31,7,3') ||
    !diagnostics.includes('invalid-utf8-close 1007 Invalid WebSocket text frame UTF-8') ||
    !diagnostics.includes('invalid-close-reason-close 1007 Invalid WebSocket close reason UTF-8') ||
    !diagnostics.includes('reserved-opcode-close 1002 Reserved WebSocket opcode 3') ||
    !diagnostics.includes('server-pong server-ping') ||
    !diagnostics.includes('client-empty-close-frame 1005 0')
  ) {
    throw new Error(`published endpoint WebSocket did not route through the virtual socket session:\n${diagnostics}`);
  }
  for (const forbidden of ['hmr-broker', 'legacy-hmr-broadcast', 'mimic:hmr-client-message', 'mimic:hmr-payload']) {
    if (diagnostics.includes(forbidden)) {
      throw new Error(`published endpoint WebSocket smoke hit forbidden fallback "${forbidden}":\n${diagnostics}`);
    }
  }
  if (badResponses.length > 0 || failedRequests.length > 0 || consoleErrors.length > 0 || pageErrors.length > 0) {
    throw new Error(
      `published endpoint WebSocket smoke emitted browser errors:\n${[...badResponses, ...failedRequests, ...consoleErrors, ...pageErrors].join('\n')}`
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        endpointUrl: result.endpointUrl,
        protocol: result.result.protocol,
        preOpenProtocol: result.result.preOpenProtocol,
        openProtocol: result.result.openProtocol,
        messages: result.result.messages,
        binaryMessages: result.result.binaryMessages,
        blobMessages: result.result.blobMessages,
        closeEvents: result.result.closeEvents,
        sharedListenerEvents: result.result.sharedListenerEvents,
        closeValidationEvents: result.result.closeValidationEvents,
        missingCloseCodeEvents: result.result.missingCloseCodeEvents,
        fragmentedMessages: result.result.fragmentedMessages,
        protocolValidationEvents: result.result.protocolValidationEvents,
        rejectedUpgradeEvents: result.result.rejectedUpgradeEvents,
        mismatchedProtocolEvents: result.result.mismatchedProtocolEvents,
        fallbackProtocolEvents: result.result.fallbackProtocolEvents,
        emptyCloseEvents: result.result.emptyCloseEvents,
        invalidCloseEvents: result.result.invalidCloseEvents,
        malformedCloseEvents: result.result.malformedCloseEvents,
        invalidCloseReasonEvents: result.result.invalidCloseReasonEvents,
        maskedServerFrameEvents: result.result.maskedServerFrameEvents,
        invalidUtf8TextEvents: result.result.invalidUtf8TextEvents,
        reservedOpcodeEvents: result.result.reservedOpcodeEvents,
        serverPingEvents: result.result.serverPingEvents,
        fragmentedPingEvents: result.result.fragmentedPingEvents,
        clientEmptyCloseEvents: result.result.clientEmptyCloseEvents,
        connectingCloseEvents: result.result.connectingCloseEvents,
        bufferedAmountEvents: result.result.bufferedAmountEvents,
        sendLifecycleEvents: result.result.sendLifecycleEvents,
        publishedEndpointWebSocketUsesVirtualSocket: true
      },
      null,
      2
    )
  );
function genericWebSocketServerSource(): string {
  return `
import http from 'http';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const server = http.createServer((request, response) => {
  if (request.url === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(\`<!doctype html>
<html>
  <body>
    <h1 id="status">Published Endpoint WebSocket connecting</h1>
    <script>
      const status = document.getElementById('status');
      const target = new URL('/echo?kind=generic', location.href);
      target.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const messages = [];
      const binaryMessages = [];
      const blobMessages = [];
      const closeEvents = [];
      const sharedListenerEvents = [];
      const closeValidationEvents = [];
      const missingCloseCodeEvents = [];
      const fragmentedMessages = [];
      const protocolValidationEvents = [];
      const rejectedUpgradeEvents = [];
      const mismatchedProtocolEvents = [];
      const fallbackProtocolEvents = [];
      const emptyCloseEvents = [];
      const invalidCloseEvents = [];
      const malformedCloseEvents = [];
      const invalidCloseReasonEvents = [];
      const maskedServerFrameEvents = [];
      const invalidUtf8TextEvents = [];
      const reservedOpcodeEvents = [];
      const serverPingEvents = [];
      const fragmentedPingEvents = [];
      const clientEmptyCloseEvents = [];
      const connectingCloseEvents = [];
      const bufferedAmountEvents = [];
      const sendLifecycleEvents = [];
      const recordProtocolValidation = (label, protocols) => {
        try {
          new WebSocket(target.href, protocols);
          protocolValidationEvents.push(label + ':not-thrown');
        } catch (error) {
          protocolValidationEvents.push(label + ':' + error.name);
        }
      };
      recordProtocolValidation('duplicate', ['published-endpoint', 'published-endpoint']);
      recordProtocolValidation('invalid-token', ['bad protocol']);
      recordProtocolValidation('empty', ['']);
      const socket = new WebSocket(target.href, ['published-endpoint', 'fallback-endpoint']);
      const preOpenProtocol = socket.protocol;
      try {
        socket.send('before-open');
        sendLifecycleEvents.push('connecting:not-thrown');
      } catch (error) {
        sendLifecycleEvents.push('connecting:' + error.name);
      }
      let openProtocol = '';
      socket.binaryType = 'arraybuffer';
      const sharedListener = (event) => {
        if (event.type === 'message') {
          sharedListenerEvents.push('message:' + String(event.data));
          socket.removeEventListener('message', sharedListener);
        } else if (event.type === 'close') {
          sharedListenerEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean);
        }
      };
      socket.addEventListener('message', sharedListener);
      socket.addEventListener('close', sharedListener);
      const finish = () => {
        if (
          !messages.some((message) => message.startsWith('echo:')) ||
          binaryMessages.length === 0 ||
          blobMessages.length === 0 ||
          closeEvents.length === 0 ||
          sharedListenerEvents.length < 2 ||
          closeValidationEvents.length < 3 ||
          missingCloseCodeEvents.length < 3 ||
          fragmentedMessages.length < 3 ||
          protocolValidationEvents.length < 3 ||
          rejectedUpgradeEvents.length < 2 ||
          mismatchedProtocolEvents.length < 2 ||
          fallbackProtocolEvents.length < 2 ||
          emptyCloseEvents.length < 2 ||
          invalidCloseEvents.length < 2 ||
          malformedCloseEvents.length < 2 ||
          invalidCloseReasonEvents.length < 2 ||
          maskedServerFrameEvents.length < 2 ||
          invalidUtf8TextEvents.length < 2 ||
          reservedOpcodeEvents.length < 2 ||
          serverPingEvents.length < 3 ||
          fragmentedPingEvents.length < 2 ||
          clientEmptyCloseEvents.length < 2 ||
          connectingCloseEvents.length < 4 ||
          !bufferedAmountEvents.includes('after-close:0') ||
          sendLifecycleEvents.length < 3
        ) return;
        status.textContent = 'Published Endpoint WebSocket works: ' + messages.find((message) => message.startsWith('echo:'));
        window.parent.postMessage({
          type: 'published-endpoint-websocket-result',
          protocol: socket.protocol,
          preOpenProtocol,
          openProtocol,
          messages,
          binaryMessages,
          blobMessages,
          closeEvents,
          sharedListenerEvents,
          closeValidationEvents,
          missingCloseCodeEvents,
          fragmentedMessages,
          protocolValidationEvents,
          rejectedUpgradeEvents,
          mismatchedProtocolEvents,
          fallbackProtocolEvents,
          emptyCloseEvents,
          invalidCloseEvents,
          malformedCloseEvents,
          invalidCloseReasonEvents,
          maskedServerFrameEvents,
          invalidUtf8TextEvents,
          reservedOpcodeEvents,
          serverPingEvents,
          fragmentedPingEvents,
          clientEmptyCloseEvents,
          connectingCloseEvents,
          bufferedAmountEvents,
          sendLifecycleEvents,
          heading: status.textContent,
          close: status.dataset.close || ''
        }, location.origin);
      };
      const rejectedTarget = new URL('/reject?kind=generic', location.href);
      rejectedTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const rejectedSocket = new WebSocket(rejectedTarget.href, ['published-endpoint']);
      rejectedSocket.addEventListener('open', () => {
        rejectedUpgradeEvents.push('open');
        finish();
      });
      rejectedSocket.addEventListener('error', () => {
        rejectedUpgradeEvents.push('error');
        finish();
      });
      rejectedSocket.addEventListener('close', (event) => {
        rejectedUpgradeEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + rejectedSocket.readyState);
        finish();
      });
      const mismatchedProtocolTarget = new URL('/mismatched-protocol?kind=generic', location.href);
      mismatchedProtocolTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const mismatchedProtocolSocket = new WebSocket(mismatchedProtocolTarget.href, ['published-endpoint']);
      mismatchedProtocolSocket.addEventListener('open', () => {
        mismatchedProtocolEvents.push('open:' + mismatchedProtocolSocket.protocol);
        finish();
      });
      mismatchedProtocolSocket.addEventListener('error', () => {
        mismatchedProtocolEvents.push('error');
        finish();
      });
      mismatchedProtocolSocket.addEventListener('close', (event) => {
        mismatchedProtocolEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + mismatchedProtocolSocket.readyState);
        finish();
      });
      const fallbackProtocolTarget = new URL('/fallback-protocol?kind=generic', location.href);
      fallbackProtocolTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fallbackProtocolSocket = new WebSocket(fallbackProtocolTarget.href, ['published-endpoint', 'fallback-endpoint']);
      fallbackProtocolSocket.addEventListener('open', () => {
        fallbackProtocolEvents.push('open:' + fallbackProtocolSocket.protocol);
      });
      fallbackProtocolSocket.addEventListener('message', (event) => {
        fallbackProtocolEvents.push('message:' + String(event.data));
        fallbackProtocolSocket.close(1000, 'fallback-complete');
        try {
          fallbackProtocolSocket.send('after-client-close');
          sendLifecycleEvents.push('closing:ok:' + fallbackProtocolSocket.readyState + ':' + fallbackProtocolSocket.bufferedAmount);
        } catch (error) {
          sendLifecycleEvents.push('closing:' + error.name);
        }
      });
      fallbackProtocolSocket.addEventListener('error', () => {
        fallbackProtocolEvents.push('error');
        finish();
      });
      fallbackProtocolSocket.addEventListener('close', (event) => {
        fallbackProtocolEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + fallbackProtocolSocket.readyState);
        finish();
      });
      const emptyCloseTarget = new URL('/empty-close?kind=generic', location.href);
      emptyCloseTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const emptyCloseSocket = new WebSocket(emptyCloseTarget.href, ['published-endpoint']);
      emptyCloseSocket.addEventListener('open', () => {
        emptyCloseEvents.push('open:' + emptyCloseSocket.protocol);
        finish();
      });
      emptyCloseSocket.addEventListener('error', () => {
        emptyCloseEvents.push('error');
        finish();
      });
      emptyCloseSocket.addEventListener('close', (event) => {
        emptyCloseEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + emptyCloseSocket.readyState);
        finish();
      });
      const invalidCloseTarget = new URL('/invalid-close?kind=generic', location.href);
      invalidCloseTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const invalidCloseSocket = new WebSocket(invalidCloseTarget.href, ['published-endpoint']);
      invalidCloseSocket.addEventListener('open', () => {
        invalidCloseEvents.push('open:' + invalidCloseSocket.protocol);
        finish();
      });
      invalidCloseSocket.addEventListener('error', () => {
        invalidCloseEvents.push('error');
        finish();
      });
      invalidCloseSocket.addEventListener('close', (event) => {
        invalidCloseEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + invalidCloseSocket.readyState);
        finish();
      });
      const malformedCloseTarget = new URL('/malformed-close?kind=generic', location.href);
      malformedCloseTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const malformedCloseSocket = new WebSocket(malformedCloseTarget.href, ['published-endpoint']);
      malformedCloseSocket.addEventListener('open', () => {
        malformedCloseEvents.push('open:' + malformedCloseSocket.protocol);
        finish();
      });
      malformedCloseSocket.addEventListener('error', () => {
        malformedCloseEvents.push('error');
        finish();
      });
      malformedCloseSocket.addEventListener('close', (event) => {
        malformedCloseEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + malformedCloseSocket.readyState);
        finish();
      });
      const invalidCloseReasonTarget = new URL('/invalid-close-reason?kind=generic', location.href);
      invalidCloseReasonTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const invalidCloseReasonSocket = new WebSocket(invalidCloseReasonTarget.href, ['published-endpoint']);
      invalidCloseReasonSocket.addEventListener('open', () => {
        invalidCloseReasonEvents.push('open:' + invalidCloseReasonSocket.protocol);
        finish();
      });
      invalidCloseReasonSocket.addEventListener('message', (event) => {
        invalidCloseReasonEvents.push('message:' + String(event.data));
        finish();
      });
      invalidCloseReasonSocket.addEventListener('error', () => {
        invalidCloseReasonEvents.push('error');
        finish();
      });
      invalidCloseReasonSocket.addEventListener('close', (event) => {
        invalidCloseReasonEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + invalidCloseReasonSocket.readyState);
        finish();
      });
      const maskedServerFrameTarget = new URL('/masked-server-frame?kind=generic', location.href);
      maskedServerFrameTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const maskedServerFrameSocket = new WebSocket(maskedServerFrameTarget.href, ['published-endpoint']);
      maskedServerFrameSocket.addEventListener('open', () => {
        maskedServerFrameEvents.push('open:' + maskedServerFrameSocket.protocol);
        finish();
      });
      maskedServerFrameSocket.addEventListener('message', (event) => {
        maskedServerFrameEvents.push('message:' + String(event.data));
        finish();
      });
      maskedServerFrameSocket.addEventListener('error', () => {
        maskedServerFrameEvents.push('error');
        finish();
      });
      maskedServerFrameSocket.addEventListener('close', (event) => {
        maskedServerFrameEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + maskedServerFrameSocket.readyState);
        finish();
      });
      const invalidUtf8TextTarget = new URL('/invalid-utf8-text?kind=generic', location.href);
      invalidUtf8TextTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const invalidUtf8TextSocket = new WebSocket(invalidUtf8TextTarget.href, ['published-endpoint']);
      invalidUtf8TextSocket.addEventListener('open', () => {
        invalidUtf8TextEvents.push('open:' + invalidUtf8TextSocket.protocol);
        finish();
      });
      invalidUtf8TextSocket.addEventListener('message', (event) => {
        invalidUtf8TextEvents.push('message:' + String(event.data));
        finish();
      });
      invalidUtf8TextSocket.addEventListener('error', () => {
        invalidUtf8TextEvents.push('error');
        finish();
      });
      invalidUtf8TextSocket.addEventListener('close', (event) => {
        invalidUtf8TextEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + invalidUtf8TextSocket.readyState);
        finish();
      });
      const reservedOpcodeTarget = new URL('/reserved-opcode?kind=generic', location.href);
      reservedOpcodeTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const reservedOpcodeSocket = new WebSocket(reservedOpcodeTarget.href, ['published-endpoint']);
      reservedOpcodeSocket.addEventListener('open', () => {
        reservedOpcodeEvents.push('open:' + reservedOpcodeSocket.protocol);
        finish();
      });
      reservedOpcodeSocket.addEventListener('message', (event) => {
        reservedOpcodeEvents.push('message:' + String(event.data));
        finish();
      });
      reservedOpcodeSocket.addEventListener('error', () => {
        reservedOpcodeEvents.push('error');
        finish();
      });
      reservedOpcodeSocket.addEventListener('close', (event) => {
        reservedOpcodeEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + reservedOpcodeSocket.readyState);
        finish();
      });
      const serverPingTarget = new URL('/server-ping?kind=generic', location.href);
      serverPingTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const serverPingSocket = new WebSocket(serverPingTarget.href, ['published-endpoint']);
      serverPingSocket.addEventListener('open', () => {
        serverPingEvents.push('open:' + serverPingSocket.protocol);
        finish();
      });
      serverPingSocket.addEventListener('message', (event) => {
        serverPingEvents.push('message:' + String(event.data));
        finish();
      });
      serverPingSocket.addEventListener('error', () => {
        serverPingEvents.push('error');
        finish();
      });
      serverPingSocket.addEventListener('close', (event) => {
        serverPingEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + serverPingSocket.readyState);
        finish();
      });
      const fragmentedPingTarget = new URL('/fragmented-ping?kind=generic', location.href);
      fragmentedPingTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fragmentedPingSocket = new WebSocket(fragmentedPingTarget.href, ['published-endpoint']);
      fragmentedPingSocket.addEventListener('open', () => {
        fragmentedPingEvents.push('open:' + fragmentedPingSocket.protocol);
        finish();
      });
      fragmentedPingSocket.addEventListener('message', (event) => {
        fragmentedPingEvents.push('message:' + String(event.data));
        finish();
      });
      fragmentedPingSocket.addEventListener('error', () => {
        fragmentedPingEvents.push('error');
        finish();
      });
      fragmentedPingSocket.addEventListener('close', (event) => {
        fragmentedPingEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + fragmentedPingSocket.readyState);
        finish();
      });
      const clientEmptyCloseTarget = new URL('/client-empty-close?kind=generic', location.href);
      clientEmptyCloseTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const clientEmptyCloseSocket = new WebSocket(clientEmptyCloseTarget.href, ['published-endpoint']);
      clientEmptyCloseSocket.addEventListener('open', () => {
        clientEmptyCloseEvents.push('open:' + clientEmptyCloseSocket.protocol);
        clientEmptyCloseSocket.close();
        finish();
      });
      clientEmptyCloseSocket.addEventListener('error', () => {
        clientEmptyCloseEvents.push('error');
        finish();
      });
      clientEmptyCloseSocket.addEventListener('close', (event) => {
        clientEmptyCloseEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + clientEmptyCloseSocket.readyState);
        finish();
      });
      const connectingCloseTarget = new URL('/delayed-upgrade?kind=generic', location.href);
      connectingCloseTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const connectingCloseSocket = new WebSocket(connectingCloseTarget.href, ['published-endpoint']);
      connectingCloseSocket.addEventListener('open', () => {
        connectingCloseEvents.push('open:' + connectingCloseSocket.readyState);
        finish();
      });
      connectingCloseSocket.addEventListener('error', () => {
        connectingCloseEvents.push('error:' + connectingCloseSocket.readyState);
        finish();
      });
      connectingCloseSocket.addEventListener('close', (event) => {
        connectingCloseEvents.push(
          'close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + connectingCloseSocket.readyState
        );
        finish();
      });
      connectingCloseEvents.push('before-close:' + connectingCloseSocket.readyState);
      connectingCloseSocket.close();
      connectingCloseEvents.push('after-close:' + connectingCloseSocket.readyState);
      const missingCloseCodeTarget = new URL('/missing-close-code?kind=generic', location.href);
      missingCloseCodeTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const missingCloseCodeSocket = new WebSocket(missingCloseCodeTarget.href, ['published-endpoint']);
      missingCloseCodeSocket.addEventListener('open', () => {
        missingCloseCodeEvents.push('open:' + missingCloseCodeSocket.protocol);
        try {
          missingCloseCodeSocket.close(undefined, 'missing-code');
          missingCloseCodeEvents.push('missing-code:not-thrown:' + missingCloseCodeSocket.readyState);
        } catch (error) {
          missingCloseCodeEvents.push('missing-code:' + error.name + ':' + missingCloseCodeSocket.readyState);
        }
        if (missingCloseCodeSocket.readyState === WebSocket.OPEN) {
          missingCloseCodeSocket.close(1000, 'missing-code-complete');
        }
        finish();
      });
      missingCloseCodeSocket.addEventListener('error', () => {
        missingCloseCodeEvents.push('error');
        finish();
      });
      missingCloseCodeSocket.addEventListener('close', (event) => {
        missingCloseCodeEvents.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + missingCloseCodeSocket.readyState);
        finish();
      });
      const fragmentedTarget = new URL('/fragmented-text?kind=generic', location.href);
      fragmentedTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const fragmentedSocket = new WebSocket(fragmentedTarget.href, ['published-endpoint']);
      fragmentedSocket.addEventListener('open', () => {
        fragmentedMessages.push('open:' + fragmentedSocket.protocol);
        finish();
      });
      fragmentedSocket.addEventListener('message', (event) => {
        fragmentedMessages.push('message:' + String(event.data));
        finish();
      });
      fragmentedSocket.addEventListener('error', () => {
        fragmentedMessages.push('error');
        finish();
      });
      fragmentedSocket.addEventListener('close', (event) => {
        fragmentedMessages.push('close:' + event.code + ':' + event.reason + ':' + event.wasClean + ':' + fragmentedSocket.readyState);
        finish();
      });
      socket.addEventListener('open', () => {
        openProtocol = socket.protocol;
        status.textContent = 'Published Endpoint WebSocket open: ' + socket.protocol;
        try {
          socket.close(2999, 'invalid');
          closeValidationEvents.push('invalid-code:not-thrown');
        } catch (error) {
          closeValidationEvents.push('invalid-code:' + error.name);
        }
        try {
          socket.close(3000, 'x'.repeat(124));
          closeValidationEvents.push('long-reason:not-thrown');
        } catch (error) {
          closeValidationEvents.push('long-reason:' + error.name);
        }
        closeValidationEvents.push('state-after-invalid:' + socket.readyState);
        bufferedAmountEvents.push('before:' + socket.bufferedAmount);
        socket.send('endpoint-client');
        bufferedAmountEvents.push('after-send:' + socket.bufferedAmount);
        socket.send(new Uint8Array([5, 8, 13, 21]));
        bufferedAmountEvents.push('after-send:' + socket.bufferedAmount);
      });
      socket.addEventListener('message', (event) => {
        if (event.data instanceof ArrayBuffer) {
          binaryMessages.push([...new Uint8Array(event.data)].join(','));
          status.dataset.binaryMessages = binaryMessages.join('|');
          finish();
          return;
        }
        messages.push(String(event.data));
        status.dataset.messages = messages.join('|');
        finish();
      });
      const blobTarget = new URL('/blob?kind=generic', location.href);
      blobTarget.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const blobSocket = new WebSocket(blobTarget.href, ['published-endpoint']);
      blobSocket.binaryType = 'not-a-real-binary-type';
      blobSocket.addEventListener('open', () => {
        blobSocket.send(new Blob([new Uint8Array([31, 7, 3])]));
      });
      blobSocket.addEventListener('message', async (event) => {
        if (typeof event.data === 'string' && event.data.startsWith('server-ready:')) return;
        if (!(event.data instanceof Blob)) {
          blobMessages.push('not-blob:' + Object.prototype.toString.call(event.data));
          finish();
          return;
        }
        const bytes = new Uint8Array(await event.data.arrayBuffer());
        blobMessages.push([...bytes].join(','));
        status.dataset.blobMessages = blobMessages.join('|');
        blobSocket.close(1000, 'blob-complete');
        finish();
      });
      socket.addEventListener('close', (event) => {
        closeEvents.push(event.code + ':' + event.reason + ':' + event.wasClean);
        bufferedAmountEvents.push('after-close:' + socket.bufferedAmount);
        try {
          socket.send('after-server-close');
          sendLifecycleEvents.push('closed:ok:' + socket.readyState + ':' + socket.bufferedAmount);
        } catch (error) {
          sendLifecycleEvents.push('closed:' + error.name);
        }
        status.dataset.close = closeEvents.join('|');
        window.setTimeout(finish, 0);
      });
      socket.addEventListener('error', () => {
        status.textContent = 'Published Endpoint WebSocket error';
      });
    </script>
  </body>
</html>\`);
    return;
  }
  response.writeHead(404);
  response.end();
});

server.on('upgrade', (request, socket, head) => {
  console.log('generic-upgrade', request.url, request.headers['sec-websocket-protocol'] || 'none');
  if (request.url === '/reject?kind=generic') {
    socket.write([
      'HTTP/1.1 404 Not Found',
      'Connection: close',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'no websocket here'
    ].join('\\r\\n'));
    socket.end();
    return;
  }
  if (request.url === '/mismatched-protocol?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: unexpected-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.end();
    return;
  }
  if (request.url === '/fallback-protocol?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: fallback-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(textFrame(JSON.stringify({ type: 'custom', event: 'fallback-protocol' })));
    return;
  }
  if (request.url === '/empty-close?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(emptyCloseFrame());
    socket.end();
    return;
  }
  if (request.url === '/invalid-close?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(closeFrame(999, 'bad-close'));
    socket.end();
    return;
  }
  if (request.url === '/malformed-close?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(malformedCloseFrame());
    socket.end();
    return;
  }
  if (request.url === '/invalid-close-reason?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(invalidCloseReasonFrame());
    const closeTimeout = setTimeout(() => socket.end(), 1000);
    socket.on('data', (chunk) => {
      for (const message of decodeTextFrames(new Uint8Array(chunk))) {
        if (message.opcode !== 8) continue;
        clearTimeout(closeTimeout);
        console.log('invalid-close-reason-close', closeCode(message.payload), closeReason(message.payload));
        socket.end();
      }
    });
    return;
  }
  if (request.url === '/fragmented-text?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(fragmentedTextFrames('fragmented:', 'split-message'));
    socket.write(closeFrame(1000, 'fragmented-complete'));
    socket.end();
    return;
  }
  if (request.url === '/masked-server-frame?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(maskedFrame(1, encoder.encode('masked-server-frame')));
    socket.end();
    return;
  }
  if (request.url === '/invalid-utf8-text?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(frame(1, new Uint8Array([0xc3, 0x28])));
    const closeTimeout = setTimeout(() => socket.end(), 1000);
    socket.on('data', (chunk) => {
      for (const message of decodeTextFrames(new Uint8Array(chunk))) {
        if (message.opcode !== 8) continue;
        clearTimeout(closeTimeout);
        console.log('invalid-utf8-close', closeCode(message.payload), closeReason(message.payload));
        socket.end();
      }
    });
    return;
  }
  if (request.url === '/reserved-opcode?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(frame(3, encoder.encode('reserved-opcode')));
    const closeTimeout = setTimeout(() => socket.end(), 1000);
    socket.on('data', (chunk) => {
      for (const message of decodeTextFrames(new Uint8Array(chunk))) {
        if (message.opcode !== 8) continue;
        clearTimeout(closeTimeout);
        console.log('reserved-opcode-close', closeCode(message.payload), closeReason(message.payload));
        socket.end();
      }
    });
    return;
  }
  if (request.url === '/server-ping?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(pingFrame('server-ping'));
    const closeTimeout = setTimeout(() => socket.end(), 1000);
    socket.on('data', (chunk) => {
      for (const message of decodeTextFrames(new Uint8Array(chunk))) {
        if (message.opcode !== 10) continue;
        clearTimeout(closeTimeout);
        console.log('server-pong', decoder.decode(message.payload));
        socket.write(textFrame('ping-complete'));
        socket.write(closeFrame(1000, 'server-ping-complete'));
        socket.end();
      }
    });
    return;
  }
  if (request.url === '/fragmented-ping?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    socket.write(frame(9, encoder.encode('fragmented-ping'), false));
    socket.end();
    return;
  }
  if (request.url === '/client-empty-close?kind=generic') {
    socket.write([
      'HTTP/1.1 101 Switching Protocols',
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Protocol: published-endpoint',
      '',
      ''
    ].join('\\r\\n'));
    const closeTimeout = setTimeout(() => socket.end(), 1000);
    socket.on('data', (chunk) => {
      for (const message of decodeTextFrames(new Uint8Array(chunk))) {
        if (message.opcode !== 8) continue;
        clearTimeout(closeTimeout);
        console.log('client-empty-close-frame', closeCode(message.payload), message.payload.byteLength);
        socket.write(emptyCloseFrame());
        socket.end();
      }
    });
    return;
  }
  if (request.url === '/delayed-upgrade?kind=generic') {
    setTimeout(() => {
      socket.write([
        'HTTP/1.1 101 Switching Protocols',
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Protocol: published-endpoint',
        '',
        ''
      ].join('\\r\\n'));
      socket.end();
    }, 250);
    return;
  }
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Connection: Upgrade',
    'Upgrade: websocket',
    'Sec-WebSocket-Protocol: published-endpoint',
    '',
    ''
  ].join('\\r\\n'));
  socket.write(textFrame('server-ready:' + request.url));
  if (head.byteLength > 0) handleClientBytes(socket, head);
  socket.on('data', (chunk) => handleClientBytes(socket, chunk));
});

server.listen(5173, () => console.log('published-endpoint-websocket listening'));

function handleClientBytes(socket, chunk) {
  for (const message of decodeTextFrames(new Uint8Array(chunk))) {
    if (message.opcode === 1) {
      const text = decoder.decode(message.payload);
      console.log('generic-frame', text);
      socket.write(textFrame('echo:' + text));
    } else if (message.opcode === 2) {
      console.log('generic-binary', [...message.payload].join(','));
      socket.write(binaryFrame(new Uint8Array([...message.payload].reverse())));
      socket.write(closeFrame(1000, 'done'));
      socket.end();
    }
  }
}

function textFrame(text) {
  const payload = encoder.encode(text);
  return frame(1, payload);
}

function binaryFrame(payload) {
  return frame(2, payload);
}

function pingFrame(text) {
  return frame(9, encoder.encode(text));
}

function closeFrame(code, reason) {
  const reasonBytes = encoder.encode(reason);
  const payload = new Uint8Array(2 + reasonBytes.byteLength);
  payload[0] = (code >>> 8) & 0xff;
  payload[1] = code & 0xff;
  payload.set(reasonBytes, 2);
  return frame(8, payload);
}

function emptyCloseFrame() {
  return frame(8, new Uint8Array());
}

function malformedCloseFrame() {
  return frame(8, new Uint8Array([0x03]));
}

function invalidCloseReasonFrame() {
  return frame(8, new Uint8Array([0x03, 0xe8, 0xc3, 0x28]));
}

function fragmentedTextFrames(first, second) {
  const firstFrame = frame(1, encoder.encode(first), false);
  const secondFrame = frame(0, encoder.encode(second), true);
  const output = new Uint8Array(firstFrame.byteLength + secondFrame.byteLength);
  output.set(firstFrame, 0);
  output.set(secondFrame, firstFrame.byteLength);
  return output;
}

function frame(opcode, payload, fin = true) {
  const headerLength = payload.byteLength < 126 ? 2 : payload.byteLength <= 0xffff ? 4 : 10;
  const output = new Uint8Array(headerLength + payload.byteLength);
  output[0] = (fin ? 0x80 : 0) | opcode;
  if (payload.byteLength < 126) {
    output[1] = payload.byteLength;
  } else if (payload.byteLength <= 0xffff) {
    output[1] = 126;
    output[2] = (payload.byteLength >>> 8) & 0xff;
    output[3] = payload.byteLength & 0xff;
  } else {
    output[1] = 127;
    const high = Math.floor(payload.byteLength / 2 ** 32);
    const low = payload.byteLength >>> 0;
    writeUint32(output, 2, high);
    writeUint32(output, 6, low);
  }
  output.set(payload, headerLength);
  return output;
}

function maskedFrame(opcode, payload, fin = true) {
  const unmasked = frame(opcode, payload, fin);
  const headerLength = payload.byteLength < 126 ? 2 : payload.byteLength <= 0xffff ? 4 : 10;
  const output = new Uint8Array(unmasked.byteLength + 4);
  output.set(unmasked.slice(0, headerLength), 0);
  output[1] |= 0x80;
  const mask = new Uint8Array([0x11, 0x22, 0x33, 0x44]);
  output.set(mask, headerLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    output[headerLength + 4 + index] = payload[index] ^ mask[index % 4];
  }
  return output;
}

function decodeTextFrames(bytes) {
  const messages = [];
  let offset = 0;
  while (bytes.byteLength - offset >= 2) {
    const opcode = bytes[offset] & 0x0f;
    const masked = (bytes[offset + 1] & 0x80) !== 0;
    let length = bytes[offset + 1] & 0x7f;
    let headerLength = 2;
    if (length === 126) {
      length = (bytes[offset + 2] << 8) | bytes[offset + 3];
      headerLength = 4;
    } else if (length === 127) {
      length = readUint32(bytes, offset + 2) * 2 ** 32 + readUint32(bytes, offset + 6);
      headerLength = 10;
    }
    const maskLength = masked ? 4 : 0;
    const payloadStart = offset + headerLength + maskLength;
    const payload = bytes.slice(payloadStart, payloadStart + length);
    if (masked) {
      const mask = bytes.slice(offset + headerLength, offset + headerLength + 4);
      for (let index = 0; index < payload.byteLength; index += 1) payload[index] ^= mask[index % 4];
    }
    if (opcode === 1 || opcode === 2 || opcode === 8 || opcode === 10) messages.push({ opcode, payload });
    offset = payloadStart + length;
  }
  return messages;
}

function closeCode(payload) {
  if (payload.byteLength < 2) return 1005;
  return (payload[0] << 8) | payload[1];
}

function closeReason(payload) {
  return payload.byteLength > 2 ? decoder.decode(payload.slice(2)) : '';
}

function readUint32(bytes, offset) {
  return ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3];
}

function writeUint32(bytes, offset, value) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}
`.trimStart();
}

});

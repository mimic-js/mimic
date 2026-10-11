import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const publishedHttpFidelityClaim = defineCompatibilityClaim({
  id: 'published-http-fidelity-v1',
  statement:
    'Published Endpoints preserve public HTTP streaming and failures without representing unsupported wire features as successful browser responses',
  target: {
    kind: 'runtime-capability',
    capability: 'published-http-fidelity'
  }
});

test(publishedHttpFidelityClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (source) => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();
    const encoder = new TextEncoder();

    const run = async (workdirName: string, staleUrl?: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${workdirName}` });
      const outputChunks: string[] = [];

      try {
        await runtime.fs.mount({ 'server.mjs': { file: { contents: source } } });
        const ready = new Promise<{ port: number; url: string }>((resolve) => {
          const current = runtime.endpoints.current[0];
          if (current) {
            resolve({ port: current.address.port, url: current.url });
            return;
          }
          const unsubscribe = runtime.endpoints.on('published', (endpoint) => {
            unsubscribe();
            resolve({ port: endpoint.address.port, url: endpoint.url });
          });
        });
        const process = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`], { cwd: runtime.workdir });
        const output = (async () => {
          const reader = process.output.getReader();
          try {
            while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              outputChunks.push(decoder.decode(value, { stream: true }));
            }
            outputChunks.push(decoder.decode());
          } finally {
            reader.releaseLock();
          }
        })();
        const startup = await Promise.race([
          ready.then((value) => ({ type: 'ready' as const, value })),
          process.exit.then((exitCode) => ({ type: 'exit' as const, exitCode })),
          sleep(30_000).then(() => ({ type: 'timeout' as const }))
        ]);
        if (startup.type !== 'ready') {
          process.kill('SIGTERM');
          await process.exit;
          await output;
          return { startup, output: outputChunks.join('') };
        }

        const streamResponse = await runtime.endpoints.fetch(new URL('stream-response', startup.value.url), { cache: 'no-store' });
        if (!streamResponse.body) throw new Error('Published HTTP stream response did not expose a ReadableStream body.');
        const streamReader = streamResponse.body.getReader();
        const firstResponseChunk = await streamReader.read();
        const outputBeforeSecondResponseChunk = outputChunks.join('');
        const secondResponseChunk = await streamReader.read();
        const streamDone = await streamReader.read();
        const htmlStream = await collectStreamingBoundary(
          new URL('stream-document', startup.value.url),
          'published-http-html-first',
          'published-http-html-second'
        );
        const javascriptStream = await collectStreamingBoundary(
          new URL('stream-script.js', startup.value.url),
          'published-http-javascript-first',
          'published-http-javascript-second'
        );
        const cssJavascriptStream = await collectStreamingBoundary(
          new URL('stream-style.css', startup.value.url),
          'published-http-css-javascript-first',
          'published-http-css-javascript-second'
        );

        let requestController: ReadableStreamDefaultController<Uint8Array> | undefined;
        const requestBody = new ReadableStream<Uint8Array>({
          start(controller) {
            requestController = controller;
            controller.enqueue(encoder.encode('first:'));
          }
        });
        const incrementalRequest = runtime.endpoints.fetch(new URL('stream-request', startup.value.url), {
          method: 'POST',
          body: requestBody,
          duplex: 'half'
        } as RequestInit & { duplex: 'half' });
        await waitForText(() => outputChunks.join(''), 'published-http-request-first first:');
        requestController?.enqueue(encoder.encode('second'));
        requestController?.close();
        const incrementalResponse = await incrementalRequest;

        const cancellationResponse = await runtime.endpoints.fetch(new URL('cancel-response', startup.value.url), { cache: 'no-store' });
        if (!cancellationResponse.body) throw new Error('Published HTTP cancellation response did not expose a ReadableStream body.');
        const cancellationReader = cancellationResponse.body.getReader();
        const cancellationFirstChunk = await cancellationReader.read();
        await cancellationReader.cancel('browser witness cancellation');
        await waitForText(() => outputChunks.join(''), 'published-http-cancel-request-close');

        const manualRedirect = await runtime.endpoints.fetch(new URL('redirect', startup.value.url), {
          cache: 'no-store',
          redirect: 'manual'
        });
        const followedRedirect = await runtime.endpoints.fetch(new URL('redirect', startup.value.url), { cache: 'no-store' });
        const informational = await runtime.endpoints.fetch(new URL('informational', startup.value.url), { cache: 'no-store' });
        const trailers = await runtime.endpoints.fetch(new URL('trailers', startup.value.url), { cache: 'no-store' });

        // The retired epoch's URL is requested while this epoch can still request it.
        const staleRoute = staleUrl
          ? await runtime.endpoints.fetch(staleUrl, { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
              .then((response) => ({ reachable: response.ok, status: response.status }))
              .catch(() => ({ reachable: false, status: 0 }))
          : undefined;
        // A response from `endpoints.fetch()` is read before the epoch that answered it ends.
        const incrementalBody = await incrementalResponse.text();
        const followedRedirectBody = await followedRedirect.text();
        await runtime.teardown();
        await output;

        return {
          startup,
          stream: {
            status: streamResponse.status,
            first: firstResponseChunk.done ? '' : decoder.decode(firstResponseChunk.value),
            second: secondResponseChunk.done ? '' : decoder.decode(secondResponseChunk.value),
            done: streamDone.done,
            outputBeforeSecondResponseChunk
          },
          htmlStream,
          javascriptStream,
          cssJavascriptStream,
          incremental: {
            status: incrementalResponse.status,
            body: incrementalBody,
            outputBeforeSecondRequestChunk: outputChunks.join('').includes('published-http-request-first first:')
          },
          cancellation: {
            status: cancellationResponse.status,
            first: cancellationFirstChunk.done ? '' : decoder.decode(cancellationFirstChunk.value),
            output: outputChunks.join('')
          },
          manualRedirect: {
            status: manualRedirect.status,
            type: manualRedirect.type,
            location: manualRedirect.headers.get('location'),
            duplicateSafeHeader: manualRedirect.headers.get('x-safe-duplicate')
          },
          followedRedirect: {
            status: followedRedirect.status,
            body: followedRedirectBody,
            duplicateSafeHeader: followedRedirect.headers.get('x-safe-duplicate'),
            // The handler's own Content-Length describes no connection here.
            contentLength: followedRedirect.headers.get('content-length')
          },
          informational: {
            status: informational.status,
            fidelityError: informational.headers.get('x-mimic-fidelity-error')
          },
          trailers: {
            status: trailers.status,
            fidelityError: trailers.headers.get('x-mimic-fidelity-error')
          },
          staleRoute,
          output: outputChunks.join('')
        };

        async function collectStreamingBoundary(url: URL, firstMarker: string, secondMarker: string) {
          const response = await runtime.endpoints.fetch(url, { cache: 'no-store' });
          if (!response.body) throw new Error(`Published HTTP response for ${url.pathname} did not expose a stream.`);
          const reader = response.body.getReader();
          const bodyDecoder = new TextDecoder();
          let body = '';
          while (!body.includes('first:')) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`Published HTTP response for ${url.pathname} ended before its first body chunk.`);
            body += bodyDecoder.decode(value, { stream: true });
          }
          const outputBeforeSecondChunk = outputChunks.join('');
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            body += bodyDecoder.decode(value, { stream: true });
          }
          body += bodyDecoder.decode();
          return {
            status: response.status,
            body,
            sawFirstMarker: outputBeforeSecondChunk.includes(firstMarker),
            sawSecondMarker: outputBeforeSecondChunk.includes(secondMarker)
          };
        }
      } finally {
        await runtime.teardown();
      }
    };

    const first = await run('published-http-fidelity');
    const staleUrl = first.startup.type === 'ready' ? first.startup.value.url : undefined;
    return { first, reboot: await run('published-http-fidelity-reboot', staleUrl) };

    function sleep(timeout: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, timeout));
    }

    async function waitForText(read: () => string, expected: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (!read().includes(expected)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read()}`);
        await sleep(10);
      }
    }
  }, publishedHttpWitnessSource());

  for (const run of [result.first, result.reboot]) {
    expect(run.startup, run.output).toMatchObject({ type: 'ready', value: { port: 5173 } });
    expect(run.stream, run.output).toMatchObject({
      status: 200,
      first: 'first:',
      second: 'second',
      done: true
    });
    expect(run.stream.outputBeforeSecondResponseChunk, run.output).toContain('published-http-response-first');
    expect(run.stream.outputBeforeSecondResponseChunk, run.output).not.toContain('published-http-response-second');
    expect(run.htmlStream.status, run.output).toBe(200);
    expect(run.htmlStream.body, run.output).toContain('<p>first:second</p>');
    expect(run.htmlStream.sawFirstMarker, run.output).toBe(true);
    expect(run.htmlStream.sawSecondMarker, run.output).toBe(false);
    expect(run.javascriptStream.status, run.output).toBe(200);
    expect(run.javascriptStream.body, run.output).toBe("globalThis.streamValue = 'first:second';");
    expect(run.javascriptStream.sawFirstMarker, run.output).toBe(true);
    expect(run.javascriptStream.sawSecondMarker, run.output).toBe(false);
    expect(run.cssJavascriptStream.status, run.output).toBe(200);
    expect(run.cssJavascriptStream.body, run.output).toBe(
      "globalThis.cssModuleStreamValue = 'first:second';"
    );
    expect(run.cssJavascriptStream.sawFirstMarker, run.output).toBe(true);
    expect(run.cssJavascriptStream.sawSecondMarker, run.output).toBe(false);
    expect(run.incremental, run.output).toEqual({
      status: 201,
      body: 'first:second',
      outputBeforeSecondRequestChunk: true
    });
    expect(run.cancellation.status).toBe(200);
    expect(run.cancellation.first).toBe('first:');
    expect(run.cancellation.output).toContain('published-http-cancel-request-close');
    expect(run.cancellation.output).toContain('published-http-cancel-socket-close');
    expect(run.cancellation.output).not.toContain('published-http-cancel-finished');
    expect(run.manualRedirect).toEqual({
      status: 0,
      type: 'opaqueredirect',
      location: null,
      duplicateSafeHeader: null
    });
    expect(run.followedRedirect).toEqual({
      status: 200,
      body: 'redirect-final',
      duplicateSafeHeader: 'one, two',
      contentLength: null
    });
    expect(run.informational).toEqual({
      status: 502,
      fidelityError: 'UNREPRESENTABLE_INFORMATIONAL_RESPONSE'
    });
    expect(run.trailers).toEqual({ status: 502, fidelityError: 'UNREPRESENTABLE_TRAILERS' });
    expect(run.output).not.toContain('falling back to registered command adapter');
    expect(run.output).not.toContain('vfsPreviewFallback');
  }
  // A retired route answers 404, which Chromium also reports on the console.
  expect(result.reboot.staleRoute).toEqual({ reachable: false, status: 404 });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.filter((message) => message.includes('502 (Bad Gateway)'))).toHaveLength(4);
  expect(consoleErrors.filter((message) => message.includes('status of 404'))).toHaveLength(1);
  expect(consoleErrors).toHaveLength(5);
});

function publishedHttpWitnessSource(): string {
  return [
    "import http from 'node:http';",
    '',
    'const keepAlive = setTimeout(() => {}, 120_000);',
    'const server = http.createServer((request, response) => {',
    "  if (request.url === '/stream-response') {",
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "    response.write('first:');",
    "    console.log('published-http-response-first');",
    "    setTimeout(() => { console.log('published-http-response-second'); response.end('second'); }, 100);",
    '    return;',
    '  }',
    "  if (request.url === '/stream-document') {",
    "    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });",
    "    response.write('<!doctype html><p>first:');",
    "    console.log('published-http-html-first');",
    "    setTimeout(() => { console.log('published-http-html-second'); response.end('second</p>'); }, 100);",
    '    return;',
    '  }',
    "  if (request.url === '/stream-script.js') {",
    "    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });",
    "    response.write(\"globalThis.streamValue = 'first:\");",
    "    console.log('published-http-javascript-first');",
    "    setTimeout(() => { console.log('published-http-javascript-second'); response.end(\"second';\"); }, 100);",
    '    return;',
    '  }',
    "  if (request.url === '/stream-style.css') {",
    "    response.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });",
    "    response.write(\"globalThis.cssModuleStreamValue = 'first:\");",
    "    console.log('published-http-css-javascript-first');",
    "    setTimeout(() => { console.log('published-http-css-javascript-second'); response.end(\"second';\"); }, 100);",
    '    return;',
    '  }',
    "  if (request.url === '/stream-request') {",
    '    const chunks = [];',
    "    request.setEncoding('utf8');",
    "    request.on('data', (chunk) => { chunks.push(chunk); if (chunks.length === 1) console.log('published-http-request-first', chunks.join('')); });",
    "    request.on('end', () => { response.writeHead(201, { 'content-type': 'text/plain; charset=utf-8' }); response.end(chunks.join('')); });",
    '    return;',
    '  }',
    "  if (request.url === '/cancel-response') {",
    "    request.once('close', () => console.log('published-http-cancel-request-close'));",
    "    request.socket.once('close', () => console.log('published-http-cancel-socket-close'));",
    "    response.once('finish', () => console.log('published-http-cancel-finished'));",
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "    response.write('first:');",
    '    return;',
    '  }',
    "  if (request.url === '/redirect') {",
    "    response.setHeader('x-safe-duplicate', ['one', 'two']);",
    "    response.writeHead(302, { location: '/redirect-final' });",
    "    response.end('redirecting');",
    '    return;',
    '  }',
    "  if (request.url === '/redirect-final') {",
    "    response.setHeader('x-safe-duplicate', ['one', 'two']);",
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "    response.end('redirect-final');",
    '    return;',
    '  }',
    "  if (request.url === '/informational') {",
    "    response.writeEarlyHints({ link: '</style.css>; rel=preload; as=style' });",
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });",
    "    response.end('must-not-represent-informational-as-a-final-browser-response');",
    '    return;',
    '  }',
    "  if (request.url === '/trailers') {",
    "    response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', trailer: 'x-checksum', 'transfer-encoding': 'chunked' });",
    "    response.write('trailer-body');",
    "    response.addTrailers({ 'x-checksum': 'alpha-beta' });",
    "    response.end();",
    '    return;',
    '  }',
    '  response.writeHead(404);',
    '  response.end();',
    '});',
    "server.once('error', (error) => { clearTimeout(keepAlive); throw error; });",
    "server.listen(5173, '127.0.0.1', () => console.log('published-http-ready'));"
  ].join('\n');
}

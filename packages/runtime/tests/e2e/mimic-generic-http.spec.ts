import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const nodeNetworkAdaptersClaim = defineCompatibilityClaim({
  id: 'node-network-adapters-v1',
  statement:
    'Mimic publishes a plain HTTP process endpoint to an application-owned client without preview or VFS fallback while DNS, TLS, HTTPS, and HTTP/2 report honest browser boundaries',
  target: {
    kind: 'runtime-capability',
    capability: 'node-network-adapters'
  }
});

test(nodeNetworkAdaptersClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();

    const run = async (owner: string, stopMode: 'shutdown' | 'teardown', staleUrl?: string) => {
      const runtime = await Mimic.boot({ workdir: `/home/${owner}` });
      const outputChunks: string[] = [];
      const source = [
        "import dns from 'node:dns';",
        "import http from 'node:http';",
        "import http2 from 'node:http2';",
        "import https from 'node:https';",
        "import net from 'node:net';",
        "import tls from 'node:tls';",
        '',
        `const owner = ${JSON.stringify(owner)};`,
        'const keepAlive = setTimeout(() => {}, 120_000);',
        'const failServer = (error) => { clearTimeout(keepAlive); throw error; };',
        'const rawServer = net.createServer((socket) => {',
        "  let input = '';",
        "  socket.setEncoding('utf8');",
        "  socket.on('data', (chunk) => {",
        '    input += chunk;',
        "    if (!input.includes('\\r\\n\\r\\n')) return;",
        "    if (input.includes(' /truncated ')) socket.end('HTTP/1.1 200 OK\\r\\nContent-Length: 8\\r\\nConnection: close\\r\\n\\r\\nshort');",
        "    else if (input.includes(' /malformed-status ')) socket.end('NOT HTTP\\r\\nConnection: close\\r\\n\\r\\n');",
        "    else socket.end('HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\nConnection: close\\r\\n\\r\\nZZ\\r\\n');",
        '  });',
        '});',
        'class PipeDestination {',
        '  constructor() { this.listeners = new Map(); this.chunks = []; this.ended = 0; }',
        "  on(event, listener) { this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]); return this; }",
        "  once(event, listener) { const once = (...args) => { this.removeListener(event, once); listener(...args); }; once.listener = listener; return this.on(event, once); }",
        "  off(event, listener) { return this.removeListener(event, listener); }",
        "  removeListener(event, listener) { this.listeners.set(event, (this.listeners.get(event) ?? []).filter((candidate) => candidate !== listener && candidate.listener !== listener)); return this; }",
        "  emit(event, ...args) { for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args); return this.listenerCount(event) > 0; }",
        "  listenerCount(event) { return this.listeners.get(event)?.length ?? 0; }",
        "  write(chunk) { this.chunks.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk)); return true; }",
        "  end() { this.ended += 1; this.emit('finish'); return this; }",
        '}',
        'const pipeListenerSnapshot = (source, first, second) => ({',
        "  source: { data: source.listenerCount('data'), end: source.listenerCount('end') },",
        "  first: { close: first.listenerCount('close'), finish: first.listenerCount('finish'), unpipe: first.listenerCount('unpipe') },",
        "  second: { close: second.listenerCount('close'), finish: second.listenerCount('finish'), unpipe: second.listenerCount('unpipe') }",
        '});',
        'const server = http.createServer((request, response) => {',
        '  const chunks = [];',
        "  request.setEncoding('utf8');",
        "  request.on('error', (error) => console.log('generic-http-request-error', request.url, error.code));",
        "  request.on('aborted', () => console.log('generic-http-request-aborted', request.url, request.complete));",
        "  if (request.url === '/one' || request.url === '/all') {",
        '    const first = new PipeDestination();',
        '    const second = new PipeDestination();',
        '    const events = [];',
        "    first.on('pipe', () => events.push('first:pipe'));",
        "    first.on('unpipe', () => events.push('first:unpipe'));",
        "    second.on('pipe', () => events.push('second:pipe'));",
        "    second.on('unpipe', () => events.push('second:unpipe'));",
        '    const baseline = pipeListenerSnapshot(request, first, second);',
        '    request.pipe(first);',
        '    request.pipe(second);',
        '    const afterPipe = pipeListenerSnapshot(request, first, second);',
        "    const unpipeReturnsRequest = (request.url === '/one' ? request.unpipe(first) : request.unpipe()) === request;",
        '    const afterUnpipe = pipeListenerSnapshot(request, first, second);',
        "    request.once('end', () => queueMicrotask(() => response.end(JSON.stringify({ baseline, afterPipe, afterUnpipe, afterEnd: pipeListenerSnapshot(request, first, second), unpipeReturnsRequest, events, first: { chunks: first.chunks, ended: first.ended }, second: { chunks: second.chunks, ended: second.ended } }))));",
        '    request.resume();',
        '    return;',
        '  }',
        "  request.on('data', (chunk) => chunks.push(chunk));",
        "  request.on('end', () => {",
        "    console.log('generic-http-request', owner, request.url);",
        "    if (request.url === '/shutdown') {",
        "      response.once('finish', () => {",
        "        console.log('generic-http-shutdown-finished', owner);",
        '        server.close((error) => {',
        "          console.log('generic-http-closed', owner, JSON.stringify(server.address()));",
        '          if (error) failServer(error);',
        '          else rawServer.close((rawError) => { if (rawError) failServer(rawError); else clearTimeout(keepAlive); });',
        '        });',
        '      });',
        "      response.writeHead(200, { 'content-type': 'text/plain', 'x-runtime-owner': owner });",
        "      response.end('shutdown:' + owner);",
        '      return;',
        '    }',
        "    if (request.url === '/external') {",
        "      response.writeHead(202, { 'content-type': 'application/json', 'x-runtime-owner': owner });",
        "      const accepted = response.write('z'.repeat(response.writableHighWaterMark + 1));",
        "      console.log('generic-http-server-backpressure', accepted, response.writableNeedDrain);",
        '      const finish = () => response.end(\':tail\');',
        "      if (accepted) finish(); else response.once('drain', () => { console.log('generic-http-server-drain'); finish(); });",
        '      return;',
        '    }',
        "    if (request.url === '/no-length') {",
        "      response.writeHead(200, { 'content-type': 'text/plain', 'x-runtime-owner': owner });",
        "      response.end('received:' + chunks.join('').length);",
        '      return;',
        '    }',
        "    if (request.url === '/loopback?source=client') {",
        "      response.writeHead(201, { 'content-type': 'application/json', 'x-server-owner': String(process.pid), 'x-runtime-owner': owner, trailer: 'x-response-checksum', 'transfer-encoding': 'chunked' });",
        "      const body = chunks.join('');",
        "      const payload = JSON.stringify({ method: request.method, url: request.url, bodyLength: body.length, bodySuffix: body.slice(-5), clientOwner: request.headers['x-client-owner'] });",
        '      const split = Math.ceil(payload.length / 2);',
        '      response.write(payload.slice(0, split));',
        "      console.log('generic-http-server-first-chunk');",
        '      setTimeout(() => {',
        "        console.log('generic-http-server-finishing');",
        "        response.addTrailers({ 'x-response-checksum': 'alpha-beta' });",
        '        response.end(payload.slice(split));',
        '      }, 25);',
        '      return;',
        '    }',
        '    response.writeHead(404);',
        '    response.end();',
        '  });',
        '});',
        '',
        "server.once('error', failServer);",
        "rawServer.once('error', failServer);",
        "server.listen(5173, '127.0.0.1', () => {",
        '  const address = server.address();',
        "  console.log('generic-http-listening', owner, JSON.stringify(address));",
        "  rawServer.listen(5174, '127.0.0.1', () => {",
        "  try { http.request('not a url'); } catch (error) { console.log('generic-http-invalid-url', error.code); }",
        "  try { http.request({ port: 70000 }); } catch (error) { console.log('generic-http-invalid-port', error.code); }",
        "  const tlsRequest = https.request({ hostname: '127.0.0.1', port: address.port });",
        "  tlsRequest.once('error', (error) => console.log('generic-http-https-boundary', error.code));",
        '  tlsRequest.end();',
        "  try { https.createServer(); console.log('generic-http-https-server-boundary unexpected-success'); } catch (error) { console.log('generic-http-https-server-boundary', error.code); }",
        "  dns.lookup('localhost', (error, address, family) => console.log('generic-http-dns-loopback', error?.code ?? 'ok', address, family));",
        "  dns.promises.lookup('example.test').then(() => console.log('generic-http-dns-boundary unexpected-success')).catch((error) => console.log('generic-http-dns-boundary', error.code));",
        "  try { tls.createServer(); console.log('generic-http-tls-boundary unexpected-success'); } catch (error) { console.log('generic-http-tls-boundary', error.code); }",
        "  try { http2.connect('https://localhost'); console.log('generic-http-http2-boundary unexpected-success'); } catch (error) { console.log('generic-http-http2-boundary', error.code); }",
        "  const aborted = http.request({ hostname: '127.0.0.1', port: address.port, path: '/must-not-run' });",
        "  aborted.once('abort', () => console.log('generic-http-client-aborted'));",
        '  aborted.abort();',
        "  const requestBody = 'x'.repeat(16 * 1024 + 1);",
        '  const request = http.request({',
        "    hostname: '127.0.0.1',",
        '    port: address.port,',
        "    path: '/loopback?source=client',",
        "    method: 'POST',",
        "    headers: { 'content-type': 'text/plain', 'x-client-owner': String(process.pid), 'content-length': String(requestBody.length + 5) }",
        '  }, (response) => {',
        '    const chunks = [];',
        '    let firstChunk = true;',
        "    response.setEncoding('utf8');",
        "    response.on('data', (chunk) => {",
        '      chunks.push(chunk);',
        '      if (!firstChunk) return;',
        '      firstChunk = false;',
        "      console.log('generic-http-response-first-data');",
        '      response.pause();',
        "      setTimeout(() => { console.log('generic-http-response-resume'); response.resume(); }, 40);",
        '    });',
        "    response.on('end', () => {",
        "      console.log('generic-http-response', JSON.stringify({",
        '        statusCode: response.statusCode,',
        "        contentType: response.headers['content-type'],",
        "        serverOwner: response.headers['x-server-owner'],",
        "        runtimeOwner: response.headers['x-runtime-owner'],",
        "        responseChecksum: response.trailers['x-response-checksum'],",
        "        body: chunks.join(''),",
        '        socket: { localPort: response.socket?.localPort, remotePort: response.socket?.remotePort }',
        '      }));',
        '    });',
        '  });',
        "  request.once('error', failServer);",
        "  request.once('drain', () => { console.log('generic-http-client-drain'); request.end(':beta'); });",
        '  const accepted = request.write(requestBody);',
        "  console.log('generic-http-client-backpressure', accepted, request.writableNeedDrain);",
        "  if (accepted) request.end(':beta');",
        "  const noLength = http.request({ hostname: '127.0.0.1', port: address.port, path: '/no-length', method: 'POST' }, (response) => {",
        "    let body = '';",
        "    response.setEncoding('utf8');",
        "    response.on('data', (chunk) => { body += chunk; });",
        "    response.on('end', () => console.log('generic-http-no-length-response', body));",
        '  });',
        "  noLength.once('error', failServer);",
        '  const noLengthAccepted = noLength.write(requestBody);',
        "  console.log('generic-http-no-length-write', noLengthAccepted, noLength.writableNeedDrain);",
        "  if (noLengthAccepted) noLength.end(':free'); else noLength.once('drain', () => noLength.end(':free'));",
        '  const proveUnpipe = (path, body) => {',
        "    const proofRequest = http.request({ hostname: '127.0.0.1', port: 5173, path, method: 'POST' }, (response) => {",
        "      let proof = '';",
        "      response.setEncoding('utf8');",
        "      response.on('data', (chunk) => { proof += chunk; });",
        "      response.on('end', () => console.log('generic-http-unpipe-proof', path, proof));",
        '    });',
        "    proofRequest.once('error', failServer);",
        '    proofRequest.end(body);',
        '  };',
        "  proveUnpipe('/one', 'one-body');",
        "  proveUnpipe('/all', 'all-body');",
        "  http.get({ hostname: '127.0.0.1', port: 5174, path: '/truncated' }, (response) => {",
        "    response.on('aborted', () => console.log('generic-http-truncated-aborted', response.complete));",
        "    response.on('error', (error) => console.log('generic-http-truncated-error', error.code));",
        '    response.resume();',
        "  }).once('error', failServer);",
        "  http.get({ hostname: '127.0.0.1', port: 5174, path: '/malformed-status' })",
        "    .once('error', (error) => console.log('generic-http-malformed-status', error.code));",
        "  http.get({ hostname: '127.0.0.1', port: 5174, path: '/malformed-chunk' }, (response) => {",
        "    response.on('error', (error) => console.log('generic-http-malformed-chunk', error.code));",
        '    response.resume();',
        "  }).once('error', failServer);",
        "  const truncatedRequest = net.createConnection({ hostname: '127.0.0.1', port: address.port }, () => {",
        "    truncatedRequest.end('POST /truncated-request HTTP/1.1\\r\\nHost: 127.0.0.1:5173\\r\\nContent-Length: 8\\r\\nConnection: close\\r\\n\\r\\nshort');",
        '  });',
        "  truncatedRequest.once('error', (error) => console.log('generic-http-truncated-request-client', error.code));",
        "  for (const [name, length] of [['nondigit', 'nope'], ['negative', '-1'], ['fractional', '1.5'], ['unsafe', '9007199254740992']]) {",
        "    const invalidLengthRequest = net.createConnection({ hostname: '127.0.0.1', port: address.port }, () => {",
        "      invalidLengthRequest.end('POST /invalid-length-' + name + ' HTTP/1.1\\r\\nHost: 127.0.0.1:5173\\r\\nContent-Length: ' + length + '\\r\\nConnection: close\\r\\n\\r\\n');",
        '    });',
        "    invalidLengthRequest.once('close', () => console.log('generic-http-invalid-length-closed', name));",
        "    invalidLengthRequest.once('error', (error) => console.log('generic-http-invalid-length-client', name, error.code));",
        '  }',
        '  });',
        '});'
      ].join('\n');

      try {
        await runtime.fs.mount({
          src: {
            directory: {
              'main.js': { file: { contents: 'this file must never satisfy a server miss' } }
            }
          },
          'server.mjs': { file: { contents: source } }
        });

        const ready = new Promise<{ port: number; url: string }>((resolve) => {
          const unsubscribe = runtime.endpoints.on('published', (endpoint) => {
            unsubscribe();
            resolve({ port: endpoint.address.port, url: endpoint.url });
          });
        });

        const process = await runtime.spawn('node', [`${runtime.workdir}/server.mjs`], { cwd: runtime.workdir });
        const output = (async () => {
          const reader = process.output.getReader();
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            outputChunks.push(decoder.decode(value, { stream: true }));
          }
          outputChunks.push(decoder.decode());
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
          return { owner, startup, output: outputChunks.join('') };
        }

        await waitForText(() => outputChunks.join(''), 'generic-http-response {');
        await waitForText(() => outputChunks.join(''), 'generic-http-no-length-response received:16390');
        await waitForText(() => outputChunks.join(''), 'generic-http-unpipe-proof /one ');
        await waitForText(() => outputChunks.join(''), 'generic-http-unpipe-proof /all ');
        await waitForText(() => outputChunks.join(''), 'generic-http-malformed-chunk HPE_INVALID_CHUNK_SIZE');
        await waitForText(
          () => outputChunks.join(''),
          'generic-http-request-error /truncated-request ERR_STREAM_PREMATURE_CLOSE'
        );
        for (const name of ['nondigit', 'negative', 'fractional', 'unsafe']) {
          await waitForText(() => outputChunks.join(''), `generic-http-invalid-length-closed ${name}`);
        }
        const staleRoute = staleUrl
          ? await runtime.endpoints.fetch(staleUrl, { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
              .then((response) => ({ reachable: response.ok, status: response.status }))
              .catch(() => ({ reachable: false, status: 0 }))
          : undefined;
        const applicationClientResponse = await runtime.endpoints.fetch(new URL('external', startup.value.url), {
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000)
        });
        const applicationClient = {
          status: applicationClientResponse.status,
          owner: applicationClientResponse.headers.get('x-runtime-owner'),
          body: await applicationClientResponse.text()
        };
        const vfsMissResponse = await runtime.endpoints.fetch(new URL('src/main.js', startup.value.url), {
          cache: 'no-store',
          signal: AbortSignal.timeout(5_000)
        });
        const vfsMiss = { status: vfsMissResponse.status, body: await vfsMissResponse.text() };
        let shutdown: { status: number; owner: string | null; body: string } | undefined;
        if (stopMode === 'shutdown') {
          const shutdownResponse = await runtime.endpoints.fetch(new URL('shutdown', startup.value.url), {
            cache: 'no-store',
            signal: AbortSignal.timeout(5_000)
          });
          shutdown = {
            status: shutdownResponse.status,
            owner: shutdownResponse.headers.get('x-runtime-owner'),
            body: await shutdownResponse.text()
          };
        } else {
          await runtime.teardown();
        }
        const exitCode = await Promise.race([
          process.exit,
          sleep(5_000).then(() => {
            throw new Error(`HTTP process did not exit after close:\n${outputChunks.join('')}`);
          })
        ]);
        await output;
        const afterClose =
          stopMode === 'shutdown'
            ? await runtime.endpoints.fetch(startup.value.url, { cache: 'no-store', signal: AbortSignal.timeout(2_000) })
                .then((response) => ({ reachable: response.ok, status: response.status }))
                .catch(() => ({ reachable: false, status: 0 }))
            : undefined;
        const text = outputChunks.join('');
        const loopbackMatch = /generic-http-response (\{[^\n]+\})/u.exec(text);
        const unpipe = Object.fromEntries(
          [...text.matchAll(/generic-http-unpipe-proof (\/(?:one|all)) (\{[^\n]+\})/gu)].map((match) => [
            match[1],
            JSON.parse(match[2] ?? failMissingUnpipeProof(match[1]))
          ])
        );
        return {
          owner,
          stopMode,
          startup,
          applicationClient: {
            status: applicationClient.status,
            owner: applicationClient.owner,
            bodyLength: applicationClient.body.length,
            bodySuffix: applicationClient.body.slice(-5)
          },
          vfsMiss,
          shutdown,
          staleRoute,
          afterClose,
          exitCode,
          loopback: loopbackMatch ? JSON.parse(loopbackMatch[1]) : undefined,
          unpipe,
          output: text
        };
      } finally {
        await runtime.teardown();
      }
    };

    const first = await run('generic-http', 'teardown');
    const staleUrl = first.startup.type === 'ready' ? first.startup.value.url : undefined;
    return { first, reboot: await run('generic-http-reboot', 'shutdown', staleUrl) };

    function sleep(timeout: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, timeout));
    }

    function failMissingUnpipeProof(path: string | undefined): never {
      throw new Error(`Missing unpipe proof payload for ${path ?? 'unknown path'}`);
    }

    async function waitForText(read: () => string, expected: string): Promise<void> {
      const deadline = Date.now() + 30_000;
      while (!read().includes(expected)) {
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${expected}:\n${read()}`);
        await sleep(10);
      }
    }
  });

  for (const run of [result.first, result.reboot]) {
    expect(run.startup, run.output).toMatchObject({ type: 'ready', value: { port: 5173 } });
    if (run.stopMode === 'shutdown') {
      expect(run.exitCode, run.output).toBe(0);
    } else {
      expect(run.exitCode, run.output).not.toBe(0);
    }
    expect(run.loopback, run.output).toMatchObject({
      statusCode: 201,
      contentType: 'application/json',
      serverOwner: '1',
      runtimeOwner: run.owner,
      responseChecksum: 'alpha-beta',
      socket: { remotePort: 5173 }
    });
    expect(JSON.parse(run.loopback?.body ?? '{}')).toEqual({
      method: 'POST',
      url: '/loopback?source=client',
      bodyLength: 16 * 1024 + 6,
      bodySuffix: ':beta',
      clientOwner: '1'
    });
    expect(run.loopback?.socket.localPort).toBeGreaterThan(0);
    expect(run.applicationClient).toEqual({
      status: 202,
      owner: run.owner,
      bodyLength: 16 * 1024 + 6,
      bodySuffix: ':tail'
    });
    expect(run.vfsMiss).toEqual({ status: 404, body: '' });
    if (run.stopMode === 'shutdown') {
      expect(run.shutdown).toEqual({ status: 200, owner: run.owner, body: `shutdown:${run.owner}` });
      expect(run.output).toContain(`generic-http-closed ${run.owner} null`);
    } else {
      expect(run.shutdown).toBeUndefined();
      expect(run.output).not.toContain('generic-http-shutdown-finished');
    }
    if (run.stopMode === 'shutdown') expect(run.afterClose).toEqual(expect.objectContaining({ reachable: false }));
    else expect(run.afterClose).toBeUndefined();
    expect(run.output).toContain('generic-http-client-aborted');
    expect(run.output).toContain('generic-http-invalid-url ERR_INVALID_URL');
    expect(run.output).toContain('generic-http-invalid-port ERR_SOCKET_BAD_PORT');
    expect(run.output).toContain('generic-http-https-boundary ENOTSUP');
    expect(run.output).toContain('generic-http-https-server-boundary ENOTSUP');
    expect(run.output).toContain('generic-http-dns-loopback ok 127.0.0.1 4');
    expect(run.output).toContain('generic-http-dns-boundary ENOTSUP');
    expect(run.output).toContain('generic-http-tls-boundary ENOTSUP');
    expect(run.output).toContain('generic-http-http2-boundary ENOTSUP');
    expect(run.output).not.toContain('generic-http-dns-boundary unexpected-success');
    expect(run.output).not.toContain('generic-http-https-server-boundary unexpected-success');
    expect(run.output).not.toContain('generic-http-tls-boundary unexpected-success');
    expect(run.output).not.toContain('generic-http-http2-boundary unexpected-success');
    expect(run.output).not.toContain('/must-not-run');
    expect(run.output).toContain('generic-http-client-backpressure false true');
    expect(run.output).toContain('generic-http-client-drain');
    expect(run.output).toContain('generic-http-no-length-write true false');
    expect(run.output).toContain('generic-http-no-length-response received:16390');
    expect(run.output).toContain('generic-http-truncated-error ERR_STREAM_PREMATURE_CLOSE');
    expect(run.output).toContain('generic-http-truncated-aborted false');
    expect(run.output).toContain('generic-http-malformed-status HPE_INVALID_STATUS');
    expect(run.output).toContain('generic-http-malformed-chunk HPE_INVALID_CHUNK_SIZE');
    expect(run.output).toContain('generic-http-request-error /truncated-request ERR_STREAM_PREMATURE_CLOSE');
    expect(run.output).toContain('generic-http-request-aborted /truncated-request false');
    for (const name of ['nondigit', 'negative', 'fractional', 'unsafe']) {
      expect(run.output).toContain(`generic-http-invalid-length-closed ${name}`);
      expect(run.output).not.toContain(`generic-http-request ${run.owner} /invalid-length-${name}`);
    }
    expect(run.output).toContain('generic-http-server-backpressure false true');
    expect(run.output).toContain('generic-http-server-drain');
    expect(run.output).toContain('generic-http-response-resume');
    const baselinePipeListeners = {
      source: { data: 0, end: 0 },
      first: { close: 0, finish: 0, unpipe: 1 },
      second: { close: 0, finish: 0, unpipe: 1 }
    };
    const activePipeListeners = {
      source: { data: 2, end: 2 },
      first: { close: 1, finish: 1, unpipe: 2 },
      second: { close: 1, finish: 1, unpipe: 2 }
    };
    expect(run.unpipe['/one']).toEqual({
      baseline: baselinePipeListeners,
      afterPipe: activePipeListeners,
      afterUnpipe: {
        source: { data: 1, end: 1 },
        first: baselinePipeListeners.first,
        second: activePipeListeners.second
      },
      afterEnd: baselinePipeListeners,
      unpipeReturnsRequest: true,
      events: ['first:pipe', 'second:pipe', 'first:unpipe', 'second:unpipe'],
      first: { chunks: [], ended: 0 },
      second: { chunks: ['one-body'], ended: 1 }
    });
    expect(run.unpipe['/all']).toEqual({
      baseline: baselinePipeListeners,
      afterPipe: activePipeListeners,
      afterUnpipe: baselinePipeListeners,
      afterEnd: baselinePipeListeners,
      unpipeReturnsRequest: true,
      events: ['first:pipe', 'second:pipe', 'first:unpipe', 'second:unpipe'],
      first: { chunks: [], ended: 0 },
      second: { chunks: [], ended: 0 }
    });
    expect(run.output.indexOf('generic-http-response-first-data')).toBeLessThan(
      run.output.indexOf('generic-http-server-finishing')
    );
    expect(run.output).not.toContain('falling back to registered command adapter');
    expect(run.output).not.toContain('vfsPreviewFallback');
  }
  expect(result.reboot.staleRoute).toEqual(expect.objectContaining({ reachable: false }));
  expect(pageErrors).toEqual([]);
  expect(consoleErrors.length).toBeGreaterThanOrEqual(2);
  expect(consoleErrors.every((message) => message.includes('404'))).toBe(true);
});

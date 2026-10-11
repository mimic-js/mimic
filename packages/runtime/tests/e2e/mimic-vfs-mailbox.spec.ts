import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';
import {
  disposeTerminalRuntimeHostWorker,
  injectTerminalRuntimeHostFailure,
  installTerminalRuntimeHostWorker,
  TERMINAL_WORKER_FIXTURE_CHANNEL
} from './terminal-runtime-host-worker';

const synchronousVfsMailboxClaim = defineCompatibilityClaim({
  id: 'synchronous-vfs-mailboxes-and-revisioned-client-caches-v1',
  statement: 'Synchronous VFS mailboxes and revision-gated caches remain authoritative, bounded, and fail-stop',
  target: {
    kind: 'runtime-capability',
    capability: 'synchronous-vfs-mailboxes-and-revisioned-client-caches'
  }
});

test(synchronousVfsMailboxClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async () => {
    const vfs = await import('/src/runtime/modules/virtual-file-system/index.ts');
    const transport = await import('/src/runtime/modules/worker-transport/index.ts');
    const { collectWorkerMessages } = await import('/tests/fixtures/worker-message-collector.ts');
    const channel = new MessageChannel();
    const service = vfs.serveVirtualFileSystem({
      authority: { journalCapacity: 2 }
    });
    const server = transport.connectRpc(channel.port1, { fs: service.api });
    const peer = transport.connectRpc<{ fs: typeof service.api }>(channel.port2);
    await peer.remote.fs.initialize('/home/mailbox');
    const asyncClient = await vfs.createAsyncVirtualFileSystemClient(peer.remote.fs);
    const descriptor = await asyncClient.openSynchronousMailbox('cache-context', {
      payloadCapacity: 256,
      maxPayloadBytes: 64 * 1024,
      watchdogMs: 10_000
    });
    const worker = new Worker('/tests/fixtures/vfs-synchronous-client-worker.ts', { type: 'module' });
    const { waitFor } = collectWorkerMessages(worker, 'cache worker');
    worker.postMessage({ type: 'initialize', descriptor });
    await waitFor((message) => message.type === 'initialized');

    worker.postMessage({ type: 'write-read', id: 'chunked', path: '/home/mailbox/chunked.bin', size: 8_192 });
    const chunked = await waitFor((message) => message.type === 'result' && message.id === 'chunked');
    const chunkJournal = await asyncClient.readCommitJournal(
      asyncClient.revision
    );
    const asyncRevisionAfterChunk = asyncClient.revision;

    await asyncClient.writeFile('/home/mailbox/cache.txt', 'one');
    worker.postMessage({ type: 'read', id: 'cache-one', path: 'cache.txt' });
    const cacheOne = await waitFor((message) => message.type === 'result' && message.id === 'cache-one');
    worker.postMessage({ type: 'read', id: 'cache-hit', path: 'cache.txt' });
    const cacheHit = await waitFor((message) => message.type === 'result' && message.id === 'cache-hit');

    await asyncClient.writeFile('/home/mailbox/cache.txt', 'two');
    worker.postMessage({ type: 'read', id: 'cache-two', path: 'cache.txt' });
    const cacheTwo = await waitFor((message) => message.type === 'result' && message.id === 'cache-two');

    await asyncClient.writeFile('/home/mailbox/expiry-a.txt', 'a');
    await asyncClient.writeFile('/home/mailbox/expiry-b.txt', 'b');
    await asyncClient.writeFile('/home/mailbox/cache.txt', 'three');
    worker.postMessage({ type: 'read', id: 'resync', path: 'cache.txt' });
    const resync = await waitFor((message) => message.type === 'result' && message.id === 'resync');

    await asyncClient.mkdir('/outside-workdir', { recursive: true });
    await asyncClient.writeFile('/home/mailbox/alias-target.txt', 'aliased');
    await asyncClient.symlink('/home/mailbox/alias-target.txt', '/home/mailbox/alias.txt');
    worker.postMessage({ type: 'read', id: 'alias-before', path: 'alias.txt' });
    const aliasBefore = await waitFor((message) => message.type === 'result' && message.id === 'alias-before');
    await asyncClient.rename('/home/mailbox/alias-target.txt', '/outside-workdir/renamed-target.txt');
    worker.postMessage({ type: 'read', id: 'alias-after', path: 'alias.txt' });
    const aliasAfter = await waitFor((message) => message.type === 'error' && message.id === 'alias-after');

    await asyncClient.writeFile('/home/mailbox/oversized.bin', new Uint8Array(8_192).fill(0x61));
    await asyncClient.mkdir('/home/mailbox/listing', { recursive: true });
    for (let index = 0; index < 32; index += 1) {
      await asyncClient.writeFile(`/home/mailbox/listing/entry-with-a-long-name-${index}.txt`, '');
    }
    await asyncClient.writeFile('/home/mailbox/small.txt', 'small');
    const boundedDescriptor = await asyncClient.openSynchronousMailbox('bounded-response', {
      payloadCapacity: 128,
      maxPayloadBytes: 256,
      watchdogMs: 2_000
    });
    const boundedWorker = new Worker('/tests/fixtures/vfs-synchronous-client-worker.ts', { type: 'module' });
    const { waitFor: waitForBounded } = collectWorkerMessages(boundedWorker, 'bounded response worker');
    boundedWorker.postMessage({ type: 'initialize', descriptor: boundedDescriptor });
    await waitForBounded((message) => message.type === 'initialized');
    boundedWorker.postMessage({ type: 'read', id: 'oversized', path: 'oversized.bin' });
    // A file larger than one response is read in bounded slices (fbb26da1).
    const oversized = await waitForBounded((message) => message.type === 'result' && message.id === 'oversized');
    // A response that cannot be sliced still fails alone, and the mailbox stays usable.
    boundedWorker.postMessage({ type: 'readdir', id: 'oversized-listing', path: 'listing' });
    const oversizedListing = await waitForBounded(
      (message) => message.type === 'error' && message.id === 'oversized-listing'
    );
    boundedWorker.postMessage({ type: 'read', id: 'after-oversized', path: 'small.txt' });
    const afterOversized = await waitForBounded(
      (message) => message.type === 'result' && message.id === 'after-oversized'
    );

    worker.postMessage({ type: 'close' });
    boundedWorker.postMessage({ type: 'close' });
    await asyncClient.closeSynchronousMailbox('bounded-response');
    await asyncClient.closeSynchronousMailbox('cache-context');
    asyncClient.close();
    peer.close();
    server.close();
    service.dispose();
    await Promise.all([peer.closed, server.closed]);
    return { chunked, chunkJournal, asyncRevisionAfterChunk, cacheOne, cacheHit, cacheTwo, resync, aliasBefore, aliasAfter, oversized, oversizedListing, afterOversized };
  });

  expect(result.chunked).toMatchObject({ byteLength: 8_192, first: 0, last: 159 });
  expect(result.chunkJournal).toMatchObject({
    status: 'delta',
    fromRevision: 0,
    toRevision: result.chunked.revision,
    records: [{ revision: result.chunked.revision }]
  });
  expect(result.chunked.revision).toBe(result.asyncRevisionAfterChunk);
  expect(result.cacheOne).toMatchObject({ text: 'one' });
  expect(result.cacheHit.diagnostics).toMatchObject({ cacheHits: 1 });
  expect(result.cacheTwo).toMatchObject({ text: 'two' });
  expect(result.cacheTwo.diagnostics.invalidations).toBeGreaterThanOrEqual(1);
  expect(result.resync).toMatchObject({ text: 'three' });
  expect(result.resync.diagnostics).toMatchObject({ resynchronizations: 1 });
  expect(result.aliasBefore).toMatchObject({ text: 'aliased' });
  expect(result.aliasAfter).toMatchObject({ code: 'NOT_FOUND' });
  // 8 KiB through a 256-byte limit: at most 128 file bytes per slice, so at least 64 bounded round trips.
  expect(result.oversized.text).toBe('a'.repeat(8_192));
  expect(result.oversized.diagnostics.requests).toBeGreaterThanOrEqual(8_192 / 128);
  expect(result.oversizedListing).toMatchObject({ code: 'VFS_PAYLOAD_TOO_LARGE' });
  expect(result.afterOversized).toMatchObject({ text: 'small' });
  expect(pageErrors).toEqual([]);
});

test('synchronous VFS mailbox scheduling is fair and fail-stop bounded', async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async () => {
    // ADR-0029 slice 8 (77ce66e8) took the authority and the mailbox host off the
    // module's entry point; a test of the module's internals imports its files by path.
    const vfs = {
      ...(await import('/src/runtime/modules/virtual-file-system/authority.ts')),
      ...(await import('/src/runtime/modules/virtual-file-system/mailbox.ts'))
    };
    const { collectWorkerMessages } = await import('/tests/fixtures/worker-message-collector.ts');
    const authority = vfs.createVirtualFileSystemAuthority('/home/fair');
    const host = vfs.createSynchronousVirtualFileSystemMailboxHost(authority);
    const completionOrder: string[] = [];

    const createClientWorker = async (contextId: string, hostOverride = host, watchdogMs = 30_000) => {
      const descriptor = hostOverride.open(contextId, {
        payloadCapacity: 256,
        maxPayloadBytes: 512 * 1024,
        watchdogMs
      });
      const worker = new Worker('/tests/fixtures/vfs-synchronous-client-worker.ts', { type: 'module' });
      const collector = collectWorkerMessages(worker, contextId, 30_000);
      worker.addEventListener('message', (event: MessageEvent<unknown>) => {
        const message = event.data;
        if (!message || typeof message !== 'object') return;
        if (message.type === 'result') completionOrder.push(contextId);
      });
      worker.postMessage({ type: 'initialize', descriptor });
      await collector.waitFor((message) => message.type === 'initialized');
      return { descriptor, worker, waitFor: collector.waitFor };
    };

    const a = await createClientWorker('a');
    const b = await createClientWorker('b');
    // Large enough that the flood is still crossing its 256-byte mailbox when b starts.
    a.worker.postMessage({ type: 'write-read', id: 'a-flood', path: '/home/fair/a.bin', size: 384 * 1024 });
    await a.waitFor((message) => message.type === 'started' && message.id === 'a-flood');
    b.worker.postMessage({ type: 'write-read', id: 'b-small', path: '/home/fair/b.bin', size: 32 });
    const bResult = await b.waitFor((message) => message.type === 'result' && message.id === 'b-small');
    const aResult = await a.waitFor((message) => message.type === 'result' && message.id === 'a-flood');

    const stalledAuthority = vfs.createVirtualFileSystemAuthority('/home/stalled');
    const stalledHost = vfs.createSynchronousVirtualFileSystemMailboxHost(stalledAuthority, { autoSchedule: false });
    const watchdog = await createClientWorker('watchdog', stalledHost, 100);
    watchdog.worker.postMessage({ type: 'read', id: 'watchdog-read', path: '/home/stalled/missing.txt' });
    const watchdogResult = await watchdog.waitFor(
      (message) => message.type === 'error' && message.id === 'watchdog-read'
    );
    stalledHost.close('watchdog');
    const reopenedWatchdog = stalledHost.open('watchdog', { payloadCapacity: 256, watchdogMs: 1_000 });
    stalledHost.close('watchdog');

    for (const worker of [a.worker, b.worker, watchdog.worker]) worker.postMessage({ type: 'close' });
    host.dispose();
    stalledHost.dispose();
    return {
      completionOrder,
      aResult,
      bResult,
      watchdogResult,
      reopenedWatchdog: reopenedWatchdog.contextId
    };
  });

  expect(result.completionOrder).toEqual(['b', 'a']);
  expect(result.aResult).toMatchObject({ byteLength: 384 * 1024 });
  expect(result.bResult).toMatchObject({ byteLength: 32 });
  expect(result.watchdogResult).toMatchObject({ code: 'VFS_MAILBOX_TIMEOUT' });
  expect(result.reopenedWatchdog).toBe('watchdog');
  expect(pageErrors).toEqual([]);
});

test('a terminal Runtime Host failure wakes a blocked synchronous VFS caller', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => globalThis.crossOriginIsolated)).toBe(true);

  await installTerminalRuntimeHostWorker(page);
  const result = await page.evaluate(async ({ inject, channel }) => {
    const { collectWorkerMessages } = await import('/tests/fixtures/worker-message-collector.ts');
    const { bootRuntimeHost } = await import(
      '/src/runtime/modules/runtime-host/index.ts'
    );
    const runtimeHost = await bootRuntimeHost('/home/terminal-mailbox');
    const descriptor = await runtimeHost.fs.openSynchronousMailbox('terminal-context', {
      payloadCapacity: 64,
      watchdogMs: 5_000
    });
    const worker = new Worker('/tests/fixtures/vfs-synchronous-client-worker.ts', { type: 'module' });
    const { waitFor } = collectWorkerMessages(worker, 'terminal mailbox worker');
    worker.postMessage({ type: 'initialize', descriptor });
    await waitFor((message) => message.type === 'initialized');
    worker.postMessage({ type: 'read', id: 'terminal-read', path: '/home/terminal-mailbox/missing.txt' });
    const blocked = await waitFor((message) => message.type === 'started' && message.id === 'terminal-read');
    new Function('channel', `(${inject})(channel)`)(channel);
    const error = await waitFor((message) => message.type === 'error' && message.id === 'terminal-read');
    await runtimeHost.teardown().catch(() => undefined);
    worker.postMessage({ type: 'close' });
    return { blocked: blocked.type, error };
  }, { inject: injectTerminalRuntimeHostFailure.toString(), channel: TERMINAL_WORKER_FIXTURE_CHANNEL });
  await disposeTerminalRuntimeHostWorker(page);

  expect(result.blocked).toBe('started');
  expect(result.error).toMatchObject({ code: 'VFS_EPOCH_FAILED' });
});

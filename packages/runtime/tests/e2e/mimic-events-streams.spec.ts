import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const eventsAndStreamsClaim = defineCompatibilityClaim({
  id: 'node-compatibility-events-streams-v1',
  statement: 'Mimic provides Node-compatible events and stream lifecycle semantics',
  target: {
    kind: 'runtime-capability',
    capability: 'node-compatibility-events-streams'
  }
});

test(eventsAndStreamsClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/events-streams' });
    try {
      await runtime.fs.mount({
        'entry.cjs': {
          file: {
            contents: [
              "const events = require('node:events');",
              "const bareEvents = require('events');",
              "const streams = require('node:stream');",
              "const streamPromises = require('stream/promises');",
              '(async () => {',
              '  const duplicateEmitter = new events.EventEmitter();',
              '  let duplicateCalls = 0;',
              '  function duplicateListener() { duplicateCalls += 1; }',
              "  duplicateEmitter.on('message', duplicateListener);",
              "  duplicateEmitter.on('message', duplicateListener);",
              "  duplicateEmitter.removeListener('message', duplicateListener);",
              "  duplicateEmitter.emit('message');",
              '',
              '  const onceEmitter = new events.EventEmitter();',
              "  const onceResult = events.once(onceEmitter, 'ready').then(() => 'ready', (error) => error.message);",
              "  onceEmitter.emit('error', new Error('stop'));",
              '  const onceError = await onceResult;',
              "  const unhandledError = (() => { try { new events.EventEmitter().emit('error', new Error('unhandled')); return 'missed'; } catch (error) { return error.message; } })();",
              '',
              '  const bufferedReadable = new streams.Readable({ highWaterMark: 1 });',
              "  const readableAccepted = bufferedReadable.push('x');",
              '  const readableLength = bufferedReadable.readableLength;',
              '',
              '  const premature = new streams.Readable();',
              '  const prematureCode = await new Promise((resolve) => {',
              "    streams.finished(premature, (error) => resolve(error?.code ?? 'ok'));",
              '    premature.destroy();',
              '  });',
              '',
              '  const drainEvents = [];',
              '  const sink = new streams.Writable({',
              '    highWaterMark: 1,',
              "    write(_chunk, _encoding, callback) { setTimeout(() => { drainEvents.push('write'); callback(); }, 0); }",
              '  });',
              "  sink.on('drain', () => drainEvents.push('drain'));",
              "  const writeAccepted = sink.write('payload');",
              '  const needDrainAfterWrite = sink.writableNeedDrain;',
              '  sink.end();',
              '  await streamPromises.finished(sink);',
              '',
              '  const destroyEvents = [];',
              '  class FailingTransform extends streams.Transform {',
              "    _transform(_chunk, _encoding, callback) { destroyEvents.push('transform'); callback(new Error('transform failed')); }",
              "    _destroy(error, callback) { setTimeout(() => { destroyEvents.push(`transform-destroy:${error?.message}`); callback(); }, 0); }",
              '  }',
              '  class DestroyAwareWritable extends streams.Writable {',
              "    _write(_chunk, _encoding, callback) { callback(); }",
              "    _destroy(error, callback) { setTimeout(() => { destroyEvents.push(`sink-destroy:${error?.message}`); callback(); }, 0); }",
              '  }',
              "  const pipelineError = await streamPromises.pipeline(streams.Readable.from(['body']), new FailingTransform(), new DestroyAwareWritable()).then(() => 'ok', (error) => error.message);",
              '',
              '  const transformStarts = [];',
              '  const transformReleases = [];',
              '  const queuedTransform = new streams.Transform({',
              '    highWaterMark: 1,',
              '    transform(chunk, _encoding, callback) { transformStarts.push(String(chunk)); transformReleases.push(() => callback(null, chunk)); }',
              '  });',
              '  queuedTransform.resume();',
              "  const firstTransformAccepted = queuedTransform.write('first');",
              "  const secondTransformAccepted = queuedTransform.write('second');",
              '  const startsBeforeRelease = [...transformStarts];',
              '  transformReleases.shift()();',
              '  await new Promise((resolve) => setTimeout(resolve, 0));',
              '  const startsAfterRelease = [...transformStarts];',
              '  transformReleases.shift()();',
              '  queuedTransform.end();',
              '  await streamPromises.finished(queuedTransform, { readable: false });',
              '',
              '  console.log(JSON.stringify({',
              '    importIdentity: events === bareEvents && streams.pipeline === require("stream").pipeline,',
              '    duplicateCalls,',
              '    onceError,',
              '    unhandledError,',
              "    onceListeners: [onceEmitter.listenerCount('ready'), onceEmitter.listenerCount('error')],",
              '    readableAccepted,',
              '    readableLength,',
              '    prematureCode,',
              '    writeAccepted,',
              '    needDrainAfterWrite,',
              '    drainEvents,',
              '    writableState: [sink.writableEnded, sink.writableFinished, sink.writableLength, sink.writableNeedDrain],',
              '    pipelineError,',
              '    destroyEvents,',
              '    firstTransformAccepted,',
              '    secondTransformAccepted,',
              '    startsBeforeRelease,',
              '    startsAfterRelease',
              '  }));',
              '})().catch((error) => { console.error(error); process.exitCode = 1; });'
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/events-streams/entry.cjs']);
      const output = await collectOutput(mergeProcessOutput(process));
      return { exitCode: await process.exit, output };
    } finally {
      await runtime.teardown();
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
      }
    }
  });

  expect(result.exitCode, result.output).toBe(0);
  expect(JSON.parse(result.output.trim().split('\n').at(-1) ?? '')).toEqual({
    importIdentity: true,
    duplicateCalls: 1,
    onceError: 'stop',
    unhandledError: 'unhandled',
    onceListeners: [0, 0],
    readableAccepted: false,
    readableLength: 1,
    prematureCode: 'ERR_STREAM_PREMATURE_CLOSE',
    writeAccepted: false,
    needDrainAfterWrite: true,
    // Node emits no `drain` for a write that completes once the stream is ending.
    drainEvents: ['write'],
    writableState: [true, true, 0, false],
    pipelineError: 'transform failed',
    destroyEvents: ['transform', 'transform-destroy:transform failed', 'sink-destroy:transform failed'],
    firstTransformAccepted: false,
    secondTransformAccepted: false,
    startsBeforeRelease: ['first'],
    startsAfterRelease: ['first', 'second']
  });
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

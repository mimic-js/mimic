import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const committedVfsWatchClaim = defineCompatibilityClaim({
  id: 'vfs-recursive-committed-watches-v1',
  statement:
    'Mimic delivers revision-ordered recursive committed VFS watches to mounted Node entries',
  target: {
    kind: 'runtime-capability',
    capability: 'vfs-recursive-committed-watches'
  }
});

test(committedVfsWatchClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const runtime = await Mimic.boot({ workdir: '/home/vfs-committed-watches' });
    const root = `${runtime.workdir}/watched`;
    let watched:
      | {
          readonly exitCode: number;
          readonly transcript: {
            readonly type: string;
            readonly transcript: ReadonlyArray<{ readonly event: string; readonly filename: string }>;
          };
        }
      | undefined;

    try {
      await runtime.fs.mount({
        watched: {
          directory: {
            'seed.txt': { file: { contents: 'before' } }
          }
        },
        'watch-entry.cjs': {
          file: {
            contents: [
              "const fs = require('node:fs');",
              'const root = process.argv[2];',
              'const expectedEventCount = 6;',
              'const transcript = [];',
              'const watcher = fs.watch(root, { recursive: true }, (event, filename) => {',
              '  transcript.push({ event, filename: String(filename) });',
              '  if (transcript.length !== expectedEventCount) return;',
              '  watcher.close();',
              "  console.log(JSON.stringify({ type: 'complete', transcript }));",
              '});',
              "console.log(JSON.stringify({ type: 'ready' }));"
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', [`${runtime.workdir}/watch-entry.cjs`, root], {
        cwd: runtime.workdir
      });
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      const output = readProcessOutput(mergeProcessOutput(process), (text) => {
        if (text.includes('"type":"ready"')) resolveReady();
      });
      void output.then((text) => {
        if (!text.includes('"type":"ready"')) {
          rejectReady(new Error('Watch process exited before it reported readiness.'));
        }
      });
      await ready;

      await runtime.fs.writeFile(`${root}/seed.txt`, 'after');
      await runtime.fs.mkdir(`${root}/nested`, { recursive: true });
      await runtime.fs.writeFile(`${root}/nested/created.txt`, 'created');
      await runtime.fs.rename(`${root}/seed.txt`, `${root}/renamed.txt`);
      await runtime.fs.rm(`${root}/renamed.txt`);

      const exitCode = await process.exit;
      const transcript = JSON.parse((await output).trim().split('\n').at(-1) ?? '') as {
        readonly type: string;
        readonly transcript: ReadonlyArray<{ readonly event: string; readonly filename: string }>;
      };

      watched = { exitCode, transcript };
    } finally {
      await runtime.teardown();
    }

    if (!watched) throw new Error('The committed watch witness did not produce a result.');

    const rebooted = await Mimic.boot({ workdir: '/home/vfs-committed-watches-reboot' });
    try {
      await rebooted.fs.mount({
        'reboot-entry.cjs': { file: { contents: "console.log('clean-reboot');" } }
      });
      const process = await rebooted.spawn('node', [`${rebooted.workdir}/reboot-entry.cjs`], {
        cwd: rebooted.workdir
      });
      const output = readProcessOutput(mergeProcessOutput(process));
      const exitCode = await process.exit;
      return { ...watched, reboot: { exitCode, output: (await output).trim() } };
    } finally {
      await rebooted.teardown();
    }

    async function readProcessOutput(
      output: ReadableStream<Uint8Array>,
      onText?: (text: string) => void
    ): Promise<string> {
      const reader = output.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) return text;
        text += decoder.decode(value, { stream: true });
        onText?.(text);
      }
    }
  });

  expect(result.exitCode).toBe(0);
  expect(result.transcript).toEqual({
    type: 'complete',
    transcript: [
      { event: 'change', filename: 'seed.txt' },
      { event: 'rename', filename: 'nested' },
      { event: 'rename', filename: 'nested/created.txt' },
      { event: 'rename', filename: 'seed.txt' },
      { event: 'rename', filename: 'renamed.txt' },
      { event: 'rename', filename: 'renamed.txt' }
    ]
  });
  expect(result.reboot).toEqual({ exitCode: 0, output: 'clean-reboot' });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

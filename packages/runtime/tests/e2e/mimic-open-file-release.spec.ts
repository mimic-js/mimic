import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const openFileReleaseClaim = defineCompatibilityClaim({
  id: 'open-file-descriptions-released-with-process-v1',
  statement:
    'The Open File Descriptions of a Runtime Process are closed when the process ends, whether it exits or is killed with files open',
  target: {
    kind: 'runtime-capability',
    capability: 'open-file-description-release'
  }
});

test(openFileReleaseClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated)).toBe(true);

  const result = await page.evaluate(async (holderSource) => {
    const { bootRuntimeHost } = await import('/src/runtime/modules/runtime-host/index.ts');
    const workdir = '/home/open-file-release';
    const host = await bootRuntimeHost(workdir);
    const readOnly = { append: false, readable: true, writable: false };
    try {
      await host.fs.writeFile(`${workdir}/holder.mjs`, holderSource);

      const runHolder = async (run: string, end: 'SIGKILL' | 'exit') => {
        await host.fs.writeFile(`${workdir}/kept-${run}.txt`, `kept-${run}`);
        await host.fs.writeFile(`${workdir}/unlinked-${run}.txt`, `unlinked-${run}`);
        // Description ids are issued in order, so the ones after this probe
        // belong to whatever opens files next.
        const probe = await host.fs.openFile(`${workdir}/kept-${run}.txt`, readOnly);
        await host.fs.closeFile(probe);
        const candidates = Array.from({ length: 16 }, (_unused, index) => probe + 1 + index);
        const heldContents = async () => {
          const contents: string[] = [];
          for (const id of candidates) {
            try {
              contents.push(new TextDecoder().decode(await host.fs.readOpenFile(id, 64, 0)));
            } catch (error) {
              if ((error as { code?: string }).code !== 'BAD_FILE_DESCRIPTOR') throw error;
            }
          }
          return contents.sort();
        };

        const holder = await host.spawn({
          command: 'node',
          args: [`${workdir}/holder.mjs`, run, end],
          cwd: workdir,
          env: {},
          parentPid: 0
        });
        let output = '';
        const reader = holder.output.getReader();
        const decoder = new TextDecoder();
        while (!output.includes(`holding:${run}`)) {
          const { done, value } = await reader.read();
          if (done) throw new Error(`The holder ended before holding its files:\n${output}`);
          output += decoder.decode(value, { stream: true });
        }
        const whileRunning = await heldContents();
        const unlinkedPathGone = !(await host.fs.exists(`${workdir}/unlinked-${run}.txt`));
        if (end === 'SIGKILL') holder.kill('SIGKILL');
        else await holder.input.getWriter().write(new TextEncoder().encode('exit\n'));
        const exitCode = await holder.exit;
        return { whileRunning, unlinkedPathGone, exitCode, afterEnd: await heldContents() };
      };

      return {
        killed: await runHolder('killed', 'SIGKILL'),
        exited: await runHolder('exited', 'exit')
      };
    } finally {
      await host.teardown();
    }
  }, holderSource);

  for (const [run, exitCode] of [
    ['killed', 137],
    ['exited', 0]
  ] as const) {
    expect(result[run], run).toEqual({
      // Synchronously opened, synchronously opened then unlinked, and opened through a promise.
      whileRunning: [`kept-${run}`, `kept-${run}`, `unlinked-${run}`],
      unlinkedPathGone: true,
      exitCode,
      afterEnd: []
    });
  }
});

const holderSource = [
  "import fs from 'node:fs';",
  '',
  'const [run] = process.argv.slice(2);',
  'const kept = fs.openSync(`kept-${run}.txt`, "r");',
  'const unlinked = fs.openSync(`unlinked-${run}.txt`, "r+");',
  'fs.unlinkSync(`unlinked-${run}.txt`);',
  'const handle = await fs.promises.open(`kept-${run}.txt`, "r");',
  'globalThis.held = [kept, unlinked, handle];',
  'console.log(`holding:${run}`);',
  "process.stdin.on('data', () => process.exit(0));",
  'setInterval(() => undefined, 1_000);'
].join('\n');

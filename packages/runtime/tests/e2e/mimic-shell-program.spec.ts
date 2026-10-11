import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const shellProgramClaim = defineCompatibilityClaim({
  id: 'process-execution-shell-program-v1',
  statement:
    'Mimic runs a shell Runtime Program with quote-aware expansion, binary pipelines, VFS redirection, subshell isolation, and process exit semantics',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-shell-program'
  }
});

test(shellProgramClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const decoder = new TextDecoder();
    const runtime = await Mimic.boot({ workdir: '/home/shell-program' });

    try {
      await runtime.fs.mount({
        'status.mjs': {
          file: {
            contents: 'process.exit(Number(process.argv[2] ?? 0));\n'
          }
        },
        'producer.mjs': {
          file: {
            contents: [
              "const header = JSON.stringify({ quoted: process.argv[2], braced: process.argv[3], previousStatus: process.argv[4], literal: process.argv[5], pid: process.pid, ppid: process.ppid });",
              "process.stdout.write(header + '\\n');",
              'process.stdout.write(new Uint8Array([0, 255, 128, 10]));'
            ].join('\n')
          }
        },
        'consumer.mjs': {
          file: {
            contents: [
              'const chunks = [];',
              'for await (const chunk of process.stdin) chunks.push(chunk);',
              'const size = chunks.reduce((total, chunk) => total + chunk.length, 0);',
              'const bytes = new Uint8Array(size);',
              'let offset = 0;',
              'for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }',
              'const newline = bytes.indexOf(10);',
              'const header = JSON.parse(new TextDecoder().decode(bytes.slice(0, newline)));',
              'console.log(JSON.stringify({ kind: "pipeline", header, payload: [...bytes.slice(newline + 1)], pid: process.pid, ppid: process.ppid }));'
            ].join('\n')
          }
        },
        'snapshot.mjs': {
          file: {
            contents:
              'console.log(JSON.stringify({ kind: "snapshot", value: process.argv[2], declaredShellPid: Number(process.argv[3]), pid: process.pid, ppid: process.ppid }));\n'
          }
        },
        'read-stdin.mjs': {
          file: {
            contents:
              'const chunks = []; for await (const chunk of process.stdin) chunks.push(chunk); console.log(JSON.stringify({ kind: "subshell-input", value: Buffer.concat(chunks).toString("utf8"), pid: process.pid, ppid: process.ppid }));\n'
          }
        },
        'input.txt': {
          file: {
            contents: 'redirected subshell input'
          }
        }
      });

      const run = async (command: string, args: string[], env: Record<string, string> = {}) => {
        const process = await runtime.spawn(command, args, { cwd: runtime.workdir, env });
        const output = collectOutput(process.output);
        const stderr = collectOutput(process.stderr);
        const exitCode = await process.exit;
        return { pid: process.pid, exitCode, output: await output, stderr: await stderr };
      };

      const shell = await run(
        'sh',
        [
          '-c',
          [
            'node status.mjs 7;',
            'node producer.mjs "$VALUE" "${VALUE}" "$?" \'$VALUE\' | node consumer.mjs > result.ndjson;',
            '( VALUE=inner; node snapshot.mjs "$VALUE" "$$" >> result.ndjson );',
            '( node read-stdin.mjs ) < input.txt >> result.ndjson;',
            'OUT=assigned.ndjson node snapshot.mjs "$OUT" "$$" > "$OUT";',
            'node snapshot.mjs "$VALUE" "$$" >> result.ndjson;',
            'exit 23'
          ].join(' ')
        ],
        { VALUE: 'outer value' }
      );
      const redirected = await runtime.fs.readFile(`${runtime.workdir}/result.ndjson`, 'utf8');
      const assignedRedirect = await runtime.fs.readFile(`${runtime.workdir}/assigned.ndjson`, 'utf8');
      const lastStatus = await run('/bin/sh', ['-c', 'node status.mjs 19']);

      return { shell, redirected, assignedRedirect, lastStatus };
    } finally {
      await runtime.teardown();
    }

    async function collectOutput(output: ReadableStream<Uint8Array>): Promise<string> {
      const reader = output.getReader();
      let text = '';
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) return text + decoder.decode();
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }
  });

  expect(result.shell.exitCode, result.shell.stderr).toBe(23);
  expect(result.lastStatus.exitCode, result.lastStatus.stderr).toBe(19);
  expect(result.shell.output).toBe('');
  expect(result.lastStatus.output).toBe('');

  const [pipeline, subshellSnapshot, subshellInput, outerSnapshot] = result.redirected
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const assignedSnapshot = JSON.parse(result.assignedRedirect) as Record<string, unknown>;
  expect(pipeline).toMatchObject({
    kind: 'pipeline',
    header: {
      quoted: 'outer value',
      braced: 'outer value',
      previousStatus: '7',
      literal: '$VALUE',
      ppid: result.shell.pid
    },
    payload: [0, 255, 128, 10],
    ppid: result.shell.pid
  });
  expect(subshellSnapshot).toMatchObject({ kind: 'snapshot', value: 'inner' });
  expect(subshellInput).toMatchObject({
    kind: 'subshell-input',
    value: 'redirected subshell input'
  });
  expect(assignedSnapshot).toMatchObject({
    kind: 'snapshot',
    value: 'assigned.ndjson'
  });
  expect(outerSnapshot).toMatchObject({
    kind: 'snapshot',
    value: 'outer value',
    declaredShellPid: result.shell.pid,
    ppid: result.shell.pid
  });

  const pipelineHeader = pipeline.header as Record<string, unknown>;
  const childPids = [
    pipelineHeader.pid,
    pipeline.pid,
    subshellSnapshot.pid,
    subshellInput.pid,
    assignedSnapshot.pid,
    outerSnapshot.pid
  ].map((value) => Number(value));
  expect(childPids.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
  expect(new Set(childPids).size).toBe(childPids.length);
  expect(childPids).not.toContain(result.shell.pid);
  expect(subshellSnapshot.declaredShellPid).toBe(subshellSnapshot.ppid);
  expect(subshellSnapshot.ppid).not.toBe(result.shell.pid);

  const evidence = [
    result.shell.output,
    result.shell.stderr,
    result.lastStatus.output,
    result.lastStatus.stderr,
    result.redirected,
    ...consoleErrors,
    ...pageErrors
  ].join('\n');
  for (const forbidden of [
    'falling back to registered command adapter',
    'esm.sh',
    'host Node',
    'vfsPreviewFallback',
    'shell-lite',
    'sh-lite',
    'SHLITE_STDIN'
  ]) {
    expect(evidence, `forbidden fallback ${forbidden}`).not.toContain(forbidden);
  }
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);

  const rebooted = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/shell-program-reboot' });
    try {
      const process = await runtime.spawn('/bin/sh', ['-c', 'exit 0']);
      const exitCode = await process.exit;
      return { exitCode };
    } finally {
      await runtime.teardown();
    }
  });
  expect(rebooted.exitCode).toBe(0);
});

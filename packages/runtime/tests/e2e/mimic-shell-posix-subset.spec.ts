import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const shellProgramClaim = defineCompatibilityClaim({
  id: 'process-execution-shell-program-posix-subset-v1',
  statement:
    'Mimic runs common package script lines through the Shell Program: file and directory commands, status 127 for unknown commands, descriptor redirection, background jobs, command substitution, and node or sh shebang scripts',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-shell-program-posix-subset'
  }
});

test(shellProgramClaim.statement, async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));

  await page.goto('/mimic-test-host.html', { waitUntil: 'domcontentloaded' });
  await expect.poll(() => page.evaluate(() => window.crossOriginIsolated), { timeout: 10_000 }).toBe(true);

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const { mergeProcessOutput } = await import('/tests/e2e/process-output.ts');
    const decoder = new TextDecoder();
    const runtime = await Mimic.boot({ workdir: '/home/shell-program' });
    const root = runtime.workdir;
    try {
      await runtime.fs.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'shell-program',
              private: true,
              scripts: {
                build: 'rm -rf dist && node build.mjs',
                nested: 'cd app && node ../where.mjs',
                out: 'mkdir -p out/deep && ls out',
                tolerant: 'node fail.mjs || true',
                grep: 'cat a.txt | node grep.mjs b',
                exported: 'export X=1 && node env.mjs'
              }
            })
          }
        },
        'build.mjs': {
          file: {
            contents:
              "import fs from 'node:fs';\nconsole.log('stale=' + fs.existsSync('dist/stale.js'));\nfs.mkdirSync('dist');\nfs.writeFileSync('dist/index.js', '');\n"
          }
        },
        'where.mjs': { file: { contents: "console.log('cwd=' + process.cwd());\n" } },
        'fail.mjs': { file: { contents: "console.error('failing');\nprocess.exit(3);\n" } },
        'grep.mjs': {
          file: {
            contents:
              "let text = '';\nprocess.stdin.on('data', (chunk) => { text += chunk; });\nprocess.stdin.on('end', () => {\n  for (const line of text.split('\\n')) if (line.includes(process.argv[2])) console.log(line);\n});\n"
          }
        },
        'env.mjs': { file: { contents: "console.log('X=' + process.env.X);\n" } },
        'both.mjs': { file: { contents: "console.log('to-stdout');\nconsole.error('to-stderr');\n" } },
        'slow.mjs': { file: { contents: "setTimeout(() => console.log('background-done'), 300);\n" } },
        'a.txt': { file: { contents: 'alpha\nbeta\nbravo\n' } },
        app: { directory: {} },
        dist: { directory: { 'stale.js': { file: { contents: '' } } } },
        src: {
          directory: {
            'one.ts': { file: { contents: '' } },
            'two.ts': { file: { contents: '' } },
            'three.js': { file: { contents: '' } }
          }
        },
        scripts: {
          directory: {
            'steps.sh': {
              file: {
                contents:
                  '# a multi-line script\nif [ -f package.json ]; then\n  echo "steps $1 $#"\nfi\nfor name in a b; do echo "item $name"; done\n'
              }
            },
            'env-split': {
              file: {
                contents:
                  "#!/usr/bin/env -S node --no-warnings\nconsole.log(['env-split', process.execArgv.join(','), process.argv.slice(2).join(',')].join('|'));\n"
              }
            },
            'local-node': {
              file: {
                contents:
                  "#!/usr/local/bin/node --no-deprecation\nconsole.log(['local-node', process.execArgv.join(','), process.argv.slice(2).join(',')].join('|'));\n"
              }
            },
            'posix-sh': {
              file: { contents: '#!/bin/sh\nset -e\ngreeting="posix-sh $1"\necho "$greeting"\nnode where.mjs\n' }
            },
            'env-bash': { file: { contents: '#!/usr/bin/env bash\necho "env-bash $@"\n' } },
            'child.mjs': {
              file: {
                contents: [
                  "import { spawn, spawnSync, execFileSync } from 'node:child_process';",
                  "const flat = (text) => String(text).trim().replace(/\\n/g, ',');",
                  "const sync = spawnSync('sh', ['-c', 'mkdir -p made/by-child && ls made && nope; echo status=$?'], { encoding: 'utf8' });",
                  "console.log('sync=' + sync.status + ':' + flat(sync.stdout) + ':' + flat(sync.stderr));",
                  "console.log('shebang=' + flat(execFileSync('/home/shell-program/scripts/env-bash', ['x'], { encoding: 'utf8' })));",
                  "const child = spawn('sh', ['-c', 'cat a.txt | cat > copy.txt; cat copy.txt; rm copy.txt; ls copy.txt']);",
                  "let stdout = '';",
                  "let stderr = '';",
                  "child.stdout.on('data', (chunk) => { stdout += chunk; });",
                  "child.stderr.on('data', (chunk) => { stderr += chunk; });",
                  "child.on('close', (code) => console.log('async=' + code + ':' + flat(stdout) + ':' + flat(stderr)));"
                ].join('\n')
              }
            }
          }
        }
      });

      const scripts: Record<string, { exitCode: number; output: string }> = {};
      for (const script of ['build', 'nested', 'out', 'tolerant', 'grep', 'exported']) {
        scripts[script] = await run('npm', ['run', '--silent', script]);
      }
      return {
        scripts,
        distEntries: ((await runtime.fs.readdir(`${root}/dist`)) as string[]).sort(),
        unknown: await run('sh', ['-c', 'nope --flag; echo "status=$?"; nope || echo recovered']),
        unknownStatus: await run('sh', ['-c', 'nope']),
        echo: await run('sh', ['-c', "echo -n one; echo -e '\\ttwo'"]),
        merged: await run('sh', ['-c', 'node both.mjs > log.txt 2>&1; echo after']),
        mergedLog: (await runtime.fs.readFile(`${root}/log.txt`, 'utf8')).split('\n').filter(Boolean).sort(),
        discarded: await run('sh', ['-c', 'node both.mjs 2>/dev/null']),
        toStderr: await run('sh', ['-c', 'echo problem 2>/dev/null >&2; echo fine']),
        strayFiles: ((await runtime.fs.readdir(root)) as string[]).filter((name) => /^&|^2$|null/.test(name)),
        background: await run('sh', ['-c', 'node slow.mjs & echo started; wait; echo waited']),
        substitution: await run('sh', ['-c', 'echo "sum=$(node -p "1 + 1") files=$(ls src | cat)" ${MISSING:-fallback}']),
        globs: await run('sh', ['-c', 'echo src/*.ts "src/*.ts" *.none']),
        quoting: await run('sh', ['-c', `node -e "console.log(JSON.stringify('a\\n'))"`]),
        scriptFile: await run('sh', ['scripts/steps.sh', 'arg']),
        envSplit: await run(`${root}/scripts/env-split`, ['a']),
        localNode: await run(`${root}/scripts/local-node`, ['b']),
        posixSh: await run(`${root}/scripts/posix-sh`, ['c']),
        envBash: await run(`${root}/scripts/env-bash`, ['d', 'e']),
        unsupported: await run('sh', ['-c', 'cat <<EOF\nbody\nEOF']),
        which: await run('sh', ['-c', 'which node rm; env -i ONLY=1']),
        child: await run('node', ['scripts/child.mjs']),
        madeByChild: await runtime.fs.readdir(`${root}/made`).then(
          (entries) => (entries as string[]).sort(),
          () => []
        )
      };
    } finally {
      await runtime.teardown();
    }

    async function run(command: string, args: string[]): Promise<{ exitCode: number; output: string }> {
      const process = await runtime.spawn(command, args, { cwd: root });
      const output = collectOutput(mergeProcessOutput(process));
      const exitCode = await process.exit;
      return { exitCode, output: await output };
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

  expect(pageErrors).toEqual([]);

  // #645: the package script lines the issue lists.
  expect(result.scripts.build).toEqual({ exitCode: 0, output: 'stale=false\n' });
  expect(result.distEntries).toEqual(['index.js']);
  expect(result.scripts.nested).toEqual({ exitCode: 0, output: 'cwd=/home/shell-program/app\n' });
  expect(result.scripts.out).toEqual({ exitCode: 0, output: 'deep\n' });
  expect(result.scripts.tolerant).toEqual({ exitCode: 0, output: 'failing\n' });
  expect(result.scripts.grep).toEqual({ exitCode: 0, output: 'beta\nbravo\n' });
  expect(result.scripts.exported).toEqual({ exitCode: 0, output: 'X=1\n' });
  expect(result.unknown.exitCode).toBe(0);
  expect(result.unknown.output).toBe(
    'sh: nope: command not found\nstatus=127\nsh: nope: command not found\nrecovered\n'
  );
  expect(result.unknownStatus).toEqual({ exitCode: 127, output: 'sh: nope: command not found\n' });
  expect(result.echo).toEqual({ exitCode: 0, output: 'one\ttwo\n' });
  expect(result.which).toEqual({ exitCode: 0, output: '/usr/bin/node\n/bin/rm\nONLY=1\n' });

  // #646: descriptor redirection, background jobs, substitution, globs, quoting, script files.
  expect(result.mergedLog).toEqual(['to-stderr', 'to-stdout']);
  expect(result.merged).toEqual({ exitCode: 0, output: 'after\n' });
  expect(result.discarded).toEqual({ exitCode: 0, output: 'to-stdout\n' });
  expect(result.toStderr).toEqual({ exitCode: 0, output: 'fine\n' });
  expect(result.strayFiles).toEqual([]);
  expect(result.background).toEqual({ exitCode: 0, output: 'started\nbackground-done\nwaited\n' });
  expect(result.substitution).toEqual({
    exitCode: 0,
    output: 'sum=2 files=one.ts\nthree.js\ntwo.ts fallback\n'
  });
  expect(result.globs).toEqual({ exitCode: 0, output: 'src/one.ts src/two.ts src/*.ts *.none\n' });
  expect(result.quoting).toEqual({ exitCode: 0, output: '"a\\n"\n' });
  expect(result.scriptFile).toEqual({ exitCode: 0, output: 'steps arg 1\nitem a\nitem b\n' });
  expect(result.unsupported.exitCode).toBe(2);
  expect(result.unsupported.output).toContain('sh: syntax error: here-documents (<<) are not supported');

  // #647: shebang forms.
  expect(result.envSplit).toEqual({ exitCode: 0, output: 'env-split|--no-warnings|a\n' });
  expect(result.localNode).toEqual({ exitCode: 0, output: 'local-node|--no-deprecation|b\n' });
  expect(result.posixSh).toEqual({ exitCode: 0, output: 'posix-sh c\ncwd=/home/shell-program\n' });
  expect(result.envBash).toEqual({ exitCode: 0, output: 'env-bash d e\n' });

  // The same commands through child_process inside a node Runtime Process.
  expect(result.child.exitCode).toBe(0);
  expect(result.child.output).toBe(
    [
      'sync=0:by-child,status=127:sh: nope: command not found',
      'shebang=env-bash x',
      "async=2:alpha,beta,bravo:ls: cannot access 'copy.txt': No such file or directory",
      ''
    ].join('\n')
  );
  expect(result.madeByChild).toEqual(['by-child']);
});

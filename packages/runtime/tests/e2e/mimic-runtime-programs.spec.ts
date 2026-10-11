import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const runtimeProgramsClaim = defineCompatibilityClaim({
  id: 'process-execution-runtime-program-resolution-v1',
  statement:
    'Mimic dispatches the Runtime Host-owned echo Runtime Program plus project scripts and installed package bins through PATH, JavaScript shebangs, POSIX exec wrappers, and immutable inline Node entries',
  target: {
    kind: 'runtime-capability',
    capability: 'process-execution-runtime-program-resolution'
  }
});

test(runtimeProgramsClaim.statement, async ({ page }) => {
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
    const runtime = await Mimic.boot({ workdir: '/home/runtime-programs' });
    const cwd = `${runtime.workdir}/nested`;
    const env = { PROGRAM_ENV: 'present' };

    let initial: {
      echo: {
        exitCode: number;
        output: string;
      };
      bin: { exitCode: number; output: string };
      script: { exitCode: number; output: string };
      exec: { exitCode: number; output: string };
      npx: { exitCode: number; output: string };
      shebang: { exitCode: number; output: string };
      wrapper: { exitCode: number; output: string };
      inline: { exitCode: number; output: string };
      inlineDirectoryEntries: string[];
      dependencyStateBefore: {
        manifest: string;
        lockfile: string;
        nodeModules: Record<string, string | string[]>;
      };
      dependencyStateAfter: {
        manifest: string;
        lockfile: string;
        nodeModules: Record<string, string | string[]>;
      };
    };
    try {
      await runtime.fs.mount({
        'package.json': {
          file: {
            contents: JSON.stringify({
              name: 'runtime-programs',
              version: '1.0.0',
              scripts: { verify: 'packet-program script-arg' }
            })
          }
        },
        'package-lock.json': {
          file: {
            contents: JSON.stringify({
              name: 'runtime-programs',
              version: '1.0.0',
              lockfileVersion: 3,
              packages: {
                '': { name: 'runtime-programs', version: '1.0.0' },
                'node_modules/packet-program': { name: 'packet-program', version: '1.0.0' }
              }
            })
          }
        },
        nested: { directory: {} },
        node_modules: {
          directory: {
            '.bin': {
              directory: {
                'packet-program': {
                  symlink: { target: '../packet-program/bin/packet-program.mjs' }
                }
              }
            },
            'packet-program': {
              directory: {
                'package.json': {
                  file: {
                    contents: JSON.stringify({
                      name: 'packet-program',
                      version: '1.0.0',
                      type: 'module',
                      bin: { 'packet-program': 'bin/packet-program.mjs' }
                    })
                  }
                },
                bin: {
                  directory: {
                    'packet-program.mjs': {
                      file: {
                        contents:
                          "console.log(['bin', process.cwd(), process.env.PROGRAM_ENV, process.argv.slice(1).join(','), process.pid, process.ppid].join('|'));"
                      }
                    }
                  }
                }
              }
            }
          }
        },
        scripts: {
          directory: {
            'direct.mjs': {
              file: {
                contents:
                  "#!/usr/bin/env node\nconsole.log(['shebang', process.cwd(), process.env.PROGRAM_ENV, process.argv.slice(1).join(','), process.pid, process.ppid].join('|'));"
              }
            },
            wrapped: {
              file: {
                contents: '#!/bin/sh\nexec "/usr/bin/node" \'/home/runtime-programs/scripts/wrapped.mjs\' "$@"\n'
              }
            },
            'wrapped.mjs': {
              file: {
                contents:
                  "console.log(['wrapper', process.cwd(), process.env.PROGRAM_ENV, process.argv.slice(1).join(','), process.pid, process.ppid].join('|'));"
              }
            }
          }
        }
      });

      const dependencyStateBefore = await dependencyState();
      const echo = await run('echo', ['runtime-dispatch']);
      const bin = await run('packet-program', ['bin-arg']);
      const script = await run('npm', ['run', 'verify'], runtime.workdir);
      const exec = await run('npm', ['exec', 'packet-program', 'exec-arg'], runtime.workdir);
      const npx = await run('npx', ['packet-program', 'npx-arg'], runtime.workdir);
      const shebang = await run(`${runtime.workdir}/scripts/direct.mjs`, ['shebang-arg']);
      const wrapper = await run(`${runtime.workdir}/scripts/wrapped`, ['wrapper-arg']);
      const inline = await run('node', [
        '-e',
        [
          "const path = require('node:path');",
          "const fs = require('node:fs');",
          "let immutable = 'missing';",
          "try { fs.writeFileSync(__filename, 'replacement'); } catch (error) { immutable = error.code; }",
          "console.log(['inline', process.cwd(), process.env.PROGRAM_ENV, process.argv.slice(1).join(','), path.join('inline', 'entry'), immutable, process.pid, process.ppid].join('|'));"
        ].join('\n'),
        'inline-arg'
      ]);
      const inlineDirectoryEntries = (await runtime.fs.readdir(cwd)) as string[];
      const dependencyStateAfter = await dependencyState();

      initial = {
        echo,
        bin,
        script,
        exec,
        npx,
        shebang,
        wrapper,
        inline,
        inlineDirectoryEntries,
        dependencyStateBefore,
        dependencyStateAfter
      };
    } finally {
      await runtime.teardown();
    }

    const rebooted = await Mimic.boot({ workdir: '/home/runtime-programs-reboot' });
    try {
      const process = await rebooted.spawn('echo', ['runtime-reboot']);
      const output = collectOutput(process.output);
      const exitCode = await process.exit;
      return {
        ...initial!,
        reboot: {
          exitCode,
          output: await output
        }
      };
    } finally {
      await rebooted.teardown();
    }

    async function run(
      command: string,
      args: string[],
      commandCwd = cwd
    ): Promise<{
      exitCode: number;
      output: string;
    }> {
      const process = await runtime.spawn(command, args, { cwd: commandCwd, env });
      const output = collectOutput(process.output);
      const exitCode = await process.exit;
      return {
        exitCode,
        output: await output
      };
    }

    async function dependencyState(): Promise<{
      manifest: string;
      lockfile: string;
      nodeModules: Record<string, string | string[]>;
    }> {
      const root = runtime.workdir;
      return {
        manifest: await runtime.fs.readFile(`${root}/package.json`, 'utf8'),
        lockfile: await runtime.fs.readFile(`${root}/package-lock.json`, 'utf8'),
        nodeModules: {
          entries: ((await runtime.fs.readdir(`${root}/node_modules`)) as string[]).sort(),
          bin: await runtime.fs.readFile(`${root}/node_modules/.bin/packet-program`, 'utf8'),
          manifest: await runtime.fs.readFile(`${root}/node_modules/packet-program/package.json`, 'utf8'),
          entry: await runtime.fs.readFile(`${root}/node_modules/packet-program/bin/packet-program.mjs`, 'utf8')
        }
      };
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

  for (const run of [
    result.echo,
    result.bin,
    result.script,
    result.exec,
    result.npx,
    result.shebang,
    result.wrapper,
    result.inline,
    result.reboot
  ]) {
    expect(run.exitCode, run.output).toBe(0);
  }
  expect(result.echo.output).toBe('runtime-dispatch\n');
  expect(result.reboot.output).toBe('runtime-reboot\n');
  expect(result.bin.output).toMatch(
    /^bin\|\/home\/runtime-programs\/nested\|present\|\/home\/runtime-programs\/node_modules\/packet-program\/bin\/packet-program\.mjs,bin-arg\|(\d+)\|0\n$/
  );
  expect(result.script.output).toContain('packet-program.mjs,script-arg');
  expect(result.exec.output).toContain('packet-program.mjs,exec-arg');
  expect(result.npx.output).toContain('packet-program.mjs,npx-arg');
  expect(result.shebang.output).toMatch(
    /^shebang\|\/home\/runtime-programs\/nested\|present\|\/home\/runtime-programs\/scripts\/direct\.mjs,shebang-arg\|(\d+)\|0\n$/
  );
  expect(result.wrapper.output).toMatch(
    /^wrapper\|\/home\/runtime-programs\/nested\|present\|\/home\/runtime-programs\/scripts\/wrapped\.mjs,wrapper-arg\|(\d+)\|0\n$/
  );
  expect(result.inline.output).toMatch(
    /^inline\|\/home\/runtime-programs\/nested\|present\|inline-arg\|inline\/entry\|EROFS\|(\d+)\|0\n$/
  );
  expect(result.inlineDirectoryEntries).toEqual([]);
  expect(result.dependencyStateAfter).toEqual(result.dependencyStateBefore);

  const processIds = [result.bin.output, result.shebang.output, result.wrapper.output, result.inline.output].map((output) => {
    const match = output.match(/\|(\d+)\|0\n$/);
    if (!match) throw new Error(`runtime program did not report an admitted process identity: ${output}`);
    return Number(match[1]);
  });
  expect(processIds.every((pid) => Number.isInteger(pid) && pid > 0)).toBe(true);
  expect(new Set(processIds).size).toBe(processIds.length);

  const evidence = [
    result.echo.output,
    result.bin.output,
    result.script.output,
    result.exec.output,
    result.npx.output,
    result.shebang.output,
    result.wrapper.output,
    result.inline.output,
    result.reboot.output
  ].join('\n');
  expect(evidence).not.toContain('falling back to registered command adapter');
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

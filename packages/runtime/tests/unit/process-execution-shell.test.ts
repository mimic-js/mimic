import { describe, expect, test } from 'vitest';

import { createShellHarness, type TestCommand } from '../support/shell-harness';

const argsEcho: TestCommand = (request, io) => {
  io.out(`${request.command}:${JSON.stringify(request.args)}\n`);
  return 0;
};

describe('Shell Program builtins and command lookup (#645)', () => {
  test('runs `rm -rf dist && tsc` through the rm Runtime Program', async () => {
    const shell = createShellHarness({
      files: { '/home/project/dist/index.js': 'old', '/home/project/src/index.ts': 'new' },
      commands: { tsc: argsEcho }
    });

    const result = await shell.run(['-c', 'rm -rf dist && tsc']);

    expect(result).toMatchObject({ code: 0, stdout: 'tsc:[]\n', stderr: '' });
    expect(shell.memory.entries.has('/home/project/dist')).toBe(false);
    expect(shell.memory.entries.has('/home/project/src/index.ts')).toBe(true);
  });

  test('`cd app && npm i` runs the child in the new working directory', async () => {
    const shell = createShellHarness({
      files: { '/home/project/app': null },
      commands: {
        npm: (request, io) => {
          io.out(`${request.cwd} ${request.env.PWD} ${request.args.join(' ')}\n`);
          return 0;
        }
      }
    });

    const result = await shell.run(['-c', 'cd app && npm i']);

    expect(result).toMatchObject({ code: 0, stdout: '/home/project/app /home/project/app i\n' });
  });

  test('cd into a missing directory fails without running the next command', async () => {
    const shell = createShellHarness({ commands: { npm: argsEcho } });

    const result = await shell.run(['-c', 'cd missing && npm i']);

    expect(result.code).toBe(1);
    expect(result.stderr).toBe('sh: cd: missing: No such file or directory\n');
    expect(result.calls).toEqual([]);
  });

  test('`mkdir -p out` creates nested directories', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', 'mkdir -p out/nested/deep && test -d out/nested/deep']);

    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(shell.memory.entries.get('/home/project/out/nested/deep')).toBeNull();
  });

  test('`cmd || true` recovers from a failing command', async () => {
    const shell = createShellHarness({ commands: { cmd: () => 3 } });

    expect(await shell.run(['-c', 'cmd || true'])).toMatchObject({ code: 0 });
    expect(await shell.run(['-c', 'cmd || false'])).toMatchObject({ code: 1 });
  });

  test('`cat a | grep b` pipes a Runtime Program into a package command', async () => {
    const shell = createShellHarness({
      files: { '/home/project/a': 'alpha\nbeta\nbravo\n' },
      commands: {
        grep: (request, io) => {
          const matches = io.stdin.split('\n').filter((line) => line.includes(request.args[0]!));
          io.out(matches.map((line) => `${line}\n`).join(''));
          return matches.length > 0 ? 0 : 1;
        }
      }
    });

    const result = await shell.run(['-c', 'cat a | grep b']);

    expect(result).toMatchObject({ code: 0, stdout: 'beta\nbravo\n' });
  });

  test('`export X=1` reaches later children while plain assignments stay shell-local', async () => {
    const shell = createShellHarness({
      commands: {
        probe: (request, io) => {
          io.out(`X=${request.env.X} LOCAL=${request.env.LOCAL} TEMP=${request.env.TEMP}\n`);
          return 0;
        }
      }
    });

    const result = await shell.run(['-c', 'export X=1; LOCAL=2; TEMP=3 probe; probe; unset X; probe; echo "$LOCAL"']);

    expect(result.stdout).toBe(
      'X=1 LOCAL=undefined TEMP=3\nX=1 LOCAL=undefined TEMP=undefined\nX=undefined LOCAL=undefined TEMP=undefined\n2\n'
    );
  });

  test('an unknown command yields 127 and lets `||` and `;` continue', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', 'nope --flag || echo recovered; nope; echo "status=$?"']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('recovered\nstatus=127\n');
    expect(result.stderr).toBe('sh: nope: command not found\nsh: nope: command not found\n');
    expect((await shell.run(['-c', 'nope'])).code).toBe(127);
  });

  test('echo honours -n and -e like a POSIX shell', async () => {
    const shell = createShellHarness();

    expect((await shell.run(['-c', 'echo -n no-newline'])).stdout).toBe('no-newline');
    expect((await shell.run(['-c', "echo -e 'a\\tb\\n'"])).stdout).toBe('a\tb\n\n');
    expect((await shell.run(['-c', "echo 'a\\tb'"])).stdout).toBe('a\\tb\n');
    expect((await shell.run(['-c', 'echo -x'])).stdout).toBe('-x\n');
  });

  test('test and [ evaluate strings, integers and files', async () => {
    const shell = createShellHarness({ files: { '/home/project/package.json': '{}' } });
    const status = async (script: string) => (await shell.run(['-c', script])).code;

    expect(await status('[ -f package.json ]')).toBe(0);
    expect(await status('[ -d package.json ]')).toBe(1);
    expect(await status('test -e missing')).toBe(1);
    expect(await status('[ "$HOME" = /home ] && [ 2 -lt 10 ] && [ ! -z x ]')).toBe(0);
    expect(await status('[ a = a -a b != b ]')).toBe(1);
    expect(await status('[ -n "" ] || [ -e /dev/null ]')).toBe(0);
    expect((await shell.run(['-c', '[ a = a'])).stderr).toBe("sh: [: missing ']'\n");
  });

  test('pwd, true, false and exit behave as builtins without spawning', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', 'pwd; true && false; echo $?; exit 7; echo never']);

    expect(result).toMatchObject({ code: 7, stdout: '/home/project\n1\n' });
    expect(result.calls).toEqual([]);
  });

  test('env and which resolve through the Runtime Programs', async () => {
    const shell = createShellHarness({ files: { '/usr/bin/tool': '#!/usr/bin/env node\n' } });

    const result = await shell.run(['-c', 'which tool node rm; command -v cd; env -i A=1 | cat; which missing']);

    expect(result.stdout).toBe('/usr/bin/tool\n/usr/bin/node\n/bin/rm\ncd\nA=1\n');
    expect(result.code).toBe(1);
  });
});

describe('Shell Program syntax (#646)', () => {
  test('`2>&1`, `>&2` and `2>/dev/null` route descriptors instead of creating files', async () => {
    const shell = createShellHarness({
      commands: {
        noisy: (_request, io) => {
          io.out('out\n');
          io.err('err\n');
          return 0;
        }
      }
    });

    const merged = await shell.run(['-c', 'noisy > log.txt 2>&1']);
    expect(merged).toMatchObject({ code: 0, stdout: '', stderr: '' });
    expect(shell.memory.text('/home/project/log.txt')?.split('\n').sort()).toEqual(['', 'err', 'out']);

    expect(await shell.run(['-c', 'echo to-stderr >&2'])).toMatchObject({ stdout: '', stderr: 'to-stderr\n' });
    expect(await shell.run(['-c', 'noisy 2>/dev/null'])).toMatchObject({ stdout: 'out\n', stderr: '' });
    expect(await shell.run(['-c', 'noisy >/dev/null'])).toMatchObject({ stdout: '', stderr: 'err\n' });
    expect(await shell.run(['-c', 'noisy 2>&1 | cat'])).toMatchObject({ stderr: '' });
    expect([...shell.memory.entries.keys()].filter((path) => /&|null/.test(path))).toEqual([]);
  });

  test('`>>` appends and `<` feeds standard input', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', 'echo one > f.txt; echo two >> f.txt; cat < f.txt; cat < missing.txt']);

    expect(result.stdout).toBe('one\ntwo\n');
    expect(result.stderr).toBe('sh: missing.txt: No such file or directory\n');
    expect(result.code).toBe(1);
  });

  test('`&` runs a job in the background and `wait` collects it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const shell = createShellHarness({
      commands: {
        server: async (request, io) => {
          await gate;
          io.out(`server ${request.args.join(' ')} done\n`);
          return 0;
        },
        client: (_request, io) => {
          io.out('client ran\n');
          release();
          return 0;
        }
      }
    });

    const result = await shell.run(['-c', 'server --port 1 & client; wait; echo "pid=$!"']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('client ran\nserver --port 1 done\npid=101\n');
    expect(result.calls.map((call) => [call.command, ...call.args])).toEqual([['server', '--port', '1'], ['client']]);
  });

  test('newlines separate commands and # starts a comment', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', '# leading comment\necho one # trailing\necho two\n\necho three#not-a-comment\n']);

    expect(result.stdout).toBe('one\ntwo\nthree#not-a-comment\n');
  });

  test('command substitution captures output in both forms', async () => {
    const shell = createShellHarness({
      commands: {
        npm: (_request, io) => {
          io.out('/home/project/node_modules/.bin\n');
          return 0;
        },
        tool: argsEcho
      }
    });

    const result = await shell.run(['-c', 'tool "$(npm bin)/vite" `echo a b` "$(echo "nested $(echo deep)")" $((1 + 2 * 3))']);

    expect(result.stdout).toBe('tool:["/home/project/node_modules/.bin/vite","a","b","nested deep","7"]\n');
  });

  test('parameter expansion supports defaults, alternatives, lengths and affix removal', async () => {
    const shell = createShellHarness({ commands: { tool: argsEcho } });

    const result = await shell.run(
      ['-c', 'tool "${UNSET:-default}" "${EMPTY:-fallback}" "${EMPTY-kept}" "${SET:+alt}" "${#SET}" "${FILE%.*}" "${FILE##*/}" "${NEW:=made}" "$NEW"'],
      { env: { EMPTY: '', SET: 'value', FILE: 'src/app.test.ts' } }
    );

    expect(result.stdout).toBe('tool:["default","fallback","","alt","5","src/app.test","app.test.ts","made","made"]\n');
    expect(await shell.run(['-c', 'echo "${REQUIRED:?must be set}"; echo unreachable'])).toMatchObject({
      code: 2,
      stdout: '',
      stderr: 'sh: REQUIRED: must be set\n'
    });
  });

  test('positional parameters are available to `sh -c` scripts', async () => {
    const shell = createShellHarness({ commands: { tool: argsEcho } });

    const result = await shell.run(['-c', 'tool "$0" "$1" "$#" "$@"; shift; tool "$@" $*', 'name', 'a b', 'c']);

    expect(result.stdout).toBe('tool:["name","a b","2","a b","c"]\ntool:["c","c"]\n');
    expect((await shell.run(['-c', 'tool "$@" end'])).stdout).toBe('tool:["end"]\n');
  });

  test('globs expand against the filesystem and stay literal when quoted or unmatched', async () => {
    const shell = createShellHarness({
      files: {
        '/home/project/src/a.ts': '',
        '/home/project/src/b.ts': '',
        '/home/project/src/c.js': '',
        '/home/project/src/.hidden.ts': '',
        '/home/project/lib/d.ts': ''
      },
      commands: { tool: argsEcho }
    });

    const result = await shell.run(['-c', 'tool src/*.ts "src/*.ts" */[cd].?s *.none; cd src && tool *']);

    expect(result.stdout).toBe(
      'tool:["src/a.ts","src/b.ts","src/*.ts","lib/d.ts","src/c.js","*.none"]\ntool:["a.ts","b.ts","c.js"]\n'
    );
  });

  test('double quotes keep a backslash that does not escape a special character', async () => {
    const shell = createShellHarness({ commands: { node: argsEcho } });

    const result = await shell.run(['-c', `node -e "console.log('a\\n')" "\\$HOME \\"q\\" \\\\"`]);

    expect(result.stdout).toBe(`node:${JSON.stringify(['-e', "console.log('a\\n')", '$HOME "q" \\'])}\n`);
  });

  test('tilde expands to HOME at the start of a word', async () => {
    const shell = createShellHarness({ commands: { tool: argsEcho } });

    expect((await shell.run(['-c', 'tool ~ ~/bin "~" a~ DIR=~/x'])).stdout).toBe(
      'tool:["/home","/home/bin","~","a~","DIR=/home/x"]\n'
    );
  });

  test('a subshell runs as a child Shell Program that inherits variables and parameters', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', 'LOCAL=outer; (echo "$LOCAL $1"; LOCAL=inner; exit 3); echo "$? $LOCAL"', 'name', 'arg']);

    expect(result.stdout).toBe('outer arg\n3 outer\n');
    expect(result.calls.map((call) => [call.command, ...call.args])).toEqual([
      ['sh', '-c', 'echo "$LOCAL $1"; LOCAL=inner; exit 3', 'name', 'arg']
    ]);
  });

  test('prefix assignments are visible to the words and redirections of their own command', async () => {
    const shell = createShellHarness({ commands: { tool: argsEcho } });

    const result = await shell.run(['-c', 'OUT=result.txt tool "$OUT" > "$OUT"; echo "after=${OUT:-unset}"']);

    expect(result.stdout).toBe('after=unset\n');
    expect(shell.memory.text('/home/project/result.txt')).toBe('tool:["result.txt"]\n');
  });

  test('`sh file` runs a script file with positional parameters', async () => {
    const shell = createShellHarness({
      files: { '/home/project/build.sh': '#!/bin/sh\nset -e\necho "building $1"\nfalse\necho unreachable\n' }
    });

    expect(await shell.run(['build.sh', 'web'])).toMatchObject({ code: 1, stdout: 'building web\n' });
    expect(await shell.run(['missing.sh'])).toMatchObject({
      code: 127,
      stderr: 'sh: missing.sh: No such file or directory\n'
    });
    expect(await shell.run([], { stdin: 'echo from-stdin\n' })).toMatchObject({ code: 0, stdout: 'from-stdin\n' });
  });

  test('if, for, while, case, groups and negation control the flow', async () => {
    const shell = createShellHarness({ files: { '/home/project/package.json': '{}' } });

    const result = await shell.run([
      '-c',
      [
        'if [ -f package.json ]; then echo has-package; elif true; then echo no; else echo never; fi',
        'for name in a b c; do [ "$name" = b ] && continue; echo "item $name"; done',
        'count=0; while [ "$count" -lt 3 ]; do count=$((count + 1)); done; echo "count $count"',
        'case "feature/login" in main) echo main ;; feature/*|fix/*) echo branch ;; *) echo other ;; esac',
        '{ echo grouped; echo output; } | cat',
        '! false && echo negated',
        '(cd / && FOO=sub; echo "sub $PWD"); echo "outer $PWD ${FOO:-unset}"'
      ].join('\n')
    ]);

    expect(result.stderr).toBe('');
    expect(result.stdout).toBe(
      'has-package\nitem a\nitem c\ncount 3\nbranch\ngrouped\noutput\nnegated\nsub /\nouter /home/project unset\n'
    );
  });

  test('`set -e` stops at the first failure outside a condition', async () => {
    const shell = createShellHarness();

    const result = await shell.run(['-c', 'set -e\nfalse || echo guarded\nif false; then :; fi\necho before\nfalse\necho after']);

    expect(result).toMatchObject({ code: 1, stdout: 'guarded\nbefore\n' });
  });

  test.each([
    ['cat <<EOF\nbody\nEOF', 'here-documents'],
    ['greet() { echo hi; }', 'function definitions'],
    ['cmd &> out.log', '&> redirection'],
    ['diff <(a) <(b)', 'process substitution'],
    ['[[ -f x ]]', '[[ ]] conditional expressions'],
    ['echo ${NAME/a/b}', 'unsupported parameter expansion ${NAME/a/b}'],
    ['list=(a b)', 'array assignments'],
    ['echo "unterminated', 'unterminated double quote'],
    ['if true; then echo x', 'expected "fi"']
  ])('rejects %j with a syntax error naming the construct', async (script, construct) => {
    const shell = createShellHarness({ commands: { cmd: argsEcho, diff: argsEcho, cat: argsEcho } });

    const result = await shell.run(['-c', script]);

    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain(`sh: syntax error: ${construct}`);
    expect(result.calls).toEqual([]);
  });

  test('sequential commands share standard input without losing unread data', async () => {
    const shell = createShellHarness({ commands: { noop: () => 0 } });

    const result = await shell.run(['-c', 'read first; read second; echo "$second/$first"; cat'], {
      stdin: 'one\ntwo\nrest\n'
    });

    expect(result.stdout).toBe('two/one\nrest\n');
  });

  test('requests an admitted replacement only for a final foreground command', async () => {
    const replaced: string[] = [];
    const shell = createShellHarness({
      commands: { first: () => 0 },
      replace: async (request) => {
        replaced.push([request.command, ...request.args].join(' '));
        return 12;
      }
    });

    expect((await shell.run(['-c', 'first; exec tool "$HOME"'])).code).toBe(12);
    expect((await shell.run(['-c', 'tool | first'])).code).toBe(0);
    expect((await shell.run(['-c', 'first & tool'])).code).toBe(127);
    expect((await shell.run(['-c', 'tool > out.txt'])).code).toBe(127);
    expect(replaced).toEqual(['tool /home']);
  });
});

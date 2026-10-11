import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const posixVfsCompatibilityClaim = defineCompatibilityClaim({
  id: 'vfs-posix-file-and-path-semantics-v1',
  statement:
    'Mimic preserves POSIX-like VFS metadata, Node Stats identity, symlink identity, descriptors, directory rules, and atomic rename behavior',
  target: {
    kind: 'runtime-capability',
    capability: 'vfs-posix-file-and-path-semantics'
  }
});

const openDescriptorCompatibilityClaim = defineCompatibilityClaim({
  id: 'vfs-open-descriptor-rename-unlink-v1',
  statement:
    'An open Node file descriptor keeps its inode identity and contents after rename and unlink',
  target: {
    kind: 'runtime-capability',
    capability: 'vfs-open-descriptor-rename-unlink'
  }
});

test(openDescriptorCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
  await page.route('**/__open-descriptor.html', (route) =>
    route.fulfill({
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      body: '<!doctype html><title>open descriptor</title>'
    })
  );
  await page.goto('/__open-descriptor.html');

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/descriptor' });
    try {
      await runtime.fs.mount({
        'descriptor.mjs': {
          file: {
            contents: [
              "import fs from 'node:fs';",
              "const source = '/home/descriptor/source.txt';",
              "const renamed = '/home/descriptor/renamed.txt';",
              "fs.writeFileSync(source, 'before');",
              "const descriptor = fs.openSync(source, 'r+');",
              'const inode = fs.fstatSync(descriptor).ino;',
              'fs.renameSync(source, renamed);',
              'fs.unlinkSync(renamed);',
              "fs.writeSync(descriptor, 'after', 0, 'utf8');",
              'const bytes = new Uint8Array(6);',
              'fs.readSync(descriptor, bytes, 0, bytes.length, 0);',
              'const stat = fs.fstatSync(descriptor);',
              'fs.closeSync(descriptor);',
              'console.log(JSON.stringify({ inode, finalInode: stat.ino, text: new TextDecoder().decode(bytes), sourceExists: fs.existsSync(source), renamedExists: fs.existsSync(renamed) }));'
            ].join('\n')
          }
        }
      });
      const process = await runtime.spawn('node', ['/home/descriptor/descriptor.mjs']);
      const output = await new Response(process.output).text();
      return { exit: await process.exit, output };
    } finally {
      await runtime.teardown();
    }
  });

  expect(result.exit, result.output).toBe(0);
  expect(JSON.parse(result.output)).toEqual({
    inode: expect.any(Number),
    finalInode: expect.any(Number),
    text: 'aftere',
    sourceExists: false,
    renamedExists: false
  });
  const summary = JSON.parse(result.output) as { inode: number; finalInode: number };
  expect(summary.finalInode).toBe(summary.inode);
});

test(posixVfsCompatibilityClaim.statement, async ({ page }) => {
  test.setTimeout(240_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  await page.route('**/__filesystem.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      body: '<!doctype html><title>filesystem</title><main>filesystem</main>'
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/__filesystem.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, { timeout: 10_000 });

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const runtime = await Mimic.boot({ workdir: '/home/filesystem' });

    try {
      await runtime.fs.mount({
        'filesystem.mjs': {
          file: {
            contents: [
              "import fs from 'node:fs';",
              "import { promises as fsPromises } from 'node:fs';",
              "import fsPromisesModule from 'node:fs/promises';",
              "const root = '/home/filesystem/work';",
              'const bytes = new Uint8Array([0, 255, 1, 2]);',
              'fs.mkdirSync(root, { recursive: true });',
              "fs.writeFileSync(`${root}/payload.bin`, bytes);",
              "const callbackBytes = await new Promise((resolve, reject) => fs.readFile(`${root}/payload.bin`, (error, value) => error ? reject(error) : resolve(value)));",
              "const promiseBytes = await fsPromises.readFile(`${root}/payload.bin`);",
              "await new Promise((resolve, reject) => fs.writeFile(`${root}/callback.txt`, 'callback', (error) => error ? reject(error) : resolve()));",
              "await fsPromises.writeFile(`${root}/promise.txt`, 'promise');",
              "const descriptor = fs.openSync(`${root}/descriptor.bin`, 'w+');",
              'fs.writeSync(descriptor, new Uint8Array([9, 8, 7]), 0, 3, 0);',
              'const descriptorStat = fs.fstatSync(descriptor);',
              'const callbackDescriptorStat = await new Promise((resolve, reject) => fs.fstat(descriptor, (error, value) => error ? reject(error) : resolve(value)));',
              'const descriptorVisibleBeforeClose = [...await fsPromises.readFile(`${root}/descriptor.bin`)];',
              'const descriptorRead = new Uint8Array(3);',
              'fs.readSync(descriptor, descriptorRead, 0, 3, 0);',
              'fs.closeSync(descriptor);',
              "const promiseDescriptor = await fsPromises.open(`${root}/promise-descriptor.bin`, 'w+');",
              'await promiseDescriptor.write(new Uint8Array([6, 5, 4]), 0, 3, 0);',
              'const promiseDescriptorStat = await promiseDescriptor.stat();',
              'const promiseDescriptorVisibleBeforeClose = [...fs.readFileSync(`${root}/promise-descriptor.bin`)];',
              'await promiseDescriptor.close();',
              "let descriptorError; try { fs.readSync(descriptor, new Uint8Array(1)); } catch (error) { descriptorError = error.code; }",
              "const writeOnlyDescriptor = fs.openSync(`${root}/write-only.bin`, 'w');",
              "let writeOnlyReadError; try { fs.readSync(writeOnlyDescriptor, new Uint8Array(1)); } catch (error) { writeOnlyReadError = error.code; }",
              'fs.closeSync(writeOnlyDescriptor);',
              "const readOnlyDescriptor = fs.openSync(`${root}/payload.bin`, 'r');",
              "let readOnlyWriteError; try { fs.writeSync(readOnlyDescriptor, new Uint8Array([3])); } catch (error) { readOnlyWriteError = error.code; }",
              'fs.closeSync(readOnlyDescriptor);',
              "const streamWrite = fs.createWriteStream(`${root}/stream.bin`);",
              "await new Promise((resolve, reject) => { streamWrite.once('error', reject); streamWrite.once('finish', resolve); streamWrite.write(new Uint8Array([4, 5])); streamWrite.end(new Uint8Array([6, 7])); });",
              "const streamBytes = await new Promise((resolve, reject) => { const chunks = []; const stream = fs.createReadStream(`${root}/stream.bin`); stream.on('data', (chunk) => chunks.push(...chunk)); stream.once('error', reject); stream.once('end', () => resolve(chunks)); });",
              "fs.symlinkSync('payload.bin', `${root}/payload-link`);",
              "await fsPromises.symlink('payload.bin', `${root}/promise-link`);",
              "fs.symlinkSync('missing-target.bin', `${root}/dangling-link`);",
              "const callbackLink = await new Promise((resolve, reject) => fs.readlink(`${root}/payload-link`, (error, value) => error ? reject(error) : resolve(value)));",
              "const lstat = fs.lstatSync(`${root}/payload-link`);",
              "const callbackLstat = await new Promise((resolve, reject) => fs.lstat(`${root}/payload-link`, (error, value) => error ? reject(error) : resolve(value)));",
              "const promiseLstat = await fsPromises.lstat(`${root}/payload-link`);",
              "const danglingLstat = fs.lstatSync(`${root}/dangling-link`, { throwIfNoEntry: false });",
              "const missingLstat = fs.lstatSync(`${root}/missing-link`, { throwIfNoEntry: false });",
              "const stat = fs.statSync(`${root}/payload-link`);",
              "const callbackStat = await new Promise((resolve, reject) => fs.stat(`${root}/payload-link`, (error, value) => error ? reject(error) : resolve(value)));",
              "const promiseStat = await fsPromises.stat(`${root}/payload-link`);",
              "const resolved = await fsPromises.realpath(`${root}/payload-link`);",
              "let callbackError; await new Promise((resolve) => fs.readFile(`${root}/missing`, (error) => { callbackError = error?.code; resolve(); }));",
              "let promiseError; try { await fsPromises.readFile(`${root}/missing`); } catch (error) { promiseError = error.code; }",
              "fs.writeFileSync(`${root}/rename-from.txt`, 'new');",
              "fs.writeFileSync(`${root}/rename-to.txt`, 'old');",
              "fs.renameSync(`${root}/rename-from.txt`, `${root}/rename-to.txt`);",
              "fs.mkdirSync(`${root}/rename-directory`);",
              "let fileOverDirectoryError; try { fs.renameSync(`${root}/rename-to.txt`, `${root}/rename-directory`); } catch (error) { fileOverDirectoryError = error.code; }",
              "fs.mkdirSync(`${root}/rename-source`);",
              "fs.writeFileSync(`${root}/rename-source/child.txt`, 'kept');",
              "let descendantRenameError; try { fs.renameSync(`${root}/rename-source`, `${root}/rename-source/child`); } catch (error) { descendantRenameError = error.code; }",
              'console.log(JSON.stringify({',
              '  callbackBytes: [...callbackBytes],',
              '  promiseBytes: [...promiseBytes],',
              "  callbackText: fs.readFileSync(`${root}/callback.txt`, 'utf8'),",
              "  promiseText: fs.readFileSync(`${root}/promise.txt`, 'utf8'),",
              "  descriptorBytes: [...fs.readFileSync(`${root}/descriptor.bin`)],",
              '  descriptorVisibleBeforeClose,',
              '  descriptorRead: [...descriptorRead],',
              '  promiseDescriptorVisibleBeforeClose,',
              '  statsIdentity: [stat, callbackStat, promiseStat, lstat, callbackLstat, promiseLstat, descriptorStat, callbackDescriptorStat, promiseDescriptorStat].every((value) => value instanceof fs.Stats),',
              '  statsFieldsAndPredicates: stat.size === bytes.length && stat.isFile() && lstat.isSymbolicLink() && descriptorStat.ino > 0 && descriptorStat.isFile(),',
              '  promisesIdentity: fs.promises === fsPromises && fsPromises === fsPromisesModule,',
              '  streamBytes,',
              '  callbackLink,',
              '  lstatIsLink: lstat.isSymbolicLink(),',
              '  danglingLstatIsLink: danglingLstat?.isSymbolicLink(),',
              '  missingLstat: missingLstat === undefined,',
              '  statIsFile: stat.isFile(),',
              '  resolved,',
              "  linkedBytes: [...fs.readFileSync(`${root}/payload-link`)],",
              '  callbackError,',
              '  promiseError,',
              '  descriptorError,',
              '  writeOnlyReadError,',
              '  readOnlyWriteError,',
              '  fileOverDirectoryError,',
              '  descendantRenameError,',
              "  preservedDirectory: fs.statSync(`${root}/rename-directory`).isDirectory(),",
              "  preservedSource: fs.readFileSync(`${root}/rename-source/child.txt`, 'utf8'),",
              "  renamed: fs.readFileSync(`${root}/rename-to.txt`, 'utf8'),",
              "  sourceRemoved: !fs.existsSync(`${root}/rename-from.txt`)",
              '}));'
            ].join('\n')
          }
        }
      });

      const process = await runtime.spawn('node', ['/home/filesystem/filesystem.mjs']);
      const output = await collectOutput(process.output);
      const exit = await process.exit;
      if (exit !== 0) throw new Error(output);
      const publicStat = await runtime.fs.stat('/home/filesystem/work/payload-link');
      const publicLstat = await runtime.fs.lstat('/home/filesystem/work/payload-link');
      const mirrored = {
        linkedBytes: [...(await runtime.fs.readFile('/home/filesystem/work/payload-link'))],
        renamed: await runtime.fs.readFile('/home/filesystem/work/rename-to.txt', 'utf8'),
        statIsFile: publicStat.isFile(),
        statInodeIsStable:
          publicStat.ino > 0 &&
          publicStat.ino === (await runtime.fs.stat('/home/filesystem/work/payload.bin')).ino,
        statTimesAreDates: publicStat.ctime instanceof Date && publicStat.mtime instanceof Date,
        lstatIsLink: publicLstat.isSymbolicLink(),
        lstatInodeIsDistinct: publicLstat.ino > 0 && publicLstat.ino !== publicStat.ino,
        realpath: await runtime.fs.realpath('/home/filesystem/work/payload-link')
      };
      await runtime.teardown();

      const rebooted = await Mimic.boot({ workdir: '/home/filesystem-reboot' });
      let rebootError: string | undefined;
      try {
        await rebooted.fs.readFile('/home/filesystem/work/rename-to.txt', 'utf8');
      } catch (error) {
        rebootError = (error as { code?: string }).code;
      } finally {
        await rebooted.teardown();
      }

      return { exit, output, mirrored, rebootError };
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

  expect(result.exit, result.output).toBe(0);
  const summary = JSON.parse(result.output) as Record<string, unknown>;
  expect(summary).toEqual({
    callbackBytes: [0, 255, 1, 2],
    promiseBytes: [0, 255, 1, 2],
    callbackText: 'callback',
    promiseText: 'promise',
    descriptorBytes: [9, 8, 7],
    descriptorVisibleBeforeClose: [9, 8, 7],
    descriptorRead: [9, 8, 7],
    promiseDescriptorVisibleBeforeClose: [6, 5, 4],
    statsIdentity: true,
    statsFieldsAndPredicates: true,
    promisesIdentity: true,
    descriptorError: 'EBADF',
    writeOnlyReadError: 'EBADF',
    readOnlyWriteError: 'EBADF',
    streamBytes: [4, 5, 6, 7],
    callbackLink: 'payload.bin',
    lstatIsLink: true,
    danglingLstatIsLink: true,
    missingLstat: true,
    statIsFile: true,
    resolved: '/home/filesystem/work/payload.bin',
    linkedBytes: [0, 255, 1, 2],
    callbackError: 'ENOENT',
    promiseError: 'ENOENT',
    renamed: 'new',
    sourceRemoved: true,
    fileOverDirectoryError: 'EISDIR',
    descendantRenameError: 'EINVAL',
    preservedDirectory: true,
    preservedSource: 'kept'
  });
  expect(result.rebootError).toBe('NOT_FOUND');
  expect(result.mirrored).toEqual({
    linkedBytes: [0, 255, 1, 2],
    renamed: 'new',
    statIsFile: true,
    statInodeIsStable: true,
    statTimesAreDates: true,
    lstatIsLink: true,
    lstatInodeIsDistinct: true,
    realpath: '/home/filesystem/work/payload.bin'
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, test } from './compatibility-test';

const filesystemArchiveClaim = defineCompatibilityClaim({
  id: 'vfs-snapshot-mount-and-archive-export-v1',
  statement:
    'Mimic deterministically round-trips binary-safe JSON, ZIP, and TAR filesystem snapshots with metadata and symlinks',
  target: {
    kind: 'runtime-capability',
    capability: 'vfs-snapshot-mount-and-archive-export'
  }
});

test(filesystemArchiveClaim.statement, async ({ page }) => {
  test.setTimeout(120_000);
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];

  await page.route('**/__filesystem-archives.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      headers: {
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Opener-Policy': 'same-origin'
      },
      body: '<!doctype html><title>filesystem archives</title><main>filesystem archives</main>'
    });
  });
  page.on('pageerror', (error) => pageErrors.push(error.stack ?? error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  await page.goto('/__filesystem-archives.html', {
    waitUntil: 'domcontentloaded',
    timeout: 30_000
  });
  await page.waitForFunction(() => window.crossOriginIsolated === true, null, {
    timeout: 10_000
  });

  const result = await page.evaluate(async () => {
    const { Mimic } = await import('/src/runtime/index.ts');
    const mtimeMs = Date.UTC(2024, 0, 2, 3, 4, 6);
    const tree = {
      empty: { directory: {}, mtimeMs },
      nested: {
        directory: {
          'payload.bin': {
            file: { contents: new Uint8Array([0, 255, 1, 2]) },
            mtimeMs
          },
          'payload-link': {
            symlink: { target: 'payload.bin' },
            mtimeMs
          }
        },
        mtimeMs
      }
    };

    const source = await Mimic.boot({
      workdir: '/home/filesystem-archive-source'
    });
    let json: Awaited<ReturnType<typeof source.fs.export>>;
    let zip: Uint8Array;
    let tar: Uint8Array;
    let deterministic: { zip: boolean; tar: boolean };
    let invalidBoundary: {
      mountError: string | undefined;
      traversalError: string | undefined;
      exportError: string | undefined;
      preservedBytes: number[];
    };
    try {
      await source.fs.mount(tree);
      let mountError: string | undefined;
      try {
        await source.fs.mount(new Uint8Array([1, 2, 3]));
      } catch (error) {
        mountError = `${(error as Error & { code?: string }).code}: ${(error as Error).message}`;
      }
      const validZip = await source.fs.export(source.workdir, { format: 'zip' });
      if (!(validZip instanceof Uint8Array)) {
        throw new Error('ZIP export did not return bytes.');
      }
      let traversalError: string | undefined;
      try {
        await source.fs.mount(withTraversalZipEntry(validZip));
      } catch (error) {
        traversalError = `${(error as Error & { code?: string }).code}: ${(error as Error).message}`;
      }
      let exportError: string | undefined;
      try {
        await source.fs.export(source.workdir, { format: 'unsupported' as never });
      } catch (error) {
        exportError = (error as Error).message;
      }
      invalidBoundary = {
        mountError,
        traversalError,
        exportError,
        preservedBytes: [
          ...(await source.fs.readFile(`${source.workdir}/nested/payload.bin`))
        ]
      };
      json = await source.fs.export(source.workdir, { format: 'json' });
      const firstZip = await source.fs.export(source.workdir, { format: 'zip' });
      const secondZip = await source.fs.export(source.workdir, { format: 'zip' });
      const firstTar = await source.fs.export(source.workdir, { format: 'tar' });
      const secondTar = await source.fs.export(source.workdir, { format: 'tar' });
      if (
        !(firstZip instanceof Uint8Array) ||
        !(secondZip instanceof Uint8Array) ||
        !(firstTar instanceof Uint8Array) ||
        !(secondTar instanceof Uint8Array)
      ) {
        throw new Error('Archive export did not return bytes.');
      }
      zip = firstZip;
      tar = firstTar;
      deterministic = {
        zip: bytesEqual(firstZip, secondZip),
        tar: bytesEqual(firstTar, secondTar)
      };
    } finally {
      await source.teardown();
    }

    if (json instanceof Uint8Array) throw new Error('JSON export returned archive bytes.');
    const jsonNested = json.nested;
    if (!jsonNested || !('directory' in jsonNested)) {
      throw new Error('JSON export did not preserve the nested directory.');
    }
    const jsonPayload = jsonNested.directory['payload.bin'];
    const jsonLink = jsonNested.directory['payload-link'];

    const mounted: Record<string, unknown> = {};
    for (const [format, archive] of [
      ['zip', zip],
      ['tar', tar]
    ] as const) {
      const runtime = await Mimic.boot({
        workdir: `/home/filesystem-archive-${format}`
      });
      try {
        await runtime.fs.mount(archive);
        const linkStat = await runtime.fs.lstat(`${runtime.workdir}/nested/payload-link`);
        const exportedAgain = await runtime.fs.export(runtime.workdir, { format });
        if (!(exportedAgain instanceof Uint8Array)) {
          throw new Error(`${format} re-export did not return bytes.`);
        }
        mounted[format] = {
          bytes: [...(await runtime.fs.readFile(`${runtime.workdir}/nested/payload.bin`))],
          empty: await runtime.fs.readdir(`${runtime.workdir}/empty`),
          linkTarget: await runtime.fs.readlink(`${runtime.workdir}/nested/payload-link`),
          linkIsSymbolic: linkStat.isSymbolicLink(),
          linkMtimeMs: linkStat.mtimeMs,
          deterministicRoundTrip: bytesEqual(archive, exportedAgain)
        };
      } finally {
        await runtime.teardown();
      }
    }

    return {
      deterministic,
      invalidBoundary,
      json: {
        payload:
          jsonPayload && 'file' in jsonPayload && jsonPayload.file.contents instanceof Uint8Array
            ? [...jsonPayload.file.contents]
            : undefined,
        payloadMtimeMs: jsonPayload?.mtimeMs,
        linkTarget: jsonLink && 'symlink' in jsonLink ? jsonLink.symlink.target : undefined,
        linkMtimeMs: jsonLink?.mtimeMs,
        empty: 'empty' in json ? json.empty : undefined
      },
      mounted
    };

    function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
      return (
        left.byteLength === right.byteLength &&
        left.every((value, index) => value === right[index])
      );
    }

    function withTraversalZipEntry(archive: Uint8Array): Uint8Array {
      const result = archive.slice();
      rewriteFirstEntryName(result, [80, 75, 3, 4], 26, 30);
      rewriteFirstEntryName(result, [80, 75, 1, 2], 28, 46);
      return result;
    }

    function rewriteFirstEntryName(
      archive: Uint8Array,
      signature: readonly number[],
      lengthOffset: number,
      nameOffset: number
    ): void {
      const headerOffset = archive.findIndex((_, index) =>
        signature.every((value, signatureIndex) => archive[index + signatureIndex] === value)
      );
      if (headerOffset < 0) throw new Error('ZIP entry header is missing.');
      const nameLength =
        archive[headerOffset + lengthOffset] |
        (archive[headerOffset + lengthOffset + 1] << 8);
      if (nameLength < 3) throw new Error('ZIP entry name is too short for a traversal witness.');
      const traversalName = new TextEncoder().encode(`../${'x'.repeat(nameLength - 3)}`);
      archive.set(traversalName, headerOffset + nameOffset);
    }
  });

  expect(result).toEqual({
    deterministic: { zip: true, tar: true },
    invalidBoundary: {
      mountError: 'INVALID_ARCHIVE: Unsupported binary filesystem snapshot.',
      traversalError: 'INVALID_ARCHIVE: Unsupported binary filesystem snapshot.',
      exportError: 'Unsupported filesystem export format: unsupported',
      preservedBytes: [0, 255, 1, 2]
    },
    json: {
      payload: [0, 255, 1, 2],
      payloadMtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6),
      linkTarget: 'payload.bin',
      linkMtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6),
      empty: {
        directory: {},
        mtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6)
      }
    },
    mounted: {
      zip: {
        bytes: [0, 255, 1, 2],
        empty: [],
        linkTarget: 'payload.bin',
        linkIsSymbolic: true,
        linkMtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6),
        deterministicRoundTrip: true
      },
      tar: {
        bytes: [0, 255, 1, 2],
        empty: [],
        linkTarget: 'payload.bin',
        linkIsSymbolic: true,
        linkMtimeMs: Date.UTC(2024, 0, 2, 3, 4, 6),
        deterministicRoundTrip: true
      }
    }
  });
  expect(pageErrors).toEqual([]);
  expect(consoleErrors).toEqual([]);
});

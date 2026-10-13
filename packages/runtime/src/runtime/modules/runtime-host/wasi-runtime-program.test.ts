import { describe, expect, test, vi } from 'vitest';

import {
  createWasiNodeAdapterFactory,
  inspectWasiPreview1Executable,
  type WasiSynchronousVfsPort
} from '../wasi-execution';
import { VirtualFileSystem } from '../../../../tests/support/module-internals';
import {
  createWasiRuntimeProgram,
  WASI_STDIN_AVAILABLE_WORD,
  WASI_STDIN_ENDED,
  type WasiRuntimeExecutionWorker,
  type WasiRuntimeHostApi,
  type WasiRuntimeWorkerStart
} from './wasi-runtime-program';
import type {
  SynchronousVirtualFileSystemMailboxDescriptor
} from '../virtual-file-system';
import {
  connectRpc,
  synchronousChannelWords,
  type RpcConnection
} from '../worker-transport';

// Generated from tests/fixtures/wasi-runtime-process.wat.
const wasiRuntimeProcessProgram = Uint8Array.from(
  Buffer.from(
    'AGFzbQEAAAABFwRgAn9/AX9gBH9/f38Bf2ABfwF/YAAAAuABBhZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxDmFyZ3Nfc2l6ZXNfZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhhcmdzX2dldAAAFndhc2lfc25hcHNob3RfcHJldmlldzERZW52aXJvbl9zaXplc19nZXQAABZ3YXNpX3NuYXBzaG90X3ByZXZpZXcxC2Vudmlyb25fZ2V0AAAWd2FzaV9zbmFwc2hvdF9wcmV2aWV3MQhmZF93cml0ZQABFndhc2lfc25hcHNob3RfcHJldmlldzEJcHJvY19leGl0AAIDAgEDBQMBAAEHEwIGbWVtb3J5AgAGX3N0YXJ0AAYKfQF7AEEAQQQQABpBwABBgAEQARpBEEGAATYCAEEUQQQoAgA2AgBBAUEQQQFBIBAEGkEIQQwQAhpBgARBgAgQAxpBGEGACDYCAEEcQQwoAgA2AgBBAUEYQQFBJBAEGkEoQYAQNgIAQSxBEDYCAEECQShBAUEwEAQaQQcQBRoLCxcBAEGAEAsQc3RkZXJyPW9ic2VydmVkCg==',
    'base64'
  )
);

const writableFileRights =
  (1n << 1n) |
  (1n << 2n) |
  (1n << 5n) |
  (1n << 6n) |
  (1n << 21n);

describe('WASI Execution Preview1 host', () => {
  test('polls clocks and descriptors while keeping unsupported capabilities honest', () => {
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({
        monotonicNowNs: () => 1_000_000n
      })
    )({ version: 'preview1' });
    const guest = wasiNamespaceImportingInstance(host);
    const memory = guest.exports.memory;
    const view = new DataView(memory.buffer);
    host.initialize({ exports: { ...guest.exports, _initialize: () => undefined } });
    const wasi = guest.exports;

    writeClockSubscription(view, 1024, 11n, 0n);
    expect(wasi.poll_oneoff(1024, 2048, 1, 3072)).toBe(0);
    expect(view.getUint32(3072, true)).toBe(1);
    expect(readPollEvent(view, 2048)).toEqual({
      userdata: 11n,
      error: 0,
      type: 0,
      nbytes: 0n,
      flags: 0
    });

    writeClockSubscription(view, 1024, 12n, 1_000_000n);
    expect(wasi.poll_oneoff(1024, 2048, 1, 3072)).toBe(0);
    expect(readPollEvent(view, 2048)).toMatchObject({ userdata: 12n, error: 0, type: 0 });

    writeClockSubscription(view, 1024, 13n, 9_000_000n, 1);
    expect(wasi.poll_oneoff(1024, 2048, 1, 3072)).toBe(0);
    expect(readPollEvent(view, 2048)).toMatchObject({ userdata: 13n, error: 0, type: 0 });

    writeClockSubscription(view, 1024, 14n, 20_000_000n);
    writeDescriptorSubscription(view, 1072, 15n, 2, 1);
    expect(wasi.poll_oneoff(1024, 2048, 2, 3072)).toBe(0);
    expect(view.getUint32(3072, true)).toBe(1);
    expect(readPollEvent(view, 2048)).toEqual({
      userdata: 15n,
      error: 0,
      type: 2,
      nbytes: 0n,
      flags: 0
    });

    writeDescriptorSubscription(view, 1024, 16n, 1, 999);
    new Uint8Array(memory.buffer, 1072, 48).fill(0);
    view.setBigUint64(1072, 17n, true);
    view.setUint8(1080, 99);
    expect(wasi.poll_oneoff(1024, 2048, 2, 3072)).toBe(0);
    expect(view.getUint32(3072, true)).toBe(2);
    expect(readPollEvent(view, 2048)).toMatchObject({ userdata: 16n, error: 8, type: 1 });
    expect(readPollEvent(view, 2080)).toMatchObject({ userdata: 17n, error: 28, type: 99 });
    expect(wasi.poll_oneoff(1024, 2048, 0, 3072)).toBe(28);
    expect(wasi.poll_oneoff(65_520, 2048, 1, 3072)).toBe(21);

    expect(wasi.fd_fdstat_set_flags(1, 4)).toBe(0);
    expect(wasi.fd_fdstat_get(1, 3104)).toBe(0);
    expect(view.getUint16(3106, true)).toBe(4);
    expect(wasi.fd_fdstat_set_flags(1, 16)).toBe(52);
    expect(wasi.fd_fdstat_set_flags(1, 1)).toBe(76);
    expect(wasi.fd_fdstat_set_flags(1, 32)).toBe(28);
    view.setUint32(3136, 0xdeadbeef, true);
    expect(wasi.sock_accept(1, 0, 3136)).toBe(52);
    expect(view.getUint32(3136, true)).toBe(0xdeadbeef);
    expect(wasi.sock_shutdown(1, 3)).toBe(52);

  });

  test('admits only the demanded polling, descriptor-flag, and socket imports', async () => {
    expect(
      await inspectWasiPreview1Executable(
        wasiExecutableImporting([
          'poll_oneoff',
          'fd_fdstat_set_flags',
          'sock_accept',
          'sock_shutdown'
        ])
      )
    ).toEqual({ kind: 'supported' });
    expect(
      await inspectWasiPreview1Executable(
        wasiExecutableImporting(['poll_oneoff', 'sock_open'])
      )
    ).toMatchObject({ kind: 'unsupported', code: 'UNKNOWN_WASI_IMPORT' });
  });

  test('mutates the authoritative VFS through writable descriptors and namespace operations', () => {
    const fileSystem = new VirtualFileSystem('/workspace');
    fileSystem.writeFileSync('/workspace/existing.txt', 'seed');
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ vfs: fileSystem })
    )({
      version: 'preview1',
      preopens: { '/sandbox': '/workspace' }
    });
    const guest = wasiNamespaceImportingInstance(host);
    const memory = guest.exports.memory;
    host.initialize({
      exports: { ...guest.exports, _initialize: () => undefined }
    });
    const wasi = guest.exports;
    const view = new DataView(memory.buffer);
    writeText(memory, 32, 'created.txt');
    expect(
      wasi.path_open(3, 0, 32, 11, 1, writableFileRights, 0n, 0, 48)
    ).toBe(0);
    const createdFd = view.getUint32(48, true);
    writeText(memory, 128, 'hello');
    view.setUint32(64, 128, true);
    view.setUint32(68, 5, true);
    expect(wasi.fd_write(3, 64, 1, 72)).toBe(31);
    expect(wasi.fd_write(createdFd, 64, 1, 65_535)).toBe(21);
    expect(fileSystem.readText('/workspace/created.txt')).toBe('');
    expect(wasi.fd_write(createdFd, 64, 1, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(5);
    expect(fileSystem.readText('/workspace/created.txt')).toBe('hello');
    expect(wasi.fd_fdstat_set_flags(createdFd, 4)).toBe(76);

    expect(wasi.fd_seek(createdFd, 1n, 0, 80)).toBe(0);
    writeText(memory, 136, 'A');
    view.setUint32(88, 136, true);
    view.setUint32(92, 1, true);
    expect(wasi.fd_write(createdFd, 88, 1, 96)).toBe(0);
    expect(fileSystem.readText('/workspace/created.txt')).toBe('hAllo');

    expect(
      wasi.path_open(3, 0, 32, 11, 0, writableFileRights, 0n, 1, 104)
    ).toBe(0);
    const appendFd = view.getUint32(104, true);
    writeText(memory, 144, '!');
    view.setUint32(112, 144, true);
    view.setUint32(116, 1, true);
    expect(wasi.fd_write(appendFd, 112, 1, 120)).toBe(0);
    expect(fileSystem.readText('/workspace/created.txt')).toBe('hAllo!');

    expect(
      wasi.path_open(3, 0, 32, 11, 5, writableFileRights, 0n, 0, 152)
    ).toBe(20);
    expect(fileSystem.readText('/workspace/created.txt')).toBe('hAllo!');
    expect(
      wasi.path_open(3, 0, 32, 11, 8, writableFileRights, 0n, 0, 152)
    ).toBe(0);
    expect(fileSystem.readText('/workspace/created.txt')).toBe('');

    writeText(memory, 160, 'folder');
    expect(wasi.path_create_directory(3, 160, 6)).toBe(0);
    expect(fileSystem.isDirectory('/workspace/folder')).toBe(true);
    writeText(memory, 176, 'folder/nested.txt');
    expect(
      wasi.path_open(3, 0, 176, 17, 1, writableFileRights, 0n, 0, 200)
    ).toBe(0);
    expect(wasi.path_remove_directory(3, 160, 6)).toBe(55);
    expect(wasi.path_unlink_file(3, 176, 17)).toBe(0);
    expect(wasi.path_remove_directory(3, 160, 6)).toBe(0);
    expect(fileSystem.isDirectory('/workspace/folder')).toBe(false);

    writeText(memory, 208, 'missing/file.txt');
    expect(
      wasi.path_open(3, 0, 208, 16, 1, writableFileRights, 0n, 0, 232)
    ).toBe(44);
    expect(wasi.path_unlink_file(3, 32, 11)).toBe(0);
    expect(wasi.path_remove_directory(3, 32, 11)).toBe(44);
    expect(wasi.path_open(3, 0, 32, 11, 16, writableFileRights, 0n, 0, 240)).toBe(28);

    // A symbolic link is created inside the descriptor's directory with its target as given.
    writeText(memory, 256, 'existing.txt');
    writeText(memory, 272, 'link.txt');
    expect(wasi.path_symlink(256, 12, 3, 272, 8)).toBe(0);
    expect(fileSystem.readlinkSync('/workspace/link.txt')).toBe('existing.txt');
    expect(fileSystem.readText('/workspace/link.txt')).toBe('seed');
    expect(wasi.path_symlink(256, 12, 3, 272, 8)).toBe(20);
    writeText(memory, 288, '../outside.txt');
    expect(wasi.path_symlink(256, 12, 3, 288, 14)).toBe(76);
    expect(wasi.path_symlink(256, 0, 3, 272, 8)).toBe(44);
    expect(wasi.path_symlink(256, 12, 99, 272, 8)).toBe(8);
  });

  test('writes multi-megabyte output buffers through the authoritative VFS', () => {
    const fileSystem = new VirtualFileSystem('/workspace');
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ vfs: fileSystem })
    )({
      version: 'preview1',
      preopens: { '/sandbox': '/workspace' }
    });
    const memory = new WebAssembly.Memory({ initial: 32 });
    host.initialize({ exports: { memory, _initialize: () => undefined } });
    const wasi = wasiImports(host);
    const view = new DataView(memory.buffer);
    writeText(memory, 32, 'large.map');
    expect(
      wasi.path_open(3, 0, 32, 9, 1, writableFileRights, 0n, 0, 64)
    ).toBe(0);
    const fd = view.getUint32(64, true);
    const payloadPointer = 4_096;
    const payloadLength = 1024 * 1024 + 1;
    const payload = new Uint8Array(memory.buffer, payloadPointer, payloadLength);
    payload.fill(0x61);
    payload[payloadLength - 1] = 0x7a;
    view.setUint32(80, payloadPointer, true);
    view.setUint32(84, payloadLength, true);

    expect(wasi.fd_write(fd, 80, 1, 88)).toBe(0);
    expect(view.getUint32(88, true)).toBe(payloadLength);
    const written = fileSystem.readFileSync('/workspace/large.map');
    expect(written).toHaveLength(payloadLength);
    expect(written[0]).toBe(0x61);
    expect(written[payloadLength - 1]).toBe(0x7a);

    view.setUint32(88, payloadPointer, true);
    view.setUint32(92, payloadLength, true);
    expect(wasi.fd_write(fd, 80, 2, 96)).toBe(28);
    expect(fileSystem.readFileSync('/workspace/large.map')).toEqual(written);
  });

  test('keeps readable descriptors authoritative and confines caller preopens', () => {
    const fileSystem = new VirtualFileSystem('/workspace');
    fileSystem.writeFileSync('/workspace/notes.txt', 'first');
    fileSystem.mkdirSync('/outside');
    fileSystem.writeFileSync('/outside/secret.txt', 'secret');
    fileSystem.symlinkSync('/outside/secret.txt', '/workspace/escape.txt');
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ vfs: fileSystem })
    )({
      version: 'preview1',
      preopens: { '/sandbox': '/workspace' }
    });
    const guest = wasiNamespaceImportingInstance(host);
    const memory = guest.exports.memory;
    host.initialize({
      exports: { ...guest.exports, _initialize: () => undefined }
    });
    const wasi = guest.exports;
    const view = new DataView(memory.buffer);
    const readableFileRights =
      (1n << 1n) |
      (1n << 2n) |
      (1n << 5n) |
      (1n << 21n);
    const supportedFileRights =
      readableFileRights |
      (1n << 0n) |
      (1n << 3n) |
      (1n << 4n) |
      (1n << 6n) |
      (1n << 7n) |
      (1n << 8n) |
      (1n << 22n) |
      (1n << 23n);
    const supportedDirectoryRights =
      (1n << 3n) |
      (1n << 4n) |
      (1n << 7n) |
      (1n << 9n) |
      (1n << 10n) |
      (1n << 11n) |
      (1n << 12n) |
      (1n << 13n) |
      (1n << 14n) |
      (1n << 15n) |
      (1n << 16n) |
      (1n << 17n) |
      (1n << 18n) |
      (1n << 19n) |
      (1n << 20n) |
      (1n << 21n) |
      (1n << 23n) |
      (1n << 24n) |
      (1n << 25n) |
      (1n << 26n);
    const portableDirectoryInheritingRights = 0x0fffffffn;
    const portableLibcReadOpenRights = 0x0fbffeben;
    const portableWriteOpenRights = 0x0fffbffdn;

    expect(wasi.fd_fdstat_get(3, 232)).toBe(0);
    expect(view.getBigUint64(240, true)).toBe(supportedDirectoryRights);
    expect(view.getBigUint64(248, true)).toBe(
      portableDirectoryInheritingRights
    );
    expect(wasi.fd_fdstat_set_flags(3, 4)).toBe(0);
    expect(wasi.fd_fdstat_get(3, 232)).toBe(0);
    expect(view.getUint16(234, true)).toBe(4);

    writeText(memory, 32, 'notes.txt');
    expect(
      wasi.path_open(
        3,
        0,
        32,
        9,
        0,
        readableFileRights,
        0n,
        0,
        48
      )
    ).toBe(0);
    const fd = view.getUint32(48, true);

    fileSystem.writeFileSync('/workspace/notes.txt', 'later');
    view.setUint32(64, 128, true);
    view.setUint32(68, 5, true);
    expect(wasi.fd_read(fd, 64, 1, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(5);
    expect(readText(memory, 128, 5)).toBe('later');
    expect(wasi.fd_read(fd, 64, 1, 65_535)).toBe(21);
    expect(wasi.fd_tell(fd, 96)).toBe(0);
    expect(view.getBigUint64(96, true)).toBe(5n);
    expect(wasi.fd_seek(fd, 0n, 0, 65_535)).toBe(21);
    expect(wasi.fd_tell(fd, 96)).toBe(0);
    expect(view.getBigUint64(96, true)).toBe(5n);

    view.setUint32(80, 144, true);
    view.setUint32(84, 2, true);
    expect(wasi.fd_pread(fd, 80, 1, 1n, 88)).toBe(0);
    expect(view.getUint32(88, true)).toBe(2);
    expect(readText(memory, 144, 2)).toBe('at');
    expect(wasi.fd_tell(fd, 96)).toBe(0);
    expect(view.getBigUint64(96, true)).toBe(5n);
    expect(wasi.fd_read(fd, 64, 1, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(0);
    expect(wasi.fd_seek(fd, 0n, 0, 96)).toBe(0);

    writeText(memory, 160, 'escape.txt');
    expect(
      wasi.path_open(
        3,
        1,
        160,
        10,
        0,
        1n << 1n,
        0n,
        0,
        176
      )
    ).toBe(76);
    expect(
      wasi.path_open(
        3,
        0,
        32,
        9,
        0,
        readableFileRights,
        0n,
        0,
        65_535
      )
    ).toBe(21);
    expect(
      wasi.path_open(
        3,
        0,
        32,
        9,
        0,
        readableFileRights,
        0n,
        0,
        224
      )
    ).toBe(0);
    expect(view.getUint32(224, true)).toBe(5);
    writeText(memory, 192, '../outside/secret.txt');
    expect(
      wasi.path_open(
        3,
        0,
        192,
        21,
        0,
        1n << 1n,
        0n,
        0,
        216
      )
    ).toBe(76);
    expect(
      wasi.path_open(
        3,
        0,
        32,
        9,
        0,
        readableFileRights,
        1n << 1n,
        0,
        228
      )
    ).toBe(0);
    const attenuatedFileFd = view.getUint32(228, true);
    expect(wasi.fd_fdstat_get(attenuatedFileFd, 200)).toBe(0);
    expect(view.getBigUint64(208, true)).toBe(readableFileRights);
    expect(view.getBigUint64(216, true)).toBe(0n);
    expect(wasi.fd_close(attenuatedFileFd)).toBe(0);
    expect(
      wasi.path_open(
        3,
        0,
        32,
        9,
        0,
        portableLibcReadOpenRights,
        0n,
        0,
        228
      )
    ).toBe(0);
    const attenuatedLibcFileFd = view.getUint32(228, true);
    expect(wasi.fd_fdstat_get(attenuatedLibcFileFd, 200)).toBe(0);
    expect(view.getBigUint64(208, true)).toBe(
      portableLibcReadOpenRights & supportedFileRights
    );
    expect(wasi.fd_close(attenuatedLibcFileFd)).toBe(0);
    expect(
      wasi.path_open(
        3,
        0,
        32,
        9,
        0,
        portableWriteOpenRights,
        portableDirectoryInheritingRights,
        0,
        228
      )
    ).toBe(0);
    const attenuatedWritableFileFd = view.getUint32(228, true);
    expect(wasi.fd_fdstat_get(attenuatedWritableFileFd, 200)).toBe(0);
    expect(view.getBigUint64(208, true)).toBe(
      portableWriteOpenRights & supportedFileRights
    );
    expect(view.getBigUint64(216, true)).toBe(0n);
    expect(wasi.fd_close(attenuatedWritableFileFd)).toBe(0);
    // A right the runtime does not track (poll_fd_readwrite) is left out, not refused.
    expect(
      wasi.path_open(3, 0, 32, 9, 0, readableFileRights | (1n << 27n), 0n, 0, 228)
    ).toBe(0);
    const pollingFileFd = view.getUint32(228, true);
    expect(wasi.fd_fdstat_get(pollingFileFd, 200)).toBe(0);
    expect(view.getBigUint64(208, true)).toBe(readableFileRights);
    expect(wasi.fd_close(pollingFileFd)).toBe(0);
    // Rust's standard library opens a directory to read it with this mask.
    const rustDirectoryOpenRights = 0x0fa7feben;
    writeText(memory, 32, '.');
    expect(
      wasi.path_open(3, 1, 32, 1, 2, rustDirectoryOpenRights, rustDirectoryOpenRights, 0, 228)
    ).toBe(0);
    const rustDirectoryFd = view.getUint32(228, true);
    expect(wasi.fd_fdstat_get(rustDirectoryFd, 200)).toBe(0);
    expect(view.getBigUint64(208, true)).toBe(rustDirectoryOpenRights & supportedDirectoryRights);
    expect(wasi.fd_close(rustDirectoryFd)).toBe(0);
  });

  test('bounds oversized file reads with partial Preview1 results', () => {
    const fileSystem = new VirtualFileSystem('/workspace');
    const perCallReadLimit = 1_048_576;
    const source = Uint8Array.from(
      { length: perCallReadLimit + 32 },
      (_value, index) => index % 251
    );
    fileSystem.writeFileSync('/workspace/oversized.bin', source);
    const fullFileRead = vi
      .spyOn(fileSystem, 'readFileSync')
      .mockImplementation(() => {
        throw new Error('WASI file reads must not copy the full file');
      });
    const boundedFileRead = vi.spyOn(fileSystem, 'readFileSliceSync');
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ vfs: fileSystem })
    )({
      version: 'preview1',
      preopens: { '/sandbox': '/workspace' }
    });
    const guest = wasiNamespaceImportingInstance(host);
    const memory = guest.exports.memory;
    memory.grow(16);
    host.initialize({
      exports: { ...guest.exports, _initialize: () => undefined }
    });
    const wasi = guest.exports;
    const view = new DataView(memory.buffer);
    const target = 4_096;

    writeText(memory, 32, 'oversized.bin');
    expect(
      wasi.path_open(
        3,
        0,
        32,
        13,
        0,
        writableFileRights,
        0n,
        0,
        48
      )
    ).toBe(0);
    const fd = view.getUint32(48, true);
    view.setUint32(64, target, true);
    view.setUint32(68, source.byteLength, true);

    expect(wasi.fd_read(fd, 64, 1, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(perCallReadLimit);
    // Buffer.compare: toEqual walks a mebibyte element by element, which takes
    // seconds on a CI runner and timed the test out.
    expect(
      Buffer.compare(new Uint8Array(memory.buffer, target, perCallReadLimit), source.subarray(0, perCallReadLimit))
    ).toBe(0);
    expect(wasi.fd_tell(fd, 80)).toBe(0);
    expect(view.getBigUint64(80, true)).toBe(BigInt(perCallReadLimit));

    expect(wasi.fd_pread(fd, 64, 1, 16n, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(perCallReadLimit);
    expect(
      Buffer.compare(new Uint8Array(memory.buffer, target, perCallReadLimit), source.subarray(16, 16 + perCallReadLimit))
    ).toBe(0);
    expect(wasi.fd_tell(fd, 80)).toBe(0);
    expect(view.getBigUint64(80, true)).toBe(BigInt(perCallReadLimit));

    expect(wasi.fd_read(fd, 64, 1, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(32);
    expect(new Uint8Array(memory.buffer, target, 32)).toEqual(
      source.subarray(perCallReadLimit)
    );
    expect(fullFileRead).not.toHaveBeenCalled();
    expect(boundedFileRead.mock.calls).toEqual([
      ['/workspace/oversized.bin', 0, perCallReadLimit],
      ['/workspace/oversized.bin', 16, perCallReadLimit],
      ['/workspace/oversized.bin', perCallReadLimit, perCallReadLimit]
    ]);
  });

  test('opens directories and exposes stable entries, status, and links', () => {
    const fileSystem = new VirtualFileSystem('/workspace');
    fileSystem.mkdirSync('/workspace/folder');
    fileSystem.mkdirSync('/workspace/folder/nested');
    fileSystem.writeFileSync('/workspace/folder/a.txt', 'A');
    fileSystem.writeFileSync('/workspace/sibling.txt', 'sibling');
    fileSystem.symlinkSync('a.txt', '/workspace/folder/alias');
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ vfs: fileSystem })
    )({
      version: 'preview1',
      preopens: { '/sandbox': '/workspace' }
    });
    const guest = wasiNamespaceImportingInstance(host);
    const memory = guest.exports.memory;
    host.initialize({
      exports: { ...guest.exports, _initialize: () => undefined }
    });
    const wasi = guest.exports;
    const view = new DataView(memory.buffer);
    const readableDirectoryRights =
      (1n << 3n) |
      (1n << 13n) |
      (1n << 14n) |
      (1n << 15n) |
      (1n << 18n) |
      (1n << 21n);
    const supportedDirectoryRights =
      readableDirectoryRights |
      (1n << 4n) |
      (1n << 7n) |
      (1n << 9n) |
      (1n << 10n) |
      (1n << 11n) |
      (1n << 12n) |
      (1n << 16n) |
      (1n << 17n) |
      (1n << 19n) |
      (1n << 20n) |
      (1n << 23n) |
      (1n << 24n) |
      (1n << 25n) |
      (1n << 26n);
    const readableFileRights =
      (1n << 1n) |
      (1n << 2n) |
      (1n << 5n) |
      (1n << 21n);
    const portableDirectoryBaseRights = 0x0ff7feben;
    const portableDirectoryInheritingRights = 0x0fffffffn;

    writeText(memory, 704, 'folder');
    expect(
      wasi.path_open(
        3,
        0,
        704,
        6,
        2,
        portableDirectoryBaseRights,
        portableDirectoryInheritingRights,
        0,
        712
      )
    ).toBe(0);
    const portableDirectoryFd = view.getUint32(712, true);
    expect(wasi.fd_fdstat_get(portableDirectoryFd, 720)).toBe(0);
    expect(view.getBigUint64(728, true)).toBe(
      portableDirectoryBaseRights & supportedDirectoryRights
    );
    expect(view.getBigUint64(736, true)).toBe(
      portableDirectoryInheritingRights
    );
    expect(wasi.fd_close(portableDirectoryFd)).toBe(0);

    // Rust's standard library reads a directory through an open with NONBLOCK
    // and the portable libc read rights; nothing blocks here, so it is kept.
    expect(
      wasi.path_open(3, 1, 704, 6, 2, 0x0fbffeben, portableDirectoryInheritingRights, 4, 712)
    ).toBe(0);
    const nonblockingDirectoryFd = view.getUint32(712, true);
    expect(wasi.fd_fdstat_get(nonblockingDirectoryFd, 720)).toBe(0);
    expect(view.getUint16(722, true)).toBe(4);
    expect(wasi.fd_close(nonblockingDirectoryFd)).toBe(0);

    writeText(memory, 32, 'folder');
    expect(
      wasi.path_open(
        3,
        0,
        32,
        6,
        2,
        readableDirectoryRights,
        readableFileRights,
        0,
        48
      )
    ).toBe(0);
    const directoryFd = view.getUint32(48, true);
    expect(wasi.fd_fdstat_get(directoryFd, 552)).toBe(0);
    expect(view.getBigUint64(560, true)).toBe(readableDirectoryRights);
    expect(view.getBigUint64(568, true)).toBe(readableFileRights);

    writeText(memory, 688, 'a.txt');
    expect(
      wasi.path_open(directoryFd, 0, 688, 5, 0, 1n << 6n, 0n, 0, 696)
    ).toBe(76);
    writeText(memory, 744, 'nested');
    expect(
      wasi.path_open(
        directoryFd,
        0,
        744,
        6,
        2,
        0n,
        1n << 6n,
        0,
        752
      )
    ).toBe(76);
    expect(
      wasi.path_open(
        directoryFd,
        0,
        744,
        6,
        2,
        readableDirectoryRights | 1n,
        readableFileRights,
        0,
        752
      )
    ).toBe(76);

    writeText(memory, 620, '../sibling.txt');
    expect(
      wasi.path_open(
        directoryFd,
        0,
        620,
        14,
        0,
        (1n << 1n) | (1n << 2n) | (1n << 5n) | (1n << 21n),
        0n,
        0,
        640
      )
    ).toBe(0);
    expect(wasi.fd_close(view.getUint32(640, true))).toBe(0);
    writeText(memory, 660, '../../outside');
    expect(
      wasi.path_open(directoryFd, 0, 660, 13, 0, 1n << 1n, 0n, 0, 680)
    ).toBe(76);

    expect(wasi.fd_readdir(directoryFd, 128, 128, 0n, 65_535)).toBe(21);
    expect(wasi.fd_readdir(directoryFd, 128, 128, 0n, 64)).toBe(0);
    const used = view.getUint32(64, true);
    expect(readDirectoryEntries(memory, 128, used)).toEqual([
      { cookie: 1n, inode: expect.any(BigInt), name: 'a.txt', type: 4 },
      { cookie: 2n, inode: expect.any(BigInt), name: 'alias', type: 7 },
      { cookie: 3n, inode: expect.any(BigInt), name: 'nested', type: 3 }
    ]);
    expect(wasi.fd_readdir(directoryFd, 128, 128, 1n, 64)).toBe(0);
    expect(readDirectoryEntries(memory, 128, view.getUint32(64, true))).toEqual([
      { cookie: 2n, inode: expect.any(BigInt), name: 'alias', type: 7 },
      { cookie: 3n, inode: expect.any(BigInt), name: 'nested', type: 3 }
    ]);

    writeText(memory, 272, 'alias');
    expect(
      wasi.path_filestat_get(directoryFd, 0, 272, 5, 288)
    ).toBe(0);
    expect(view.getUint8(304)).toBe(7);
    expect(
      wasi.path_filestat_get(directoryFd, 1, 272, 5, 352)
    ).toBe(0);
    expect(view.getUint8(368)).toBe(4);
    expect(view.getBigUint64(384, true)).toBe(1n);
    expect(
      wasi.path_readlink(directoryFd, 272, 5, 432, 16, 448)
    ).toBe(0);
    expect(readText(memory, 432, view.getUint32(448, true))).toBe('a.txt');
    expect(
      wasi.path_filestat_get(directoryFd, 2, 272, 5, 288)
    ).toBe(28);
    writeText(memory, 456, 'a.txt');
    expect(
      wasi.path_readlink(directoryFd, 456, 5, 432, 16, 448)
    ).toBe(28);
    writeText(memory, 464, 'missing');
    expect(
      wasi.path_open(
        directoryFd,
        0,
        464,
        7,
        0,
        1n << 1n,
        0n,
        0,
        472
      )
    ).toBe(44);

    expect(wasi.fd_filestat_get(directoryFd, 480)).toBe(0);
    expect(view.getUint8(496)).toBe(3);
    expect(wasi.fd_close(directoryFd)).toBe(0);
    expect(wasi.fd_readdir(directoryFd, 128, 128, 0n, 64)).toBe(8);
    expect(wasi.fd_readdir(999, 128, 128, 0n, 64)).toBe(8);
    expect(wasi.path_filestat_get(3, 0, 65_535, 8, 288)).toBe(21);
    writeText(memory, 600, 'folder/alias');
    expect(wasi.path_filestat_get(3, 0, 600, 12, 65_535)).toBe(21);
    expect(wasi.path_readlink(3, 600, 12, 65_535, 16, 448)).toBe(21);
    expect(wasi.fd_readdir(3, 65_535, 128, 0n, 64)).toBe(21);
  });

  test('fails closed when the VFS cannot prove realpath confinement', () => {
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({
        vfs: {
          readFileSync: () => new TextEncoder().encode('secret'),
          isDirectory: (path) => path === '/workspace',
          isFile: (path) => path === '/workspace/escape.txt'
        }
      })
    )({
      version: 'preview1',
      preopens: { '/sandbox': '/workspace' }
    });
    const guest = wasiNamespaceImportingInstance(host);
    host.initialize({
      exports: { ...guest.exports, _initialize: () => undefined }
    });
    writeText(guest.exports.memory, 32, 'escape.txt');

    expect(
      guest.exports.path_open(3, 0, 32, 10, 0, 1n << 1n, 0n, 0, 48)
    ).toBe(52);
  });

  test('links and retimes the file a symbolic link names only when asked, and only inside the preopen', () => {
    const fileSystem = new VirtualFileSystem('/project');
    fileSystem.mkdirSync('/project/sandbox', { recursive: true });
    fileSystem.writeFileSync('/project/sandbox/inside.txt', 'inside');
    fileSystem.mkdirSync('/secret');
    fileSystem.writeFileSync('/secret/key.txt', 'key');
    const secretTime = fileSystem.statSync('/secret/key.txt').mtime.getTime();
    const { wasi, memory } = preview1Host(fileSystem, { '/sandbox': '/project/sandbox' });
    writeText(memory, 32, '/secret/key.txt');
    writeText(memory, 64, 's');
    writeText(memory, 72, 'h');
    writeText(memory, 80, 'inside.txt');
    writeText(memory, 96, 'l');
    expect(wasi.path_symlink(32, 15, 3, 64, 1)).toBe(0);
    expect(wasi.path_symlink(80, 10, 3, 96, 1)).toBe(0);

    // Without LOOKUP_SYMLINK_FOLLOW, linkat links the symbolic link itself,
    // which the VFS cannot do; following it would leave the preopen.
    expect(wasi.path_link(3, 0, 64, 1, 3, 72, 1)).toBe(63);
    expect(wasi.path_link(3, 1, 64, 1, 3, 72, 1)).toBe(76);
    expect(wasi.path_link(3, 2, 64, 1, 3, 72, 1)).toBe(28);
    expect(fileSystem.existsSync('/project/sandbox/h')).toBe(false);
    expect(wasi.path_link(3, 1, 96, 1, 3, 72, 1)).toBe(0);
    expect(fileSystem.lstatSync('/project/sandbox/h').isSymbolicLink()).toBe(false);
    expect(fileSystem.readText('/project/sandbox/h')).toBe('inside');

    expect(wasi.path_filestat_set_times(3, 1, 64, 1, 0n, 1_000_000_000_000n, 4)).toBe(76);
    expect(wasi.path_filestat_set_times(3, 0, 64, 1, 0n, 1_000_000_000_000n, 4)).toBe(0);
    expect(wasi.path_filestat_set_times(3, 2, 64, 1, 0n, 1_000_000_000_000n, 4)).toBe(28);
    expect(fileSystem.statSync('/secret/key.txt').mtime.getTime()).toBe(secretTime);
    expect(fileSystem.readText('/secret/key.txt')).toBe('key');
    expect(wasi.path_filestat_set_times(3, 1, 96, 1, 0n, 1_000_000_000_000n, 4)).toBe(0);
    expect(fileSystem.statSync('/project/sandbox/inside.txt').mtime.getTime()).toBe(1_000_000);
  });

  test('checks the right of each operation that resizes, writes at an offset, retimes, renames or links', () => {
    const fileSystem = new VirtualFileSystem('/project');
    fileSystem.mkdirSync('/project/sandbox/dir', { recursive: true });
    fileSystem.writeFileSync('/project/sandbox/a.txt', 'hello');
    const { wasi, memory, view } = preview1Host(fileSystem, { '/sandbox': '/project/sandbox' });
    const fdRead = 1n << 1n;
    const fdSeek = 1n << 2n;
    const fdWrite = 1n << 6n;
    const fdAllocate = 1n << 8n;
    const fdFilestatSetSize = 1n << 22n;
    const fdFilestatSetTimes = 1n << 23n;
    writeText(memory, 32, 'a.txt');
    writeText(memory, 48, 'b.txt');
    writeText(memory, 64, 'dir');
    writeText(memory, 80, 'x');
    writeText(memory, 96, '.');
    writeText(memory, 112, 'XY');
    view.setUint32(128, 112, true);
    view.setUint32(132, 2, true);

    // A file opened to read is not resized or written, whatever else it asked for.
    expect(wasi.path_open(3, 0, 32, 5, 0, fdRead | fdSeek | fdAllocate | fdFilestatSetSize, 0n, 0, 16)).toBe(0);
    const readOnlyFd = view.getUint32(16, true);
    expect(wasi.fd_filestat_set_size(readOnlyFd, 0n)).toBe(76);
    expect(wasi.fd_allocate(readOnlyFd, 0n, 64n)).toBe(76);
    expect(wasi.fd_pwrite(readOnlyFd, 128, 1, 0n, 136)).toBe(76);
    // A writable file still needs each operation's own right.
    expect(wasi.path_open(3, 0, 32, 5, 0, fdWrite, 0n, 0, 16)).toBe(0);
    const writeOnlyFd = view.getUint32(16, true);
    expect(wasi.fd_filestat_set_size(writeOnlyFd, 0n)).toBe(76);
    expect(wasi.fd_allocate(writeOnlyFd, 0n, 64n)).toBe(76);
    expect(wasi.fd_filestat_set_times(writeOnlyFd, 0n, 1_000_000_000_000n, 4)).toBe(76);
    expect(wasi.fd_pwrite(writeOnlyFd, 128, 1, 0n, 136)).toBe(76);
    expect(fileSystem.readText('/project/sandbox/a.txt')).toBe('hello');

    const resizingRights = fdWrite | fdSeek | fdAllocate | fdFilestatSetSize | fdFilestatSetTimes;
    expect(wasi.path_open(3, 0, 32, 5, 0, resizingRights, 0n, 0, 16)).toBe(0);
    const resizingFd = view.getUint32(16, true);
    expect(wasi.fd_fdstat_get(resizingFd, 192)).toBe(0);
    expect(view.getBigUint64(200, true)).toBe(resizingRights);
    expect(wasi.fd_pwrite(resizingFd, 128, 1, 0n, 136)).toBe(0);
    expect(wasi.fd_filestat_set_size(resizingFd, 3n)).toBe(0);
    expect(wasi.fd_allocate(resizingFd, 0n, 4n)).toBe(0);
    expect(wasi.fd_filestat_set_times(resizingFd, 0n, 1_000_000_000_000n, 4)).toBe(0);
    expect(Array.from(fileSystem.readFileSync('/project/sandbox/a.txt'))).toEqual([88, 89, 108, 0]);
    expect(fileSystem.statSync('/project/sandbox/a.txt').mtime.getTime()).toBe(1_000_000);

    // A directory opened only to look things up renames, links and retimes nothing.
    const pathOpen = 1n << 13n;
    expect(wasi.path_open(3, 0, 64, 3, 2, pathOpen, 0n, 0, 16)).toBe(0);
    const lookupFd = view.getUint32(16, true);
    expect(wasi.path_rename(3, 32, 5, lookupFd, 80, 1)).toBe(76);
    expect(wasi.path_rename(lookupFd, 80, 1, 3, 48, 5)).toBe(76);
    expect(wasi.path_link(3, 0, 32, 5, lookupFd, 80, 1)).toBe(76);
    expect(wasi.path_link(lookupFd, 0, 80, 1, 3, 48, 5)).toBe(76);
    expect(wasi.path_filestat_set_times(lookupFd, 0, 96, 1, 0n, 1_000_000_000_000n, 4)).toBe(76);
    expect(wasi.fd_filestat_set_times(lookupFd, 0n, 1_000_000_000_000n, 4)).toBe(76);
    expect(fileSystem.existsSync('/project/sandbox/dir/x')).toBe(false);
    // The preopen holds them all.
    expect(wasi.path_link(3, 0, 32, 5, 3, 48, 5)).toBe(0);
    expect(wasi.path_rename(3, 48, 5, 3, 80, 1)).toBe(0);
    expect(fileSystem.readFileSync('/project/sandbox/x').byteLength).toBe(4);
  });

  test('opens and retimes the capability root itself, but removes, renames, replaces or recreates it never', () => {
    const fileSystem = new VirtualFileSystem('/project');
    fileSystem.mkdirSync('/project/a/sub', { recursive: true });
    fileSystem.mkdirSync('/project/b');
    fileSystem.writeFileSync('/project/a/f.txt', 'f');
    const { wasi, memory, view } = preview1Host(fileSystem, { '/a': '/project/a', '/b': '/project/b' });
    writeText(memory, 32, '.');
    writeText(memory, 40, 'x');
    writeText(memory, 48, 'f.txt');
    writeText(memory, 64, 'sub');
    writeText(memory, 72, '..');

    expect(wasi.path_remove_directory(3, 32, 1)).toBe(28);
    expect(wasi.path_rename(3, 32, 1, 4, 40, 1)).toBe(10);
    expect(wasi.path_rename(3, 48, 5, 4, 32, 1)).toBe(10);
    expect(wasi.path_unlink_file(3, 32, 1)).toBe(31);
    expect(wasi.path_create_directory(3, 32, 1)).toBe(20);
    expect(wasi.path_symlink(48, 5, 3, 32, 1)).toBe(20);
    expect(wasi.path_link(3, 0, 48, 5, 4, 32, 1)).toBe(20);
    // A directory below the root reaches it as `..`, and is held to the same.
    expect(wasi.path_open(3, 0, 64, 3, 2, (1n << 13n) | (1n << 16n) | (1n << 25n), 0n, 0, 16)).toBe(0);
    const subdirectoryFd = view.getUint32(16, true);
    expect(wasi.path_remove_directory(subdirectoryFd, 72, 2)).toBe(28);
    expect(wasi.path_rename(subdirectoryFd, 72, 2, 4, 40, 1)).toBe(10);
    expect(fileSystem.readdirSync('/project/a').sort()).toEqual(['f.txt', 'sub']);
    expect(fileSystem.readdirSync('/project/b')).toEqual([]);

    expect(wasi.path_filestat_get(3, 0, 32, 1, 128)).toBe(0);
    expect(view.getUint8(128 + 16)).toBe(3);
    expect(wasi.path_filestat_set_times(3, 0, 32, 1, 0n, 1_000_000_000_000n, 4)).toBe(0);
    expect(fileSystem.statSync('/project/a').mtime.getTime()).toBe(1_000_000);
    expect(wasi.path_open(3, 0, 32, 1, 2, 1n << 13n, 0n, 0, 16)).toBe(0);
  });

  test('closes a file fd_renumber moved below 3 but never standard input, output or error, and reports millisecond clocks', () => {
    const fileSystem = new VirtualFileSystem('/project');
    fileSystem.mkdirSync('/project/sandbox', { recursive: true });
    fileSystem.writeFileSync('/project/sandbox/a.txt', 'a');
    const { wasi, memory, view } = preview1Host(fileSystem, { '/sandbox': '/project/sandbox' });
    writeText(memory, 32, 'a.txt');
    expect(wasi.path_open(3, 0, 32, 5, 0, 1n << 1n, 0n, 0, 16)).toBe(0);
    expect(wasi.path_open(3, 0, 32, 5, 0, 1n << 1n, 0n, 0, 20)).toBe(0);
    const [first, second] = [view.getUint32(16, true), view.getUint32(20, true)];

    expect(wasi.fd_renumber(first, 1)).toBe(0);
    expect(wasi.fd_close(1)).toBe(0);
    expect(wasi.fd_close(1)).toBe(8);
    expect(wasi.fd_close(2)).toBe(8);
    expect(wasi.fd_renumber(0, second)).toBe(0);
    expect(wasi.fd_close(second)).toBe(8);

    for (const clock of [0, 1]) {
      expect(wasi.clock_res_get(clock, 64)).toBe(0);
      expect(view.getBigUint64(64, true)).toBe(1_000_000n);
    }
  });

  test('projects args, environment, preopens, and bounded VFS reads through Wasm memory', () => {
    const stdout: Uint8Array[] = [];
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({
        stdout: { write: (chunk) => stdout.push(chunk.slice()) },
        vfs: {
          readFileSync: (path) => {
            if (path !== '/workspace/notes.txt') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return new TextEncoder().encode('hello');
          },
          readFileSliceSync: (path, offset, length) => {
            if (path !== '/workspace/notes.txt') throw Object.assign(new Error('missing'), { code: 'ENOENT' });
            return new TextEncoder().encode('hello').slice(offset, offset + length);
          },
          realpathSync: (path) => path,
          lstatSync: (path) => ({
            size: path.endsWith('notes.txt') ? 5 : 0,
            ino: 1,
            ctime: new Date(0),
            mtime: new Date(0),
            isDirectory: () => path === '/workspace',
            isFile: () => path === '/workspace/notes.txt',
            isSymbolicLink: () => false
          }),
          isDirectory: (path) => path === '/workspace',
          isFile: (path) => path === '/workspace/notes.txt'
        }
      })
    )({
      version: 'preview1',
      args: ['guest', 'α'],
      env: { FOO: 'bar' },
      preopens: { '/sandbox': '/workspace' }
    });
    const instance = seekImportingInstance(host);
    const memory = instance.exports.memory as WebAssembly.Memory;

    expect(host.start(instance)).toBeUndefined();
    expect(wasiImports(host).args_sizes_get(0, 4)).toBe(0);
    expect(new DataView(memory.buffer).getUint32(0, true)).toBe(2);
    expect(new DataView(memory.buffer).getUint32(4, true)).toBe(9);
    expect(wasiImports(host).args_get(8, 32)).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 32, 6))).toBe('guest\0');
    expect(wasiImports(host).environ_sizes_get(48, 52)).toBe(0);
    expect(new DataView(memory.buffer).getUint32(48, true)).toBe(1);
    expect(new DataView(memory.buffer).getUint32(52, true)).toBe(8);
    expect(wasiImports(host).environ_get(56, 80)).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 80, 8))).toBe('FOO=bar\0');
    expect(wasiImports(host).fd_prestat_get(3, 96)).toBe(0);
    expect(new DataView(memory.buffer).getUint32(100, true)).toBe(8);
    expect(wasiImports(host).fd_prestat_dir_name(3, 108, 8)).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 108, 8))).toBe('/sandbox');

    const filename = new TextEncoder().encode('notes.txt');
    new Uint8Array(memory.buffer, 128, filename.byteLength).set(filename);
    expect(
      wasiImports(host).path_open(
        3,
        0,
        128,
        filename.byteLength,
        0,
        (1n << 1n) | (1n << 2n),
        0n,
        0,
        144
      )
    ).toBe(0);
    const fd = new DataView(memory.buffer).getUint32(144, true);
    new DataView(memory.buffer).setUint32(160, 200, true);
    new DataView(memory.buffer).setUint32(164, 5, true);
    expect(wasiImports(host).fd_read(fd, 160, 1, 168)).toBe(0);
    expect(new DataView(memory.buffer).getUint32(168, true)).toBe(5);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 200, 5))).toBe('hello');
    expect(instance.exports.seekToStart(fd)).toBe(0);
    expect(new DataView(memory.buffer).getBigUint64(256, true)).toBe(0n);
    new DataView(memory.buffer).setUint32(160, 205, true);
    new DataView(memory.buffer).setUint32(164, 1, true);
    expect(wasiImports(host).fd_read(fd, 160, 1, 168)).toBe(0);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 205, 1))).toBe('h');
    new Uint8Array(memory.buffer, 220, 3).set(new TextEncoder().encode('../'));
    expect(wasiImports(host).path_open(3, 0, 220, 3, 0, 0n, 0n, 0, 224)).toBe(76);
    expect(stdout).toEqual([]);
  });

  test('returns proc_exit code by default, delegates explicit non-returning exits, and enforces one lifecycle', () => {
    const returning = createWasiNodeAdapterFactory(runtimeOptions())({ version: 'preview1' });
    const instance = exitInstance(returning, 7);

    expect(returning.start(instance)).toBe(7);
    expect(() => returning.start(instance)).toThrow('exactly once');
    expect(() => returning.initialize(instance)).toThrow('exactly once');

    const exit = vi.fn((code: number): never => {
      throw new Error(`runtime exit ${code}`);
    });
    const nonReturning = createWasiNodeAdapterFactory(runtimeOptions({ exit }))({
      version: 'preview1',
      exitMode: 'terminate'
    });

    expect(() => nonReturning.start(exitInstance(nonReturning, 9))).toThrow('runtime exit 9');
    expect(exit).toHaveBeenCalledWith(9);
  });

  test('uses SharedArrayBuffer memory for bounded iovecs, deterministic random bytes, and clocks', () => {
    const output: Uint8Array[] = [];
    const stdin = vi.fn(() => new TextEncoder().encode('in'));
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({
        stdin: { read: stdin },
        stdout: { write: (chunk) => output.push(chunk) }
      })
    )({ version: 'preview1' });
    const memory = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
    const initialize = vi.fn();
    const instance = { exports: { memory, _initialize: initialize } };

    expect(memory.buffer).toBeInstanceOf(SharedArrayBuffer);
    host.initialize(instance);
    expect(initialize).toHaveBeenCalledOnce();
    new Uint8Array(memory.buffer, 100, 2).set(new TextEncoder().encode('ok'));
    const view = new DataView(memory.buffer);
    view.setUint32(80, 100, true);
    view.setUint32(84, 2, true);
    expect(wasiImports(host).fd_write(1, 80, 1, 88)).toBe(0);
    expect(view.getUint32(88, true)).toBe(2);
    expect(new TextDecoder().decode(output[0])).toBe('ok');
    expect(output[0].buffer).not.toBeInstanceOf(SharedArrayBuffer);
    view.setUint32(92, 104, true);
    view.setUint32(96, 2, true);
    expect(wasiImports(host).fd_read(0, 92, 1, 100)).toBe(0);
    expect(view.getUint32(100, true)).toBe(2);
    expect(new TextDecoder().decode(new Uint8Array(memory.buffer, 104, 2))).toBe('in');
    expect(stdin).toHaveBeenCalledWith(2);
    expect(wasiImports(host).fd_write(1, 80, 1_025, 88)).toBe(28);
    expect(wasiImports(host).random_get(120, 4)).toBe(0);
    expect([...new Uint8Array(memory.buffer, 120, 4)]).toEqual([1, 2, 3, 4]);
    expect(wasiImports(host).clock_time_get(0, 0n, 128)).toBe(0);
    expect(view.getBigUint64(128, true)).toBe(123_000_000n);
    expect(wasiImports(host).clock_time_get(1, 0n, 128)).toBe(0);
    expect(view.getBigUint64(128, true)).toBe(456_000_000n);
    expect(wasiImports(host).clock_time_get(2, 0n, 128)).toBe(52);
    expect(wasiImports(host).clock_time_get(99, 0n, 128)).toBe(28);
    expect(wasiImports(host).fd_fdstat_get(1, 136)).toBe(0);
    expect(view.getUint8(136)).toBe(2);
    expect(wasiImports(host).fd_filestat_get(1, 168)).toBe(0);
    expect(view.getUint8(184)).toBe(2);
    expect(wasiImports(host).sched_yield()).toBe(0);

    const largeRandom = createWasiNodeAdapterFactory(runtimeOptions({ randomBytes: undefined }))({
      version: 'preview1'
    });
    const largeMemory = new WebAssembly.Memory({ initial: 2 });
    largeRandom.initialize({ exports: { memory: largeMemory, _initialize: () => undefined } });
    expect(wasiImports(largeRandom).random_get(0, 65_537)).toBe(0);
  });

  test('returns EAGAIN instead of blocking an empty nonblocking stdin', () => {
    const read = vi.fn(() => new Uint8Array());
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ stdin: { available: () => 0, read } })
    )({ version: 'preview1' });
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.initialize({ exports: { memory, _initialize: () => undefined } });
    const view = new DataView(memory.buffer);
    view.setUint32(64, 80, true);
    view.setUint32(68, 16, true);

    expect(wasiImports(host).fd_fdstat_set_flags(0, 4)).toBe(0);
    expect(wasiImports(host).fd_read(0, 64, 1, 72)).toBe(6);
    expect(read).not.toHaveBeenCalled();
  });

  test('waits for standard input before reporting a read poll ready', () => {
    let available = 0;
    const waits: Array<[number, number | undefined]> = [];
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({
        stdin: {
          available: () => available,
          wait: (observed, timeoutMilliseconds) => {
            waits.push([observed, timeoutMilliseconds]);
            available = 3;
          },
          read: () => new Uint8Array(3)
        }
      })
    )({ version: 'preview1' });
    const { view, wasi } = pollingGuest(host);

    writeClockSubscription(view, 1024, 14n, 5_000_000_000n);
    writeDescriptorSubscription(view, 1072, 15n, 1, 0);
    expect(wasi.poll_oneoff(1024, 2048, 2, 3072)).toBe(0);

    expect(view.getUint32(3072, true)).toBe(1);
    expect(readPollEvent(view, 2048)).toEqual({ userdata: 15n, error: 0, type: 1, nbytes: 3n, flags: 0 });
    expect(waits).toHaveLength(1);
    expect(waits[0][0]).toBe(0);
    expect(waits[0][1]).toBeGreaterThan(4_900);
    expect(waits[0][1]).toBeLessThanOrEqual(5_000);
  });

  test('reports the clock when standard input stays empty until the timeout', () => {
    const sleep = new Int32Array(new SharedArrayBuffer(4));
    const wait = vi.fn((_observed: number, timeoutMilliseconds?: number) => {
      Atomics.wait(sleep, 0, 0, timeoutMilliseconds);
    });
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ stdin: { available: () => 0, wait, read: () => new Uint8Array() } })
    )({ version: 'preview1' });
    const { view, wasi } = pollingGuest(host);

    writeClockSubscription(view, 1024, 14n, 20_000_000n);
    writeDescriptorSubscription(view, 1072, 15n, 1, 0);
    const started = performance.now();
    expect(wasi.poll_oneoff(1024, 2048, 2, 3072)).toBe(0);

    expect(performance.now() - started).toBeGreaterThanOrEqual(19);
    expect(view.getUint32(3072, true)).toBe(1);
    expect(readPollEvent(view, 2048)).toMatchObject({ userdata: 14n, error: 0, type: 0 });
    expect(wait).toHaveBeenCalledWith(0, expect.any(Number));
  });

  test('waits for standard input without a timeout when no clock is subscribed, and reports its end', () => {
    let available = 0;
    const wait = vi.fn((_observed: number, _timeoutMilliseconds?: number) => {
      available = -1;
    });
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ stdin: { available: () => available, wait, read: () => undefined } })
    )({ version: 'preview1' });
    const { view, wasi } = pollingGuest(host);

    writeDescriptorSubscription(view, 1024, 15n, 1, 0);
    expect(wasi.poll_oneoff(1024, 2048, 1, 3072)).toBe(0);

    expect(wait).toHaveBeenCalledWith(0, undefined);
    // End of input is readable: a read returns at once, with nothing.
    expect(readPollEvent(view, 2048)).toEqual({ userdata: 15n, error: 0, type: 1, nbytes: 0n, flags: 1 });
  });

  test('answers a zero-timeout poll at once while standard input is empty', () => {
    const wait = vi.fn();
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ stdin: { available: () => 0, wait, read: () => new Uint8Array() } })
    )({ version: 'preview1' });
    const { view, wasi } = pollingGuest(host);

    writeClockSubscription(view, 1024, 14n, 0n);
    writeDescriptorSubscription(view, 1072, 15n, 1, 0);
    writeDescriptorSubscription(view, 1120, 16n, 2, 1);
    expect(wasi.poll_oneoff(1024, 2048, 3, 3072)).toBe(0);

    expect(wait).not.toHaveBeenCalled();
    expect(view.getUint32(3072, true)).toBe(2);
    expect(readPollEvent(view, 2048)).toMatchObject({ userdata: 14n, type: 0 });
    expect(readPollEvent(view, 2080)).toMatchObject({ userdata: 16n, type: 2, error: 0 });
  });

  test('reads ended standard input as end of file, not EAGAIN, on a nonblocking descriptor', () => {
    const read = vi.fn(() => undefined);
    const host = createWasiNodeAdapterFactory(
      runtimeOptions({ stdin: { available: () => -1, wait: vi.fn(), read } })
    )({ version: 'preview1' });
    const memory = new WebAssembly.Memory({ initial: 1 });
    host.initialize({ exports: { memory, _initialize: () => undefined } });
    const view = new DataView(memory.buffer);
    view.setUint32(64, 80, true);
    view.setUint32(68, 16, true);
    view.setUint32(72, 99, true);

    expect(wasiImports(host).fd_fdstat_set_flags(0, 4)).toBe(0);
    expect(wasiImports(host).fd_read(0, 64, 1, 72)).toBe(0);
    expect(view.getUint32(72, true)).toBe(0);
    expect(read).toHaveBeenCalledWith(16);
  });

  test('publishes standard input arriving and ending in its status word, and wakes a waiting reader', async () => {
    let deliver!: (chunk: Uint8Array | undefined) => void;
    const input = {
      read: () => new Promise<Uint8Array | undefined>((resolve) => {
        deliver = resolve;
      })
    };
    const observed: Array<number | string> = [];
    const program = createWasiRuntimeProgram({
      createWorker: () =>
        new TestWasiRuntimeWorker(async (message) => {
          const words = synchronousChannelWords(message.stdin);
          observed.push(Atomics.load(words, WASI_STDIN_AVAILABLE_WORD));
          const arrival = Atomics.waitAsync(words, WASI_STDIN_AVAILABLE_WORD, 0, 5_000);
          deliver(new TextEncoder().encode('abc'));
          observed.push(await arrival.value, Atomics.load(words, WASI_STDIN_AVAILABLE_WORD));
          return 0;
        })
    });

    await expect(
      program.run(['/workspace/tool.wasm'], {
        cwd: '/workspace',
        env: {},
        fs: runtimeProgramFileSystem(async () => wasiRuntimeProcessProgram.slice()),
        writer: { write: () => undefined },
        input,
        executionContext: { id: 22, openWorker: (createWorker) => createWorker() }
      })
    ).resolves.toBe(0);
    expect(observed).toEqual([0, 'ok', 3]);

    // Without process input, standard input has ended from the start.
    const ended: number[] = [];
    const withoutInput = createWasiRuntimeProgram({
      createWorker: () =>
        new TestWasiRuntimeWorker(async (message) => {
          ended.push(Atomics.load(synchronousChannelWords(message.stdin), WASI_STDIN_AVAILABLE_WORD));
          return 0;
        })
    });
    await withoutInput.run(['/workspace/tool.wasm'], {
      cwd: '/workspace',
      env: {},
      fs: runtimeProgramFileSystem(async () => wasiRuntimeProcessProgram.slice()),
      writer: { write: () => undefined },
      executionContext: { id: 24, openWorker: (createWorker) => createWorker() }
    });
    expect(ended).toEqual([WASI_STDIN_ENDED]);
  });

  test('runs an admitted command with argv, env, cwd, stdio, exit, and signal semantics', async () => {
    const program = createWasiRuntimeProgram({
      createWorker: () => new TestWasiRuntimeWorker()
    });
    const stdout: Uint8Array[] = [];
    const stderr: Uint8Array[] = [];
    const closeSynchronousMailbox = vi.fn(async () => undefined);

    await expect(
      program.run(['/workspace/tool.wasm', 'argument'], {
        cwd: '/workspace/current',
        env: { TOKEN: 'present' },
        fs: runtimeProgramFileSystem(
          async () => wasiRuntimeProcessProgram.slice(),
          closeSynchronousMailbox
        ),
        writer: { write: (chunk) => stdout.push(chunk.slice()) },
        errorWriter: { write: (chunk) => stderr.push(chunk.slice()) },
        executionContext: {
          id: 19,
          openWorker: (createWorker) => createWorker()
        }
      })
    ).resolves.toBe(7);

    const output = new TextDecoder().decode(concatenate(stdout));
    expect(output).toContain('/workspace/tool.wasm\0argument\0');
    expect(output).toContain('TOKEN=present\0');
    expect(output).toContain('PWD=/workspace/current\0');
    expect(new TextDecoder().decode(concatenate(stderr))).toBe('stderr=observed\n');
    expect(closeSynchronousMailbox).toHaveBeenCalledWith(
      'wasi-execution-context:19:process:0'
    );

    let releaseRead!: (bytes: Uint8Array) => void;
    const read = new Promise<Uint8Array>((resolve) => {
      releaseRead = resolve;
    });
    let deliverSignal!: (signal: 'SIGTERM') => void;
    const signal = new Promise<'SIGTERM'>((resolve) => {
      deliverSignal = resolve;
    });
    const signalled = program.run(['/workspace/tool.wasm'], {
      cwd: '/workspace',
      env: {},
      fs: runtimeProgramFileSystem(() => read),
      writer: { write: () => undefined },
      signal,
      executionContext: {
        id: 20,
        openWorker: (createWorker) => createWorker()
      }
    });
    deliverSignal('SIGTERM');
    releaseRead(wasiRuntimeProcessProgram.slice());
    await expect(signalled).resolves.toBe(143);
  });

  test('rejects and cleans up when the run request cannot be cloned', async () => {
    const closeSynchronousMailbox = vi.fn(async () => undefined);
    const fileSystem = runtimeProgramFileSystem(
      async () => wasiRuntimeProcessProgram.slice(),
      closeSynchronousMailbox
    );
    const openSynchronousMailbox = fileSystem.openSynchronousMailbox;
    fileSystem.openSynchronousMailbox = async (contextId) => {
      const mailbox = await openSynchronousMailbox(contextId);
      Object.defineProperty(mailbox, 'notCloneable', {
        enumerable: true,
        value: () => undefined
      });
      return mailbox;
    };
    const program = createWasiRuntimeProgram({
      createWorker: () => new TestWasiRuntimeWorker()
    });

    await expect(
      program.run(['/workspace/tool.wasm'], {
        cwd: '/workspace',
        env: {},
        fs: fileSystem,
        writer: { write: () => undefined },
        executionContext: {
          id: 21,
          openWorker: (createWorker) => createWorker()
        }
      })
    ).rejects.toBeInstanceOf(Error);
    expect(closeSynchronousMailbox).toHaveBeenCalledWith(
      'wasi-execution-context:21:process:0'
    );
  });
});

function runtimeProgramFileSystem(
  readFile: (path: string) => Promise<Uint8Array>,
  closeSynchronousMailbox: (contextId: string) => Promise<void> = async () =>
    undefined
) {
  const mailbox: SynchronousVirtualFileSystemMailboxDescriptor = {
    buffer: new SharedArrayBuffer(64),
    contextId: 'unit-wasi-mailbox',
    epoch: 1,
    payloadCapacity: 0,
    maxPayloadBytes: 0,
    watchdogMs: 1_000,
    workdir: '/workspace'
  };
  return {
    readFile,
    openSynchronousMailbox: async () => mailbox,
    closeSynchronousMailbox
  };
}

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    chunks.reduce((length, chunk) => length + chunk.byteLength, 0)
  );
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function writeText(memory: WebAssembly.Memory, pointer: number, value: string): void {
  new Uint8Array(memory.buffer, pointer, value.length).set(
    new TextEncoder().encode(value)
  );
}

function readText(memory: WebAssembly.Memory, pointer: number, length: number): string {
  return new TextDecoder().decode(
    new Uint8Array(memory.buffer, pointer, length)
  );
}

function readDirectoryEntries(
  memory: WebAssembly.Memory,
  pointer: number,
  length: number
): Array<{ readonly cookie: bigint; readonly inode: bigint; readonly name: string; readonly type: number }> {
  const entries = [];
  const view = new DataView(memory.buffer);
  const end = pointer + length;
  while (pointer + 24 <= end) {
    const nameLength = view.getUint32(pointer + 16, true);
    if (pointer + 24 + nameLength > end) break;
    entries.push({
      cookie: view.getBigUint64(pointer, true),
      inode: view.getBigUint64(pointer + 8, true),
      name: readText(memory, pointer + 24, nameLength),
      type: view.getUint8(pointer + 20)
    });
    pointer += 24 + nameLength;
  }
  return entries;
}

// The test worker's side of a MessageChannel serves the WASI worker interface.
class TestWasiRuntimeWorker extends EventTarget implements WasiRuntimeExecutionWorker {
  readonly #channel = new MessageChannel();
  readonly #connection: RpcConnection<WasiRuntimeHostApi>;
  #terminated = false;

  /** Runs the command as the WASI Execution worker would, or `run` in its place. */
  constructor(run?: (message: WasiRuntimeWorkerStart) => Promise<number>) {
    super();
    this.#connection = connectRpc<WasiRuntimeHostApi>(this.#channel.port2, {
      run: (message: WasiRuntimeWorkerStart) => (run ? run(message) : this.run(message))
    });
  }

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.#channel.port1.postMessage(message, transfer);
  }

  override addEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message' || type === 'messageerror') {
      this.#channel.port1.addEventListener(type, listener as EventListener);
      this.#channel.port1.start();
      return;
    }
    super.addEventListener(type, listener as EventListener);
  }

  override removeEventListener(type: string, listener: (event: never) => void): void {
    if (type === 'message' || type === 'messageerror') {
      this.#channel.port1.removeEventListener(type, listener as EventListener);
      return;
    }
    super.removeEventListener(type, listener as EventListener);
  }

  private async run(message: WasiRuntimeWorkerStart): Promise<number> {
    await Promise.resolve();
    if (this.#terminated) return new Promise<number>(() => undefined);
    const execution = createWasiNodeAdapterFactory({
      process: {
        argv: message.args,
        env: message.env,
        stdout: this.writer('stdout'),
        stderr: this.writer('stderr'),
        exit: () => undefined
      },
      vfs: {
        isDirectory: (path) => path === '/',
        isFile: () => false
      }
    })({
      version: 'preview1',
      args: message.args,
      env: message.env,
      preopens: { '/': '/' }
    });
    const instance = new WebAssembly.Instance(
      new WebAssembly.Module(message.bytes),
      execution.getImportObject()
    );
    const result = execution.start(instance);
    return typeof result === 'number' ? result : 0;
  }

  terminate(): void {
    this.#terminated = true;
    this.#connection.close();
  }

  private writer(stream: 'stdout' | 'stderr') {
    return {
      write: (chunk: Uint8Array) => {
        this.#connection.notify.output(stream, chunk.slice().buffer);
      }
    };
  }
}

function runtimeOptions(
  overrides: {
    readonly exit?: (code: number) => void;
    readonly monotonicNowNs?: () => bigint;
    readonly randomBytes?: ((size: number) => Uint8Array) | undefined;
    readonly realtimeNowNs?: () => bigint;
    readonly stderr?: unknown;
    readonly stdin?: {
      available?(): number;
      wait?(observed: number, timeoutMilliseconds?: number): void;
      read(maximumBytes: number): Uint8Array | undefined;
    };
    readonly stdout?: unknown;
    readonly vfs?: WasiSynchronousVfsPort;
  } = {}
) {
  return {
    process: {
      argv: ['node', 'fixture.wasm'],
      env: { LANG: 'C.UTF-8' },
      exit: overrides.exit ?? ((_code: number): never => {
        throw new Error('unexpected process exit');
      }),
      stderr: overrides.stderr ?? { write: (_chunk: Uint8Array) => undefined },
      stdout: overrides.stdout ?? { write: (_chunk: Uint8Array) => undefined }
    },
    stdin: overrides.stdin,
    randomBytes: Object.hasOwn(overrides, 'randomBytes')
      ? overrides.randomBytes
      : (size: number) => Uint8Array.from({ length: size }, (_value, index) => index + 1),
    monotonicNowNs: overrides.monotonicNowNs ?? (() => 456_000_000n),
    realtimeNowNs: overrides.realtimeNowNs ?? (() => 123_000_000n),
    vfs: overrides.vfs ?? {
      readFileSync: (_path: string) => new Uint8Array(),
      readFileSliceSync: (_path: string, _offset: number, _length: number) =>
        new Uint8Array(),
      isDirectory: (_path: string) => false,
      isFile: (_path: string) => false
    }
  };
}

function seekImportingInstance(host: { getImportObject(): WebAssembly.Imports }) {
  const bytes = Uint8Array.from(
    Buffer.from(
      'AGFzbQEAAAABEQNgBH9+f38Bf2AAAGABfwF/AiIBFndhc2lfc25hcHNob3RfcHJldmlldzEHZmRfc2VlawAAAwMCAQIFAwEAAQchAwZtZW1vcnkCAAZfc3RhcnQAAQtzZWVrVG9TdGFydAACChICAgALDQAgAEIAQQBBgAIQAAs=',
      'base64'
    )
  );
  return new WebAssembly.Instance(new WebAssembly.Module(bytes), {
    ...host.getImportObject()
  }) as unknown as {
    readonly exports: {
      readonly memory: WebAssembly.Memory;
      seekToStart(fd: number): number;
    };
  };
}

interface TestPreview1Imports {
  args_sizes_get(argc: number, argvBufferSize: number): number;
  args_get(argv: number, argvBuffer: number): number;
  environ_sizes_get(count: number, bufferSize: number): number;
  environ_get(environ: number, environBuffer: number): number;
  clock_time_get(clockId: number, precision: bigint, time: number): number;
  random_get(buffer: number, length: number): number;
  sched_yield(): number;
  fd_prestat_get(fd: number, result: number): number;
  fd_prestat_dir_name(fd: number, path: number, length: number): number;
  fd_fdstat_get(fd: number, result: number): number;
  fd_fdstat_set_flags(fd: number, flags: number): number;
  fd_filestat_get(fd: number, result: number): number;
  fd_read(fd: number, iovs: number, iovsLength: number, read: number): number;
  fd_pread(fd: number, iovs: number, iovsLength: number, offset: bigint, read: number): number;
  fd_readdir(fd: number, buffer: number, bufferLength: number, cookie: bigint, used: number): number;
  fd_write(fd: number, iovs: number, iovsLength: number, written: number): number;
  fd_seek(fd: number, offset: bigint, whence: number, newOffset: number): number;
  fd_tell(fd: number, offset: number): number;
  fd_close(fd: number): number;
  path_create_directory(fd: number, path: number, pathLength: number): number;
  path_open(
    fd: number,
    dirflags: number,
    path: number,
    pathLength: number,
    oflags: number,
    rightsBase: bigint,
    rightsInheriting: bigint,
    fdflags: number,
    openedFd: number
  ): number;
  path_filestat_get(fd: number, flags: number, path: number, pathLength: number, result: number): number;
  path_readlink(fd: number, path: number, pathLength: number, buffer: number, bufferLength: number, used: number): number;
  path_remove_directory(fd: number, path: number, pathLength: number): number;
  path_symlink(target: number, targetLength: number, fd: number, path: number, pathLength: number): number;
  path_unlink_file(fd: number, path: number, pathLength: number): number;
  clock_res_get(clockId: number, resolution: number): number;
  fd_renumber(from: number, to: number): number;
  fd_allocate(fd: number, offset: bigint, length: bigint): number;
  fd_filestat_set_size(fd: number, size: bigint): number;
  fd_filestat_set_times(fd: number, accessTime: bigint, modificationTime: bigint, flags: number): number;
  fd_pwrite(fd: number, iovs: number, iovsLength: number, offset: bigint, written: number): number;
  path_rename(
    fd: number,
    oldPath: number,
    oldPathLength: number,
    newFd: number,
    newPath: number,
    newPathLength: number
  ): number;
  path_link(
    oldFd: number,
    oldFlags: number,
    oldPath: number,
    oldPathLength: number,
    newFd: number,
    newPath: number,
    newPathLength: number
  ): number;
  path_filestat_set_times(
    fd: number,
    flags: number,
    path: number,
    pathLength: number,
    accessTime: bigint,
    modificationTime: bigint,
    fstFlags: number
  ): number;
  poll_oneoff(subscriptions: number, events: number, count: number, eventCount: number): number;
  sock_accept(fd: number, flags: number, acceptedFd: number): number;
  sock_shutdown(fd: number, how: number): number;
  proc_exit(code: number): number;
}

type WasiNamespaceGuestExports = TestPreview1Imports & {
  readonly memory: WebAssembly.Memory;
};

function wasiImports(host: { readonly wasiImport: WebAssembly.ModuleImports }): TestPreview1Imports {
  return host.wasiImport as unknown as TestPreview1Imports;
}

/** A host over `fileSystem`, initialized with a plain memory, and its imports to call directly. */
function preview1Host(fileSystem: WasiSynchronousVfsPort, preopens: Readonly<Record<string, string>>) {
  const host = createWasiNodeAdapterFactory(runtimeOptions({ vfs: fileSystem }))({
    version: 'preview1',
    preopens
  });
  const memory = new WebAssembly.Memory({ initial: 1 });
  host.initialize({ exports: { memory, _initialize: () => undefined } });
  return { wasi: wasiImports(host), memory, view: new DataView(memory.buffer) };
}

function wasiNamespaceImportingInstance(host: { getImportObject(): WebAssembly.Imports }) {
  const i32 = 0x7f;
  const i64 = 0x7e;
  const signatures = [
    ['fd_read', [i32, i32, i32, i32]],
    ['fd_pread', [i32, i32, i32, i64, i32]],
    ['fd_readdir', [i32, i32, i32, i64, i32]],
    ['fd_seek', [i32, i64, i32, i32]],
    ['fd_tell', [i32, i32]],
    ['fd_close', [i32]],
    ['fd_fdstat_get', [i32, i32]],
    ['fd_fdstat_set_flags', [i32, i32]],
    ['fd_filestat_get', [i32, i32]],
    ['fd_write', [i32, i32, i32, i32]],
    ['path_create_directory', [i32, i32, i32]],
    ['path_open', [i32, i32, i32, i32, i32, i64, i64, i32, i32]],
    ['path_filestat_get', [i32, i32, i32, i32, i32]],
    ['path_readlink', [i32, i32, i32, i32, i32, i32]],
    ['path_remove_directory', [i32, i32, i32]],
    ['path_symlink', [i32, i32, i32, i32, i32]],
    ['path_unlink_file', [i32, i32, i32]],
    ['poll_oneoff', [i32, i32, i32, i32]],
    ['sock_accept', [i32, i32, i32]],
    ['sock_shutdown', [i32, i32]]
  ] as const;
  const types = signatures.map(([, parameters]) => [
    0x60,
    ...wasmVector(parameters.map((parameter) => [parameter])),
    ...wasmVector([[i32]])
  ]);
  const imports = signatures.map(([name], index) => [
    ...wasmString('wasi_snapshot_preview1'),
    ...wasmString(name),
    0x00,
    ...wasmUnsigned(index)
  ]);
  const exports = [
    [...wasmString('memory'), 0x02, 0x00],
    ...signatures.map(([name], index) => [
      ...wasmString(name),
      0x00,
      ...wasmUnsigned(index)
    ])
  ];
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, wasmVector(types)),
    ...wasmSection(2, wasmVector(imports)),
    ...wasmSection(5, wasmVector([[0x00, 0x01]])),
    ...wasmSection(7, wasmVector(exports))
  ]);
  return new WebAssembly.Instance(
    new WebAssembly.Module(bytes),
    host.getImportObject()
  ) as unknown as { readonly exports: WasiNamespaceGuestExports };
}

function writeClockSubscription(
  view: DataView,
  pointer: number,
  userdata: bigint,
  timeout: bigint,
  flags = 0,
  clockId = 1
): void {
  new Uint8Array(view.buffer, pointer, 48).fill(0);
  view.setBigUint64(pointer, userdata, true);
  view.setUint8(pointer + 8, 0);
  view.setUint32(pointer + 16, clockId, true);
  view.setBigUint64(pointer + 24, timeout, true);
  view.setBigUint64(pointer + 32, 0n, true);
  view.setUint16(pointer + 40, flags, true);
}

function writeDescriptorSubscription(
  view: DataView,
  pointer: number,
  userdata: bigint,
  type: 1 | 2,
  fd: number
): void {
  new Uint8Array(view.buffer, pointer, 48).fill(0);
  view.setBigUint64(pointer, userdata, true);
  view.setUint8(pointer + 8, type);
  view.setUint32(pointer + 16, fd, true);
}

/** A guest importing the WASI namespace, initialised for polling through its memory. */
function pollingGuest(host: ReturnType<ReturnType<typeof createWasiNodeAdapterFactory>>) {
  const guest = wasiNamespaceImportingInstance(host);
  host.initialize({ exports: { ...guest.exports, _initialize: () => undefined } });
  return { view: new DataView(guest.exports.memory.buffer), wasi: guest.exports };
}

function readPollEvent(view: DataView, pointer: number) {
  return {
    userdata: view.getBigUint64(pointer, true),
    error: view.getUint16(pointer + 8, true),
    type: view.getUint8(pointer + 10),
    nbytes: view.getBigUint64(pointer + 16, true),
    flags: view.getUint16(pointer + 24, true)
  };
}

function wasiExecutableImporting(names: readonly string[]): Uint8Array {
  const i32 = 0x7f;
  const types = [
    [0x60, ...wasmVector([]), ...wasmVector([[i32]])],
    [0x60, ...wasmVector([]), ...wasmVector([])]
  ];
  const imports = names.map((name) => [
    ...wasmString('wasi_snapshot_preview1'),
    ...wasmString(name),
    0x00,
    0x00
  ]);
  const exports = [
    [...wasmString('memory'), 0x02, 0x00],
    [...wasmString('_start'), 0x00, ...wasmUnsigned(names.length)]
  ];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, wasmVector(types)),
    ...wasmSection(2, wasmVector(imports)),
    ...wasmSection(3, wasmVector([[0x01]])),
    ...wasmSection(5, wasmVector([[0x00, 0x01]])),
    ...wasmSection(7, wasmVector(exports)),
    ...wasmSection(10, wasmVector([[0x02, 0x00, 0x0b]]))
  ]);
}

function wasmSection(id: number, body: readonly number[]): number[] {
  return [id, ...wasmUnsigned(body.length), ...body];
}

function wasmVector(items: ReadonlyArray<readonly number[]>): number[] {
  return [...wasmUnsigned(items.length), ...items.flat()];
}

function wasmString(value: string): number[] {
  const bytes = [...new TextEncoder().encode(value)];
  return [...wasmUnsigned(bytes.length), ...bytes];
}

function wasmUnsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    const byte = value & 0x7f;
    value >>>= 7;
    bytes.push(value === 0 ? byte : byte | 0x80);
  } while (value !== 0);
  return bytes;
}

function memoryExportingInstance() {
  const bytes = Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    0x01, 0x04, 0x01, 0x60, 0x00, 0x00,
    0x03, 0x02, 0x01, 0x00,
    0x05, 0x03, 0x01, 0x00, 0x01,
    0x07, 0x13, 0x02, 0x06, 0x6d, 0x65, 0x6d, 0x6f, 0x72, 0x79, 0x02, 0x00, 0x06, 0x5f, 0x73, 0x74, 0x61, 0x72, 0x74, 0x00, 0x00,
    0x0a, 0x04, 0x01, 0x02, 0x00, 0x0b
  ]);
  return new WebAssembly.Instance(new WebAssembly.Module(bytes)) as unknown as {
    readonly exports: Record<string, unknown>;
  };
}

function exitInstance(
  host: { readonly wasiImport: WebAssembly.ModuleImports },
  code: number
) {
  const memory = memoryExportingInstance().exports.memory as WebAssembly.Memory;
  return { exports: { memory, _start: () => wasiImports(host).proc_exit(code) } };
}

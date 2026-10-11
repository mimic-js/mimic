import { describe, expect, test, vi } from 'vitest';

import { createWasiBuiltin, wasiVfsPort } from '../wasi';
import { VirtualFileSystem } from '../../../../../tests/support/module-internals';

describe('Node Compatibility node:wasi adapter', () => {
  test('exposes one Node-like WASI constructor identity and requires Preview1', () => {
    const wasiModule = createWasiBuiltin(runtimeOptions());

    expect(wasiModule.default).toBe(wasiModule);
    expect(wasiModule.default.WASI).toBe(wasiModule.WASI);
    expect(() => new wasiModule.WASI({})).toThrow('version');
    expect(() => new wasiModule.WASI({ version: 'preview2' as never })).toThrow('preview1');
    expect(() => new wasiModule.WASI({ version: 'preview1', stdout: 9 })).toThrow('descriptor 1');
    expect(new wasiModule.WASI({ version: 'preview1' })).toBeInstanceOf(wasiModule.WASI);
  });

  test('projects the shared host as the Node-shaped import and lifecycle API', () => {
    const wasi = new (createWasiBuiltin(runtimeOptions()).WASI)({ version: 'preview1' });
    const initialize = vi.fn();
    const instance = {
      exports: {
        memory: new WebAssembly.Memory({ initial: 1 }),
        _initialize: initialize
      }
    };

    expect(wasi.getImportObject()).toEqual({ wasi_snapshot_preview1: wasi.wasiImport });
    wasi.initialize(instance);
    expect(initialize).toHaveBeenCalledOnce();
    expect(() => wasi.initialize(instance)).toThrow('exactly once');
  });
});

describe('WASI Preview1 imports a NAPI-RS binding links', () => {
  test('every Preview1 function is importable, and rename, link, size, positioned writes and times act on the file system', () => {
    const vfs = new VirtualFileSystem('/project');
    vfs.mkdirSync('/project/dir', { recursive: true });
    vfs.writeFileSync('/project/dir/a.txt', 'hello');
    const wasi = new (createWasiBuiltin({ ...runtimeOptions(), vfs: wasiVfsPort(vfs) }).WASI)({
      version: 'preview1',
      preopens: { '/project': '/project' }
    });
    const memory = new WebAssembly.Memory({ initial: 1 });
    wasi.initialize({ exports: { memory, _initialize: () => undefined } });
    const imports = wasi.wasiImport as Record<string, (...args: unknown[]) => number>;
    const bytes = new Uint8Array(memory.buffer);
    const view = new DataView(memory.buffer);
    let next = 1024;
    const string = (text: string): [number, number] => {
      const encoded = new TextEncoder().encode(text);
      bytes.set(encoded, next);
      const pointer = next;
      next += encoded.byteLength + 8;
      return [pointer, encoded.byteLength];
    };
    const preopen = 3;

    // A binding fails to instantiate when any import it names is missing.
    for (const name of [
      'clock_res_get', 'fd_advise', 'fd_allocate', 'fd_datasync', 'fd_sync', 'fd_filestat_set_size',
      'fd_filestat_set_times', 'fd_pwrite', 'fd_renumber', 'path_filestat_set_times', 'path_link',
      'path_rename', 'proc_raise', 'sock_recv', 'sock_send'
    ]) {
      expect(typeof imports[name], name).toBe('function');
    }

    expect(imports.path_rename!(preopen, ...string('dir/a.txt'), preopen, ...string('dir/b.txt'))).toBe(0);
    expect(vfs.existsSync('/project/dir/a.txt')).toBe(false);
    expect(new TextDecoder().decode(vfs.readFileSync('/project/dir/b.txt'))).toBe('hello');
    expect(imports.path_link!(preopen, 0, ...string('dir/b.txt'), preopen, ...string('dir/c.txt'))).toBe(0);
    expect(new TextDecoder().decode(vfs.readFileSync('/project/dir/c.txt'))).toBe('hello');
    expect(imports.path_rename!(preopen, ...string('../outside'), preopen, ...string('dir/d.txt'))).toBe(76);

    const opened = 512;
    const [path, pathLength] = string('dir/b.txt');
    // Read, seek, write, allocate, set-size and set-times rights.
    const rights = (1n << 1n) | (1n << 2n) | (1n << 6n) | (1n << 8n) | (1n << 22n) | (1n << 23n);
    expect(imports.path_open!(preopen, 0, path, pathLength, 0, rights, 0n, 0, opened)).toBe(0);
    const fd = view.getUint32(opened, true);
    expect(imports.fd_filestat_set_size!(fd, 8n)).toBe(0);
    expect(Array.from(vfs.readFileSync('/project/dir/b.txt'))).toEqual([104, 101, 108, 108, 111, 0, 0, 0]);
    expect(imports.fd_allocate!(fd, 0n, 4n)).toBe(0);
    expect(vfs.readFileSync('/project/dir/b.txt').byteLength).toBe(8);
    const [data, dataLength] = string('XY');
    view.setUint32(768, data, true);
    view.setUint32(772, dataLength, true);
    expect(imports.fd_pwrite!(fd, 768, 1, 1n, 776)).toBe(0);
    expect(view.getUint32(776, true)).toBe(2);
    expect(new TextDecoder().decode(vfs.readFileSync('/project/dir/b.txt').subarray(0, 5))).toBe('hXYlo');
    expect(imports.fd_filestat_set_times!(fd, 0n, 1_700_000_000_000_000_000n, 4)).toBe(0);
    expect(vfs.statSync('/project/dir/b.txt').mtime.getTime()).toBe(1_700_000_000_000);
    expect(imports.fd_datasync!(fd)).toBe(0);
    expect(imports.fd_sync!(99)).toBe(8);
    expect(imports.clock_res_get!(1, 800)).toBe(0);
    expect(view.getBigUint64(800, true)).toBe(1_000_000n);
  });
});

function runtimeOptions() {
  return {
    process: {
      argv: ['node', 'fixture.wasm'],
      env: { LANG: 'C.UTF-8' },
      exit: (_code: number): never => {
        throw new Error('unexpected process exit');
      },
      stderr: { write: (_chunk: Uint8Array) => undefined },
      stdout: { write: (_chunk: Uint8Array) => undefined }
    },
    randomBytes: (size: number) => Uint8Array.from({ length: size }, (_value, index) => index + 1),
    monotonicNowNs: () => 456_000_000n,
    realtimeNowNs: () => 123_000_000n,
    vfs: {
      readFileSync: (_path: string) => new Uint8Array(),
      isDirectory: (_path: string) => false,
      isFile: (_path: string) => false
    }
  };
}

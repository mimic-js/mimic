const WASM_MAGIC = Uint8Array.of(0x00, 0x61, 0x73, 0x6d);
const WASI_PREVIEW1_MODULE = 'wasi_snapshot_preview1';
const WASI_PREVIEW1_IMPORTS = new Set([
  'args_sizes_get',
  'args_get',
  'environ_sizes_get',
  'environ_get',
  'clock_time_get',
  'random_get',
  'sched_yield',
  'fd_prestat_get',
  'fd_prestat_dir_name',
  'fd_fdstat_get',
  'fd_fdstat_set_flags',
  'fd_filestat_get',
  'fd_read',
  'fd_pread',
  'fd_readdir',
  'fd_write',
  'fd_seek',
  'fd_tell',
  'fd_close',
  'path_create_directory',
  'path_open',
  'path_filestat_get',
  'path_readlink',
  'path_remove_directory',
  'path_symlink',
  'path_unlink_file',
  'poll_oneoff',
  'sock_accept',
  'sock_shutdown',
  'proc_exit'
]);

export type WasiExecutableInspection =
  | { readonly kind: 'unrecognized' }
  | { readonly kind: 'supported' }
  | {
      readonly kind: 'unsupported';
      readonly code:
        | 'INVALID_WASM_EXECUTABLE'
        | 'WASI_EXECUTABLE_LIBRARY'
        | 'UNSUPPORTED_WASI_ABI'
        | 'UNKNOWN_WASI_IMPORT';
      readonly message: string;
    };

export function inspectWasiPreview1Executable(
  bytes: Uint8Array
): Promise<WasiExecutableInspection> {
  if (
    bytes.byteLength < WASM_MAGIC.byteLength ||
    !WASM_MAGIC.every((value, index) => bytes[index] === value)
  ) {
    return Promise.resolve({ kind: 'unrecognized' });
  }

  return WebAssembly.compile(bytes.slice().buffer).then(
    inspectCompiledWasiPreview1Executable,
    (error: unknown) => ({
      kind: 'unsupported',
      code: 'INVALID_WASM_EXECUTABLE',
      message: `WebAssembly executable is invalid: ${errorMessage(error)}`
    })
  );
}

export function inspectCompiledWasiPreview1Executable(
  module: WebAssembly.Module
): WasiExecutableInspection {
  const exports = WebAssembly.Module.exports(module);
  if (!exports.some((entry) => entry.name === '_start' && entry.kind === 'function')) {
    return {
      kind: 'unsupported',
      code: 'WASI_EXECUTABLE_LIBRARY',
      message: 'WebAssembly executable is a library because it does not export _start.'
    };
  }
  if (!exports.some((entry) => entry.name === 'memory' && entry.kind === 'memory')) {
    return {
      kind: 'unsupported',
      code: 'WASI_EXECUTABLE_LIBRARY',
      message: 'WebAssembly executable does not export the memory required by WASI Preview1.'
    };
  }

  const imports = WebAssembly.Module.imports(module);
  const unsupportedAbi = imports.find(
    (entry) => entry.module !== WASI_PREVIEW1_MODULE
  );
  if (imports.length === 0 || unsupportedAbi) {
    return {
      kind: 'unsupported',
      code: 'UNSUPPORTED_WASI_ABI',
      message: unsupportedAbi
        ? `WebAssembly executable imports unsupported ABI ${unsupportedAbi.module}.`
        : 'WebAssembly executable does not import the WASI Preview1 ABI.'
    };
  }
  const unknownImport = imports.find(
    (entry) =>
      entry.kind !== 'function' || !WASI_PREVIEW1_IMPORTS.has(entry.name)
  );
  if (unknownImport) {
    return {
      kind: 'unsupported',
      code: 'UNKNOWN_WASI_IMPORT',
      message: `WebAssembly executable imports unsupported WASI Preview1 capability ${unknownImport.module}.${unknownImport.name}.`
    };
  }
  return { kind: 'supported' };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import { gzipSync } from 'node:zlib';

export function makePackageTgz(files: Record<string, string>): Uint8Array {
  return makeNpmTgz(Object.fromEntries(Object.entries(files).map(([path, contents]) => [`package/${path}`, contents])));
}

export function makeNpmTgz(files: Record<string, string>): Uint8Array {
  const chunks: Uint8Array[] = [];
  for (const [path, contents] of Object.entries(files)) {
    const data = new TextEncoder().encode(contents);
    chunks.push(tarHeader(path, data.byteLength), padToBlock(data));
  }
  chunks.push(new Uint8Array(512), new Uint8Array(512));
  return gzipSync(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))));
}

function tarHeader(path: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  writeString(header, 0, 100, path);
  writeString(header, 100, 8, '0000644');
  writeString(header, 108, 8, '0000000');
  writeString(header, 116, 8, '0000000');
  writeString(header, 124, 12, size.toString(8).padStart(11, '0'));
  writeString(header, 136, 12, '00000000000');
  for (let index = 148; index < 156; index += 1) header[index] = 0x20;
  writeString(header, 156, 1, '0');
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(header, 148, 8, checksum.toString(8).padStart(6, '0') + '\0 ');
  return header;
}

function writeString(header: Uint8Array, offset: number, length: number, value: string): void {
  header.set(new TextEncoder().encode(value).slice(0, length), offset);
}

function padToBlock(data: Uint8Array): Uint8Array {
  const padded = new Uint8Array(Math.ceil(data.byteLength / 512) * 512);
  padded.set(data);
  return padded;
}

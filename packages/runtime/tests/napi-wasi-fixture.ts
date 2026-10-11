/** Fixtures of the files a NAPI-RS package ships for its WASI build. */

/** A module exporting a memory and one empty function under each name. */
export function moduleExporting(names: readonly string[]): Uint8Array {
  const encoder = new TextEncoder();
  const vector = (items: readonly number[][]): number[] => [items.length, ...items.flat()];
  const name = (text: string): number[] => {
    const bytes = [...encoder.encode(text)];
    return [bytes.length, ...bytes];
  };
  const section = (id: number, body: readonly number[]): number[] => [id, ...unsigned(body.length), ...body];
  return Uint8Array.from([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...section(1, vector([[0x60, 0, 0]])),
    ...section(3, vector(names.map(() => [0]))),
    ...section(5, vector([[0, 1]])),
    ...section(7, vector([[...name('memory'), 2, 0], ...names.map((entry, index) => [...name(entry), 0, index])])),
    ...section(10, vector(names.map(() => [2, 0, 0x0b])))
  ]);
}

function unsigned(value: number): number[] {
  const bytes: number[] = [];
  do {
    let byte = value & 0x7f;
    value >>>= 7;
    if (value !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (value !== 0);
  return bytes;
}

/** The shape of the loader NAPI-RS generates, as nx 23 publishes it. */
export function generatedLoader(registers: readonly string[], exports: readonly string[]): string {
  return [
    "const __napiModule = { exports: {} }",
    'function __napi_rs_initialize_modules(__napiInstance) {',
    ...registers.map((entry) => `  __napiInstance.exports['${entry}']?.()`),
    '}',
    ...exports.map((entry) => `module.exports.${entry} = __napiModule.exports.${entry}`),
    ''
  ].join('\n');
}

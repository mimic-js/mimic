const NODE_TEXT_DECODER = Symbol('node-text-decoder');
const nodeTextDecoders = new WeakMap<typeof TextDecoder, typeof TextDecoder>();

/**
 * Node's `TextDecoder` over the platform's: a fatal decode of invalid input
 * throws a TypeError with code ERR_ENCODING_INVALID_ENCODED_DATA, which
 * programs test for (the Angular devkit leaves a binary template file as it is
 * on that code), and a view of a SharedArrayBuffer decodes as Node decodes it,
 * where the platform refuses it. One class per platform class, so `util` and
 * the global name the same one, as in Node.
 */
export function nodeTextDecoder(base: typeof TextDecoder): typeof TextDecoder {
  if ((base as unknown as Record<symbol, unknown>)[NODE_TEXT_DECODER]) return base;
  let decoder = nodeTextDecoders.get(base);
  if (!decoder) {
    decoder = class TextDecoder extends base {
      static readonly [NODE_TEXT_DECODER] = true;

      override decode(input?: AllowSharedBufferSource, options?: TextDecodeOptions): string {
        try {
          return super.decode(unshared(input), options);
        } catch (error) {
          if (!this.fatal || !(error instanceof TypeError)) throw error;
          throw Object.assign(new TypeError(`The encoded data was not valid for encoding ${this.encoding}`), {
            code: 'ERR_ENCODING_INVALID_ENCODED_DATA'
          });
        }
      }
    };
    nodeTextDecoders.set(base, decoder);
  }
  return decoder;
}

function unshared(input: AllowSharedBufferSource | undefined): AllowSharedBufferSource | undefined {
  if (typeof SharedArrayBuffer === 'undefined' || input === undefined) return input;
  if (input instanceof SharedArrayBuffer) return new Uint8Array(input).slice();
  if (ArrayBuffer.isView(input) && input.buffer instanceof SharedArrayBuffer) {
    return new Uint8Array(input.buffer, input.byteOffset, input.byteLength).slice();
  }
  return input;
}

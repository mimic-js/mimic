import './port-dependencies/provide';
import { StringDecoder as StringDecoderPort } from 'string_decoder/lib/string_decoder.js';
import { BrowserBuffer } from './buffer';

/**
 * `node:string_decoder` is the `string_decoder` port, Node's
 * `lib/string_decoder.js` (ADR-0026). The port reads its input through Buffer
 * methods; Node 22 also decodes any TypedArray or DataView, so this decoder
 * views one as a Buffer first.
 *
 * It stays a function constructor like the port: packages inherit from it the
 * ES5 way, `StringDecoder.call(this, encoding)`, which a class rejects.
 */
type Decoder = InstanceType<typeof StringDecoderPort>;

function StringDecoder(this: Decoder, encoding?: string): void {
  StringDecoderPort.call(this, encoding);
}

StringDecoder.prototype = Object.create(StringDecoderPort.prototype, {
  constructor: { value: StringDecoder, writable: true, configurable: true },
  write: {
    value(this: Decoder, input: Uint8Array | string): string {
      return StringDecoderPort.prototype.write.call(this, bufferView(input));
    },
    writable: true,
    configurable: true
  },
  end: {
    value(this: Decoder, input?: Uint8Array | string): string {
      return StringDecoderPort.prototype.end.call(this, input === undefined ? undefined : bufferView(input));
    },
    writable: true,
    configurable: true
  }
});

function bufferView(input: unknown): BrowserBuffer | string {
  if (typeof input === 'string' || BrowserBuffer.isBuffer(input)) return input;
  if (ArrayBuffer.isView(input)) return BrowserBuffer.from(input.buffer, input.byteOffset, input.byteLength);
  throw Object.assign(
    new TypeError('The "buf" argument must be an instance of Buffer, TypedArray, or DataView.'),
    { code: 'ERR_INVALID_ARG_TYPE' }
  );
}

export const nodeStringDecoder = { StringDecoder, default: { StringDecoder } };

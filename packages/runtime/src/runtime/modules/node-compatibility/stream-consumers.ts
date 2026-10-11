import { BrowserBuffer } from './buffer';

type Consumable = AsyncIterable<unknown> | Iterable<unknown>;

/** `node:stream/consumers`: reads a whole Node or web stream into one value. */
export function createStreamConsumersBuiltin(): unknown {
  const bytes = async (stream: Consumable): Promise<BrowserBuffer> => {
    const chunks: Uint8Array[] = [];
    for await (const chunk of stream) {
      if (typeof chunk === 'string') chunks.push(BrowserBuffer.from(chunk));
      else if (ArrayBuffer.isView(chunk)) {
        chunks.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
      } else if (chunk instanceof ArrayBuffer) chunks.push(new Uint8Array(chunk));
      else {
        throw Object.assign(
          new TypeError('The stream chunk must be a string, an ArrayBuffer, or an ArrayBufferView.'),
          { code: 'ERR_INVALID_ARG_TYPE' }
        );
      }
    }
    return BrowserBuffer.concat(chunks);
  };
  const text = async (stream: Consumable): Promise<string> => new TextDecoder().decode(await bytes(stream));
  const consumers = {
    arrayBuffer: async (stream: Consumable): Promise<ArrayBuffer> => {
      const buffer = await bytes(stream);
      return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer;
    },
    blob: async (stream: Consumable): Promise<Blob> => new Blob([await bytes(stream)]),
    buffer: bytes,
    json: async (stream: Consumable): Promise<unknown> => JSON.parse(await text(stream)),
    text
  };
  return { ...consumers, default: consumers };
}

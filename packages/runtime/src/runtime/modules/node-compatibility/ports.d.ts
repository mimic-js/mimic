/**
 * Types for the adopted CommonJS ports of Node builtins (ADR-0026), declared
 * for the members the runtime uses. The ports ship no types of their own.
 */

declare module 'events/events.js' {
  type Listener = (this: unknown, ...args: any[]) => void;

  /** `events@3`, Node's `EventEmitter` for every engine. */
  class EventEmitter {
    constructor();
    static readonly EventEmitter: typeof EventEmitter;
    static defaultMaxListeners: number;
    static listenerCount(emitter: EventEmitter, event: string | symbol): number;
    static once(emitter: EventEmitter | EventTarget, event: string | symbol): Promise<unknown[]>;
    setMaxListeners(count: number): this;
    getMaxListeners(): number;
    emit(event: string | symbol, ...args: any[]): boolean;
    on(event: string | symbol, listener: Listener): this;
    addListener(event: string | symbol, listener: Listener): this;
    prependListener(event: string | symbol, listener: Listener): this;
    once(event: string | symbol, listener: Listener): this;
    prependOnceListener(event: string | symbol, listener: Listener): this;
    off(event: string | symbol, listener: Listener): this;
    removeListener(event: string | symbol, listener: Listener): this;
    removeAllListeners(event?: string | symbol): this;
    listeners(event: string | symbol): Function[];
    rawListeners(event: string | symbol): Function[];
    listenerCount(event: string | symbol): number;
    eventNames(): Array<string | symbol>;
  }

  export = EventEmitter;
}

declare module 'path-browserify' {
  type ParsedPath = { root: string; dir: string; base: string; ext: string; name: string };

  /** `path-browserify`, the POSIX half of Node's `lib/path.js`. */
  const posix: {
    resolve(...paths: string[]): string;
    normalize(path: string): string;
    isAbsolute(path: string): boolean;
    join(...paths: string[]): string;
    relative(from: string, to: string): string;
    dirname(path: string): string;
    basename(path: string, suffix?: string): string;
    extname(path: string): string;
    format(pathObject: Partial<ParsedPath>): string;
    parse(path: string): ParsedPath;
    readonly sep: '/';
    readonly delimiter: ':';
  };

  export = posix;
}

declare module 'url/url.js' {
  /** `url@0.11`, Node's legacy URL API (`url.parse`, `url.format`, `url.resolve`). */
  export class Url {
    format(): string;
  }
  export function parse(url: string, parseQueryString?: boolean, slashesDenoteHost?: boolean): Url;
  export function format(url: string | object): string;
  export function resolve(from: string, to: string): string;
  export function resolveObject(from: string | object, to: string): Url;
}

declare module 'string_decoder/lib/string_decoder.js' {
  /** `string_decoder@1`, Node's `lib/string_decoder.js`. */
  export class StringDecoder {
    constructor(encoding?: string);
    readonly encoding: string;
    write(buffer: Uint8Array | string): string;
    end(buffer?: Uint8Array | string): string;
  }
}

declare module 'readable-stream/lib/stream.js' {
  /** `readable-stream@4`, the userland copy of Node's `lib/stream.js`. */
  const stream: unknown;
  export = stream;
}

declare module 'punycode/punycode.es6.js' {
  /** `punycode@2`, Node's `lib/punycode.js`. */
  const punycode: {
    readonly version: string;
    readonly ucs2: { decode(value: string): number[]; encode(codePoints: readonly number[]): string };
    decode(input: string): string;
    encode(input: string): string;
    toASCII(input: string): string;
    toUnicode(input: string): string;
  };
  export default punycode;
}

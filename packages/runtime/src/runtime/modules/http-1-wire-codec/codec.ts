// The package's one HTTP/1 framer (ADR-0024). Node Compatibility uses it where
// HTTP travels as bytes: connections over `node:net` and the head a program
// writes on a socket handed over after `upgrade`. Published requests reach
// `http.Server` structured and never pass through it.
export type Http1Header = readonly [name: string, value: string];

export type Http1RequestHead = {
  readonly method: string;
  readonly path: string;
  readonly version: string;
  readonly headers: readonly Http1Header[];
  readonly contentLength: number;
  readonly bodyStart: number;
  readonly chunked: boolean;
  readonly upgrade: boolean;
};

export type Http1ResponseHead = {
  readonly status: number;
  readonly statusText: string;
  readonly version: string;
  readonly headers: readonly Http1Header[];
  readonly bodyStart: number;
  readonly chunked: boolean;
  readonly contentLength?: number;
};

export type Http1RequestHeadToSerialize = {
  readonly method: string;
  readonly path: string;
  readonly version?: string;
  readonly headers: readonly Http1Header[];
};

export type Http1ResponseHeadToSerialize = {
  readonly status: number;
  readonly statusText: string;
  readonly version?: string;
  readonly headers: readonly Http1Header[];
};

export function concatHttp1Bytes(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export function serializeHttp1RequestHead(input: Http1RequestHeadToSerialize): Uint8Array {
  return encodeHead(`${input.method} ${input.path} ${input.version ?? 'HTTP/1.1'}`, input.headers);
}

export function serializeHttp1ResponseHead(input: Http1ResponseHeadToSerialize): Uint8Array {
  return encodeHead(`${input.version ?? 'HTTP/1.1'} ${input.status} ${input.statusText}`, input.headers);
}

export function parseHttp1RequestHead(bytes: Uint8Array): Http1RequestHead | undefined {
  const headerEnd = findHttp1HeaderEnd(bytes);
  if (headerEnd === -1) return undefined;
  const [requestLine = '', ...headerLines] = decodeHeaderLines(bytes, headerEnd);
  if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+ \S+ HTTP\/1\.[01]$/u.test(requestLine)) {
    throw http1Error('HPE_INVALID_METHOD', 'Parse Error: Invalid HTTP request line');
  }
  const [method, path, version] = requestLine.split(' ') as [string, string, string];
  const headers = parseHttp1HeaderLines(headerLines);
  const transferEncodings = headers
    .filter(([name]) => name === 'transfer-encoding')
    .flatMap(([, value]) => value.toLowerCase().split(',').map((token) => token.trim()));
  const chunked = transferEncodings.includes('chunked');
  return {
    method,
    path,
    version,
    headers,
    contentLength: chunked ? 0 : parseHttp1ContentLength(headers),
    bodyStart: headerEnd + 4,
    chunked,
    upgrade: isHttp1UpgradeRequest(headers)
  };
}

export function parseHttp1ResponseHead(bytes: Uint8Array): Http1ResponseHead | undefined {
  const headerEnd = findHttp1HeaderEnd(bytes);
  if (headerEnd === -1) return undefined;
  const [statusLine = '', ...headerLines] = decodeHeaderLines(bytes, headerEnd);
  const statusMatch = /^(HTTP\/\d(?:\.\d)?)\s+(\d{3})(?:\s+(.*))?$/u.exec(statusLine);
  if (!statusMatch) throw http1Error('HPE_INVALID_STATUS', `Invalid HTTP response status line: ${statusLine}`);
  const headers = parseHttp1HeaderLines(headerLines);
  const transferEncodings = headers
    .filter(([name]) => name === 'transfer-encoding')
    .flatMap(([, value]) => value.toLowerCase().split(',').map((token) => token.trim()));
  const hasContentLength = headers.some(([name]) => name === 'content-length');
  return {
    version: statusMatch[1],
    status: Number(statusMatch[2]),
    statusText: statusMatch[3] ?? '',
    headers,
    bodyStart: headerEnd + 4,
    chunked: transferEncodings.includes('chunked'),
    contentLength: hasContentLength ? parseHttp1ContentLength(headers) : undefined
  };
}

function parseHttp1ContentLength(headers: readonly Http1Header[]): number {
  const values = headers.filter(([name]) => name === 'content-length').map(([, value]) => value);
  if (values.length === 0) return 0;
  const contentLength = parseHttp1ContentLengthValue(values[0]);
  if (values.some((value) => parseHttp1ContentLengthValue(value) !== contentLength)) {
    throw http1Error('HPE_UNEXPECTED_CONTENT_LENGTH', 'Conflicting Content-Length headers');
  }
  return contentLength;
}

function parseHttp1ContentLengthValue(value: string): number {
  const contentLength = Number(value);
  if (!/^\d+$/u.test(value.trim()) || !Number.isSafeInteger(contentLength) || contentLength < 0) {
    throw http1Error('HPE_INVALID_CONTENT_LENGTH', `Invalid Content-Length: ${value}`);
  }
  return contentLength;
}

export function serializeHttp1Chunk(body: Uint8Array): Uint8Array {
  return concatHttp1Bytes([new TextEncoder().encode(`${body.byteLength.toString(16)}\r\n`), body, new TextEncoder().encode('\r\n')]);
}

export function serializeHttp1ChunkTerminator(trailers: readonly Http1Header[]): Uint8Array {
  return new TextEncoder().encode(['0', ...trailers.map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n'));
}

export class Http1ChunkBodyDecoder {
  private buffer = new Uint8Array();
  private expectedSize: number | undefined;
  private finished = false;

  constructor(
    private readonly onChunk: (chunk: Uint8Array) => void,
    private readonly onTrailers: (trailers: readonly Http1Header[]) => void,
    private readonly onEnd: () => void
  ) {}

  get complete(): boolean {
    return this.finished;
  }

  /** The bytes that followed the body on the same connection, once it is complete. */
  get remainder(): Uint8Array {
    return this.finished ? this.buffer : new Uint8Array();
  }

  push(bytes: Uint8Array): void {
    if (this.finished || bytes.byteLength === 0) return;
    this.buffer = new Uint8Array(concatHttp1Bytes([this.buffer, bytes]));
    while (!this.finished) {
      if (this.expectedSize === undefined) {
        const lineEnd = findCrlf(this.buffer, 0);
        if (lineEnd === -1) return;
        const sizeText = new TextDecoder().decode(this.buffer.slice(0, lineEnd)).split(';', 1)[0]?.trim() ?? '';
        if (!/^[0-9a-f]+$/iu.test(sizeText)) {
          throw http1Error('HPE_INVALID_CHUNK_SIZE', `Invalid HTTP chunk size: ${sizeText}`);
        }
        const size = Number.parseInt(sizeText, 16);
        if (!Number.isFinite(size) || size < 0) throw http1Error('HPE_INVALID_CHUNK_SIZE', `Invalid HTTP chunk size: ${sizeText}`);
        this.expectedSize = size;
        this.buffer = this.buffer.slice(lineEnd + 2);
      }
      if (this.expectedSize === 0) {
        if (this.buffer.byteLength >= 2 && this.buffer[0] === 13 && this.buffer[1] === 10) {
          this.buffer = this.buffer.slice(2);
          this.finish([]);
          return;
        }
        const trailerEnd = findHttp1HeaderEnd(this.buffer);
        if (trailerEnd === -1) return;
        const trailerText = new TextDecoder().decode(this.buffer.slice(0, trailerEnd));
        this.buffer = this.buffer.slice(trailerEnd + 4);
        this.finish(trailerText ? parseHttp1HeaderLines(trailerText.split('\r\n')) : []);
        return;
      }
      if (this.buffer.byteLength < this.expectedSize + 2) return;
      const chunk = this.buffer.slice(0, this.expectedSize);
      if (this.buffer[this.expectedSize] !== 13 || this.buffer[this.expectedSize + 1] !== 10) {
        throw http1Error('HPE_INVALID_CHUNK_SIZE', 'Invalid HTTP chunk terminator');
      }
      this.buffer = this.buffer.slice(this.expectedSize + 2);
      this.expectedSize = undefined;
      this.onChunk(chunk);
    }
  }

  private finish(trailers: readonly Http1Header[]): void {
    this.finished = true;
    this.onTrailers(trailers);
    this.onEnd();
  }
}

function parseHttp1HeaderLines(lines: readonly string[]): Http1Header[] {
  return lines.flatMap((line): Http1Header[] => {
    const separator = line.indexOf(':');
    if (separator === -1) return [];
    return [[line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim()]];
  });
}

function isHttp1UpgradeRequest(headers: readonly Http1Header[]): boolean {
  const connectionTokens = headers
    .filter(([name]) => name === 'connection')
    .flatMap(([, value]) => value.toLowerCase().split(',').map((part) => part.trim()));
  const upgrade = headers.find(([name]) => name === 'upgrade')?.[1]?.trim();
  return connectionTokens.includes('upgrade') && Boolean(upgrade);
}

function encodeHead(startLine: string, headers: readonly Http1Header[]): Uint8Array {
  return new TextEncoder().encode([startLine, ...headers.map(([name, value]) => `${name}: ${value}`), '', ''].join('\r\n'));
}

function decodeHeaderLines(bytes: Uint8Array, headerEnd: number): string[] {
  return new TextDecoder().decode(bytes.slice(0, headerEnd)).split('\r\n');
}

function findHttp1HeaderEnd(bytes: Uint8Array): number {
  for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10 && bytes[index + 2] === 13 && bytes[index + 3] === 10) return index;
  }
  return -1;
}

function findCrlf(bytes: Uint8Array, start: number): number {
  for (let index = start; index <= bytes.byteLength - 2; index += 1) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) return index;
  }
  return -1;
}

function http1Error(code: string, message: string): Error & { readonly code: string } {
  return Object.assign(new Error(message), { code });
}

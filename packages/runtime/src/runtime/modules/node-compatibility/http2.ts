export type Http2CapabilityError = Error & {
  readonly code: 'ENOTSUP';
  readonly syscall: string;
};

export type Http2Builtin = {
  readonly constants: Readonly<Record<string, string | number>>;
  readonly connect: (...args: readonly unknown[]) => never;
  readonly createServer: (...args: readonly unknown[]) => never;
  readonly createSecureServer: (...args: readonly unknown[]) => never;
  readonly performServerHandshake: (...args: readonly unknown[]) => never;
  readonly getDefaultSettings: (...args: readonly unknown[]) => never;
  readonly getPackedSettings: (...args: readonly unknown[]) => never;
  readonly getUnpackedSettings: (...args: readonly unknown[]) => never;
  readonly Http2Server: new (...args: readonly unknown[]) => object;
  readonly Http2SecureServer: new (...args: readonly unknown[]) => object;
  readonly Http2ServerRequest: new (...args: readonly unknown[]) => object;
  readonly Http2ServerResponse: new (...args: readonly unknown[]) => object;
  readonly default: Omit<Http2Builtin, 'default'>;
};

/** Creates the node:http2 capability boundary without fabricating HTTP/2 sessions or servers. */
export function createHttp2Builtin(): Http2Builtin {
  const constants = Object.freeze({
    HTTP2_HEADER_LOCATION: 'location',
    HTTP2_HEADER_CONTENT_TYPE: 'content-type',
    HTTP2_HEADER_USER_AGENT: 'user-agent',
    HTTP_STATUS_REQUEST_TIMEOUT: 408,
    HTTP_STATUS_TOO_MANY_REQUESTS: 429,
    HTTP_STATUS_INTERNAL_SERVER_ERROR: 500
  });
  const connect = (..._args: readonly unknown[]): never => unsupportedHttp2('connect');
  const createServer = (..._args: readonly unknown[]): never => unsupportedHttp2('createServer');
  const createSecureServer = (..._args: readonly unknown[]): never => unsupportedHttp2('createSecureServer');
  const performServerHandshake = (..._args: readonly unknown[]): never => unsupportedHttp2('performServerHandshake');
  const getDefaultSettings = (..._args: readonly unknown[]): never => unsupportedHttp2('getDefaultSettings');
  const getPackedSettings = (..._args: readonly unknown[]): never => unsupportedHttp2('getPackedSettings');
  const getUnpackedSettings = (..._args: readonly unknown[]): never => unsupportedHttp2('getUnpackedSettings');
  class Http2Server {
    constructor(..._args: readonly unknown[]) {
      unsupportedHttp2('Http2Server');
    }
  }
  class Http2SecureServer {
    constructor(..._args: readonly unknown[]) {
      unsupportedHttp2('Http2SecureServer');
    }
  }
  // Servers that accept both protocols tell them apart with
  // `request instanceof Http2ServerRequest`; nothing here is ever an instance.
  class Http2ServerRequest {
    constructor(..._args: readonly unknown[]) {
      unsupportedHttp2('Http2ServerRequest');
    }
  }
  class Http2ServerResponse {
    constructor(..._args: readonly unknown[]) {
      unsupportedHttp2('Http2ServerResponse');
    }
  }
  const http2 = {
    constants,
    connect,
    createServer,
    createSecureServer,
    performServerHandshake,
    getDefaultSettings,
    getPackedSettings,
    getUnpackedSettings,
    Http2Server,
    Http2SecureServer,
    Http2ServerRequest,
    Http2ServerResponse
  };
  return { ...http2, default: http2 };
}

function unsupportedHttp2(operation: string): never {
  const error = Object.assign(
    new Error(`node:http2.${operation}() is not supported because HTTP/2 transport is unavailable in this runtime.`),
    { code: 'ENOTSUP' as const, syscall: 'http2' }
  );
  error.name = 'NodeNetworkCapabilityError';
  throw error;
}

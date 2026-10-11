import type { PublishedEndpointIdentity } from './types';

export type PublishedEndpointCookieHeader = readonly [name: string, value: string];

export type PublishedEndpointDocumentCookieSnapshot = {
  readonly revision: number;
  readonly cookie: string;
};

export interface PublishedEndpointCookieJar {
  selectRequestHeaders(input: {
    readonly endpoint: PublishedEndpointIdentity;
    readonly requestPath: string;
    readonly headers: readonly PublishedEndpointCookieHeader[];
  }): PublishedEndpointCookieHeader[];
  storeResponseCookies(input: {
    readonly endpoint: PublishedEndpointIdentity;
    readonly requestPath: string;
    readonly headers: readonly PublishedEndpointCookieHeader[];
  }): PublishedEndpointCookieHeader[];
  documentSnapshot(input: {
    readonly endpoint: PublishedEndpointIdentity;
    readonly documentPath: string;
  }): PublishedEndpointDocumentCookieSnapshot;
  writeDocumentCookie(input: {
    readonly endpoint: PublishedEndpointIdentity;
    readonly documentPath: string;
    readonly baseRevision: number;
    readonly value: string;
  }): { readonly snapshot: PublishedEndpointDocumentCookieSnapshot; readonly staleBase: boolean };
  dispose(): void;
}

type EndpointCookieState = {
  readonly cookies: Map<string, StoredCookie>;
  revision: number;
};

type StoredCookie = {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly hostOnly: boolean;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite: 'default' | 'lax' | 'strict' | 'none';
  readonly creationOrder: number;
  readonly expiresAt?: number;
};

type ParsedCookie = Omit<StoredCookie, 'creationOrder'>;

export function createPublishedEndpointCookieJar(
  options: { readonly now?: () => number } = {}
): PublishedEndpointCookieJar {
  const now = options.now ?? Date.now;
  const cookiesByEndpoint = new Map<string, EndpointCookieState>();
  let nextCreationOrder = 0;
  let disposed = false;

  const assertOpen = (): void => {
    if (disposed) throw new Error('Published Endpoint Cookie Jar is closed.');
  };

  return {
    selectRequestHeaders(input) {
      assertOpen();
      const currentTime = now();
      const requestPath = requestPathname(input.requestPath);
      const state = cookiesByEndpoint.get(endpointKey(input.endpoint));
      const selected = selectCookies(state, input.endpoint, requestPath, currentTime);
      const headers = input.headers.filter(([name]) => name.toLowerCase() !== 'cookie');
      if (selected.length === 0) return [...headers];
      return [
        ...headers,
        ['cookie', selected.map(({ name, value }) => `${name}=${value}`).join('; ')]
      ];
    },

    storeResponseCookies(input) {
      assertOpen();
      const responseHeaders = input.headers.filter(
        ([name]) => name.toLowerCase() !== 'set-cookie'
      );
      const setCookieHeaders = input.headers.filter(
        ([name]) => name.toLowerCase() === 'set-cookie'
      );
      if (setCookieHeaders.length === 0) return [...responseHeaders];

      const key = endpointKey(input.endpoint);
      const state = cookiesByEndpoint.get(key) ?? { cookies: new Map<string, StoredCookie>(), revision: 0 };
      const currentTime = now();
      for (const [, value] of setCookieHeaders) {
        const parsed = parseSetCookie(value, {
          endpoint: input.endpoint,
          requestPath: requestPathname(input.requestPath),
          now: currentTime
        });
        if (!parsed) continue;
        applyCookie(state, parsed, currentTime);
      }
      if (state.cookies.size > 0 || state.revision > 0) cookiesByEndpoint.set(key, state);
      else cookiesByEndpoint.delete(key);
      return [...responseHeaders];
    },

    documentSnapshot(input) {
      assertOpen();
      const state = cookiesByEndpoint.get(endpointKey(input.endpoint));
      const cookies = selectCookies(state, input.endpoint, requestPathname(input.documentPath), now()).filter(
        (cookie) => !cookie.httpOnly
      );
      return {
        revision: state?.revision ?? 0,
        cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
      };
    },

    writeDocumentCookie(input) {
      assertOpen();
      const key = endpointKey(input.endpoint);
      const currentTime = now();
      const state = cookiesByEndpoint.get(key) ?? { cookies: new Map<string, StoredCookie>(), revision: 0 };
      expireCookies(state, currentTime);
      const staleBase = input.baseRevision !== state.revision;
      const parsed = parseSetCookie(input.value, {
        endpoint: input.endpoint,
        requestPath: requestPathname(input.documentPath),
        now: currentTime
      });
      if (parsed) {
        const documentCookie = { ...parsed, httpOnly: false };
        const existing = state.cookies.get(cookieKey(documentCookie));
        if (!existing?.httpOnly) applyCookie(state, documentCookie, currentTime);
      }
      if (state.cookies.size > 0 || state.revision > 0) cookiesByEndpoint.set(key, state);
      else cookiesByEndpoint.delete(key);
      const cookies = selectCookies(state, input.endpoint, requestPathname(input.documentPath), currentTime).filter(
        (cookie) => !cookie.httpOnly
      );
      return {
        staleBase,
        snapshot: {
          revision: state.revision,
          cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; ')
        }
      };
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      cookiesByEndpoint.clear();
    }
  };

  function applyCookie(state: EndpointCookieState, parsed: ParsedCookie, currentTime: number): void {
    const key = cookieKey(parsed);
    const previous = state.cookies.get(key);
    if (parsed.expiresAt !== undefined && parsed.expiresAt <= currentTime) {
      if (previous) {
        state.cookies.delete(key);
        state.revision += 1;
      }
      return;
    }
    const next = {
      ...parsed,
      creationOrder: previous?.creationOrder ?? ++nextCreationOrder
    };
    if (previous && sameCookie(previous, next)) return;
    state.cookies.set(key, next);
    state.revision += 1;
  }
}

function selectCookies(
  state: EndpointCookieState | undefined,
  endpoint: PublishedEndpointIdentity,
  requestPath: string,
  currentTime: number
): StoredCookie[] {
  if (!state) return [];
  expireCookies(state, currentTime);
  const requestHost = canonicalHost(endpoint.address.host);
  return [...state.cookies.values()]
    .filter(
      (cookie) =>
        domainMatches(requestHost, cookie.domain, cookie.hostOnly) &&
        pathMatches(requestPath, cookie.path) &&
        (!cookie.secure || endpoint.protocol === 'https')
    )
    .sort(
      (left, right) =>
        right.path.length - left.path.length ||
        left.creationOrder - right.creationOrder
    );
}

function expireCookies(state: EndpointCookieState, currentTime: number): void {
  for (const [key, cookie] of state.cookies) {
    if (cookie.expiresAt === undefined || cookie.expiresAt > currentTime) continue;
    state.cookies.delete(key);
    state.revision += 1;
  }
}

function sameCookie(left: StoredCookie, right: StoredCookie): boolean {
  return (
    left.name === right.name &&
    left.value === right.value &&
    left.domain === right.domain &&
    left.path === right.path &&
    left.hostOnly === right.hostOnly &&
    left.secure === right.secure &&
    left.httpOnly === right.httpOnly &&
    left.sameSite === right.sameSite &&
    left.expiresAt === right.expiresAt
  );
}

function parseSetCookie(
  value: string,
  context: {
    readonly endpoint: PublishedEndpointIdentity;
    readonly requestPath: string;
    readonly now: number;
  }
): ParsedCookie | undefined {
  const [pair = '', ...rawAttributes] = value.split(';');
  const separator = pair.indexOf('=');
  if (separator <= 0) return undefined;
  const name = pair.slice(0, separator).trim();
  const cookieValue = pair.slice(separator + 1).trim();
  if (!isCookieName(name) || hasControlCharacter(cookieValue)) return undefined;

  const requestHost = canonicalHost(context.endpoint.address.host);
  let domain = requestHost;
  let hostOnly = true;
  let path = defaultCookiePath(context.requestPath);
  let secure = false;
  let httpOnly = false;
  let sameSite: ParsedCookie['sameSite'] = 'default';
  let expiresAt: number | undefined;
  let maxAgeSeen = false;

  for (const rawAttribute of rawAttributes) {
    const attribute = rawAttribute.trim();
    if (!attribute) continue;
    const separator = attribute.indexOf('=');
    const name = (separator === -1 ? attribute : attribute.slice(0, separator))
      .trim()
      .toLowerCase();
    const value = separator === -1 ? '' : attribute.slice(separator + 1).trim();
    switch (name) {
      case 'domain': {
        const candidate = canonicalHost(value.replace(/^\./u, ''));
        if (!candidate || !domainMatches(requestHost, candidate, false)) return undefined;
        domain = candidate;
        hostOnly = false;
        break;
      }
      case 'path':
        if (value.startsWith('/')) path = value;
        break;
      case 'max-age':
        if (/^-?\d+$/u.test(value)) {
          maxAgeSeen = true;
          const seconds = Number(value);
          expiresAt =
            !Number.isFinite(seconds) || seconds > Number.MAX_SAFE_INTEGER / 1_000
              ? Number.MAX_SAFE_INTEGER
              : seconds <= 0
                ? context.now
                : context.now + seconds * 1_000;
        }
        break;
      case 'expires':
        if (!maxAgeSeen) {
          const parsed = Date.parse(value);
          if (Number.isFinite(parsed)) expiresAt = parsed;
        }
        break;
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'samesite': {
        const normalized = value.toLowerCase();
        if (normalized === 'lax' || normalized === 'strict' || normalized === 'none') {
          sameSite = normalized;
        }
        break;
      }
    }
  }

  if (secure && context.endpoint.protocol !== 'https') return undefined;
  if (sameSite === 'none' && !secure) return undefined;
  if (name.startsWith('__Secure-') && (!secure || context.endpoint.protocol !== 'https')) {
    return undefined;
  }
  if (
    name.startsWith('__Host-') &&
    (!secure || context.endpoint.protocol !== 'https' || !hostOnly || path !== '/')
  ) {
    return undefined;
  }
  return {
    name,
    value: cookieValue,
    domain,
    path,
    hostOnly,
    secure,
    httpOnly,
    sameSite,
    expiresAt
  };
}

function endpointKey(endpoint: PublishedEndpointIdentity): string {
  const { host, port } = endpoint.address;
  return `${endpoint.protocol}\u0000${canonicalHost(host)}\u0000${port}`;
}

function cookieKey(cookie: Pick<StoredCookie, 'name' | 'domain' | 'path'>): string {
  return `${cookie.name}\u0000${cookie.domain}\u0000${cookie.path}`;
}

function canonicalHost(host: string): string {
  return host.trim().replace(/^\[|\]$/gu, '').toLowerCase();
}

function domainMatches(requestHost: string, cookieDomain: string, hostOnly: boolean): boolean {
  if (requestHost === cookieDomain) return true;
  return !hostOnly && !isIpAddress(requestHost) && requestHost.endsWith(`.${cookieDomain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

function requestPathname(path: string): string {
  const withoutFragment = path.split('#', 1)[0] ?? '/';
  const pathname = withoutFragment.split('?', 1)[0] ?? '/';
  return pathname.startsWith('/') ? pathname : '/';
}

function defaultCookiePath(requestPath: string): string {
  if (!requestPath.startsWith('/') || requestPath === '/') return '/';
  const lastSlash = requestPath.lastIndexOf('/');
  return lastSlash <= 0 ? '/' : requestPath.slice(0, lastSlash);
}

function isCookieName(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(value);
}

function hasControlCharacter(value: string): boolean {
  return /[\u0000-\u001f\u007f]/u.test(value);
}

function isIpAddress(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':');
}

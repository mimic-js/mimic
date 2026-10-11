import type { MessageStream } from '../worker-transport';

type PublishedEndpointDocumentCookieRoute = {
  readonly manifestVersion: 1;
  readonly instanceId: string;
  readonly routeId: string;
  readonly port: number;
};

type PublishedEndpointDocumentCookieSnapshot = {
  readonly revision: number;
  readonly cookie: string;
};

export type PublishedEndpointDocumentCookieProgramOptions = {
  readonly openStream: (targetOrigin: string) => Promise<MessageStream>;
  readonly config: {
    readonly route: PublishedEndpointDocumentCookieRoute;
    readonly publicUrl: string;
    readonly logicalUrl: string;
    readonly snapshot: PublishedEndpointDocumentCookieSnapshot;
  };
};

export function installPublishedEndpointDocumentCookieProgram(
  options: PublishedEndpointDocumentCookieProgramOptions
): void {
  type DocumentCookieMutation = {
    readonly id: string;
    readonly baseRevision: number;
    readonly navigationId: number;
    readonly value: string;
    readonly path: string;
  };
  type DocumentCookieSnapshotMessage = {
    readonly type?: string;
    readonly mutationId?: string;
    readonly navigationId?: number;
    readonly snapshot?: PublishedEndpointDocumentCookieSnapshot;
  };
  type DocumentCookieWindow = Window & typeof globalThis & {
    __mimicPublishedEndpointDocumentCookieMirror?: boolean;
  };

  const documentWindow = window as DocumentCookieWindow;
  if (documentWindow.__mimicPublishedEndpointDocumentCookieMirror) return;
  documentWindow.__mimicPublishedEndpointDocumentCookieMirror = true;

  const { config, openStream } = options;
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');
  if (!descriptor?.configurable) {
    throw new Error('Published Endpoint document.cookie mirror cannot replace Document.prototype.cookie.');
  }

  let active = true;
  let nextMutationId = 1;
  let navigationId = 0;
  let authoritative = normalizeSnapshot(config.snapshot);
  let visible = authoritative.cookie;
  let inFlight: DocumentCookieMutation | undefined;
  let pending: DocumentCookieMutation[] = [];
  let stream: MessageStream | undefined;
  const handleMessage = (message: unknown): void => {
    if (!isRecord(message)) return;
    if (message.type === 'mimic:document-cookie-close') {
      active = false;
      stream?.close();
      return;
    }
    if (message.type !== 'mimic:document-cookie-snapshot' || !isSnapshot(message.snapshot)) {
      return;
    }
    if (message.navigationId !== navigationId) return;
    authoritative = normalizeSnapshot(message.snapshot);
    if (typeof message.mutationId === 'string' && inFlight?.id === message.mutationId) {
      pending.shift();
      inFlight = undefined;
    }
    pending = pending.map((mutation, index) =>
      inFlight && index === 0
        ? mutation
        : { ...mutation, baseRevision: authoritative.revision }
    );
    rebuildVisible();
    sendNextMutation();
  };
  void openStream(new URL(documentWindow.location.href).origin).then(
    (openedStream) => {
      if (!active) {
        openedStream.close();
        return;
      }
      stream = openedStream;
      openedStream.subscribe(handleMessage);
      openedStream.send({
        type: 'mimic:document-cookie-open',
        ...config.route,
        path: currentLogicalPath()
      });
      if (navigationId > 0) {
        openedStream.send({
          type: 'mimic:document-cookie-navigate',
          navigationId,
          path: currentLogicalPath()
        });
      }
      sendNextMutation();
    },
    (error: unknown) => {
      active = false;
      queueMicrotask(() => {
        throw error;
      });
    }
  );

  Object.defineProperty(Document.prototype, 'cookie', {
    configurable: true,
    enumerable: descriptor.enumerable,
    get() {
      assertActive();
      return visible;
    },
    set(value: string) {
      assertActive();
      const cookie = String(value);
      const optimistic = applyOptimisticMutation(
        visible,
        cookie,
        currentLogicalPath(),
        currentLogicalPath()
      );
      if (!optimistic.accepted) return;
      const mutation: DocumentCookieMutation = {
        id: `${config.route.instanceId}:${config.route.routeId}:${nextMutationId++}`,
        baseRevision: authoritative.revision,
        navigationId,
        value: cookie,
        path: currentLogicalPath()
      };
      pending.push(mutation);
      rebuildVisible();
      sendNextMutation();
    }
  });

  const history = documentWindow.history;
  const sendNavigation = (): void => {
    if (!active) return;
    navigationId += 1;
    pending = [];
    inFlight = undefined;
    rebuildVisible();
    stream?.send({
      type: 'mimic:document-cookie-navigate',
      navigationId,
      path: currentLogicalPath()
    });
  };
  const nativePushState = history.pushState;
  const nativeReplaceState = history.replaceState;
  history.pushState = function pushState(...args: Parameters<History['pushState']>) {
    const result = nativePushState.apply(this, args);
    sendNavigation();
    return result;
  };
  history.replaceState = function replaceState(...args: Parameters<History['replaceState']>) {
    const result = nativeReplaceState.apply(this, args);
    sendNavigation();
    return result;
  };
  documentWindow.addEventListener('popstate', sendNavigation);

  function assertActive(): void {
    if (!active) throw new DOMException('Published Endpoint is closed', 'InvalidStateError');
  }

  function sendNextMutation(): void {
    if (!active || !stream || inFlight || pending.length === 0) return;
    const mutation = pending[0];
    if (!mutation) return;
    inFlight = mutation;
    stream.send({
      type: 'mimic:document-cookie-write',
      id: mutation.id,
      baseRevision: mutation.baseRevision,
      navigationId: mutation.navigationId,
      value: mutation.value,
      path: mutation.path
    });
  }

  function rebuildVisible(): void {
    visible = authoritative.cookie;
    for (const mutation of pending) {
      const next = applyOptimisticMutation(
        visible,
        mutation.value,
        mutation.path,
        currentLogicalPath()
      );
      if (next.accepted) visible = next.cookie;
    }
  }

  function currentLogicalPath(): string {
    const current = new URL(documentWindow.location.href);
    const published = new URL(config.publicUrl);
    const publicPath = published.pathname.endsWith('/')
      ? published.pathname
      : `${published.pathname}/`;
    if (current.origin === published.origin && current.pathname.startsWith(publicPath)) {
      const suffix = current.pathname.slice(publicPath.length);
      return `/${suffix}${current.search}`;
    }
    if (current.origin === published.origin) {
      return `${current.pathname}${current.search}`;
    }
    const logical = new URL(config.logicalUrl);
    return `${logical.pathname}${logical.search}`;
  }

  function applyOptimisticMutation(
    cookie: string,
    rawValue: string,
    sourcePath: string,
    visiblePath: string
  ): { readonly accepted: boolean; readonly cookie: string } {
    const [rawPair = '', ...rawAttributes] = rawValue.split(';');
    const pair = rawPair.trim();
    const separator = pair.indexOf('=');
    if (separator <= 0) return { accepted: false, cookie };
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name) || /[\u0000-\u001f\u007f]/u.test(value)) {
      return { accepted: false, cookie };
    }
    const attributes = new Map<string, string>();
    for (const rawAttribute of rawAttributes) {
      const attribute = rawAttribute.trim();
      if (!attribute) continue;
      const attributeSeparator = attribute.indexOf('=');
      attributes.set(
        (attributeSeparator === -1 ? attribute : attribute.slice(0, attributeSeparator))
          .trim()
          .toLowerCase(),
        attributeSeparator === -1 ? '' : attribute.slice(attributeSeparator + 1).trim()
      );
    }
    const logical = new URL(config.logicalUrl);
    const requestedDomain = attributes.get('domain')?.replace(/^\./u, '').toLowerCase();
    if (requestedDomain && !domainMatches(logical.hostname, requestedDomain)) {
      return { accepted: false, cookie };
    }
    const secure = attributes.has('secure');
    if (secure && logical.protocol !== 'https:') return { accepted: false, cookie };
    if ((attributes.get('samesite') ?? '').toLowerCase() === 'none' && !secure) {
      return { accepted: false, cookie };
    }
    const sourcePathname = requestPathname(sourcePath);
    const cookiePath = attributes.get('path')?.startsWith('/')
      ? attributes.get('path')!
      : defaultCookiePath(sourcePathname);
    if (
      name.startsWith('__Secure-') &&
      (!secure || logical.protocol !== 'https:')
    ) {
      return { accepted: false, cookie };
    }
    if (
      name.startsWith('__Host-') &&
      (!secure ||
        logical.protocol !== 'https:' ||
        requestedDomain !== undefined ||
        cookiePath !== '/')
    ) {
      return { accepted: false, cookie };
    }
    const pairs = cookie
      .split(/;\s*/u)
      .filter(Boolean)
      .filter((candidate) => candidate.slice(0, candidate.indexOf('=')).trim() !== name);
    const maxAge = attributes.get('max-age');
    const expires = attributes.get('expires');
    const deletes =
      (maxAge !== undefined && /^-?\d+$/u.test(maxAge) && Number(maxAge) <= 0) ||
      (expires !== undefined &&
        Number.isFinite(Date.parse(expires)) &&
        Date.parse(expires) <= Date.now());
    const visibleAtCurrentPath = pathMatches(requestPathname(visiblePath), cookiePath);
    return {
      accepted: true,
      cookie: !visibleAtCurrentPath
        ? cookie
        : deletes
          ? pairs.join('; ')
          : [...pairs, `${name}=${value}`].join('; ')
    };
  }

  function requestPathname(path: string): string {
    const withoutFragment = path.split('#', 1)[0] ?? '/';
    const pathname = withoutFragment.split('?', 1)[0] ?? '/';
    return pathname.startsWith('/') ? pathname : '/';
  }

  function defaultCookiePath(path: string): string {
    if (!path.startsWith('/') || path === '/') return '/';
    const lastSlash = path.lastIndexOf('/');
    return lastSlash <= 0 ? '/' : path.slice(0, lastSlash);
  }

  function pathMatches(path: string, cookiePath: string): boolean {
    if (path === cookiePath) return true;
    if (!path.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
  }

  function domainMatches(host: string, domain: string): boolean {
    const normalizedHost = host.toLowerCase();
    return (
      normalizedHost === domain ||
      (!isIpAddress(normalizedHost) && normalizedHost.endsWith(`.${domain}`))
    );
  }

  function isIpAddress(host: string): boolean {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host) || host.includes(':');
  }

  function normalizeSnapshot(snapshot: PublishedEndpointDocumentCookieSnapshot): PublishedEndpointDocumentCookieSnapshot {
    return { revision: snapshot.revision, cookie: snapshot.cookie };
  }

  function isSnapshot(value: unknown): value is PublishedEndpointDocumentCookieSnapshot {
    return (
      isRecord(value) &&
      typeof value.revision === 'number' &&
      Number.isFinite(value.revision) &&
      typeof value.cookie === 'string'
    );
  }

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }
}

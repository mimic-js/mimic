import { describe, expect, test } from 'vitest';

import { type PublishedEndpointIdentity } from '../../src/runtime/modules/published-endpoint';
import {
  createPublishedEndpointCookieJar
} from '../../src/runtime/modules/published-endpoint/cookie-jar';

const accountEndpoint: PublishedEndpointIdentity = {
  routeId: 'epoch-a:route-1',
  protocol: 'https',
  address: { host: 'app.internal', port: 443 }
};

describe('Published Endpoint Cookie Jar', () => {
  test('makes server cookie mutation authoritative for matching logical-origin requests', () => {
    let now = Date.UTC(2026, 6, 25, 8);
    const jar = createPublishedEndpointCookieJar({ now: () => now });

    expect(
      jar.storeResponseCookies({
        endpoint: accountEndpoint,
        requestPath: '/account/login',
        headers: [
          ['set-cookie', 'session=primary; Path=/account; HttpOnly; Secure; SameSite=Strict'],
          ['set-cookie', 'theme=dark; Path=/'],
          ['x-result', 'stored']
        ]
      })
    ).toEqual([['x-result', 'stored']]);

    expect(
      jar.selectRequestHeaders({
        endpoint: accountEndpoint,
        requestPath: '/account/profile?tab=security',
        headers: [
          ['accept', 'application/json'],
          ['cookie', 'physical-origin=must-not-leak']
        ]
      })
    ).toEqual([
      ['accept', 'application/json'],
      ['cookie', 'session=primary; theme=dark']
    ]);
    expect(
      jar.selectRequestHeaders({
        endpoint: accountEndpoint,
        requestPath: '/public',
        headers: []
      })
    ).toEqual([['cookie', 'theme=dark']]);
    expect(
      jar.selectRequestHeaders({
        endpoint: { ...accountEndpoint, protocol: 'http' },
        requestPath: '/account/profile',
        headers: []
      })
    ).toEqual([]);

    now += 1_000;
    jar.storeResponseCookies({
      endpoint: accountEndpoint,
      requestPath: '/account/login',
      headers: [['set-cookie', 'session=; Path=/account; Max-Age=0']]
    });
    expect(
      jar.selectRequestHeaders({
        endpoint: accountEndpoint,
        requestPath: '/account/profile',
        headers: []
      })
    ).toEqual([['cookie', 'theme=dark']]);
  });

  test('preserves cookies across an endpoint rebind while isolating endpoints and runtime epochs', () => {
    const firstEpoch = createPublishedEndpointCookieJar();
    const secondEpoch = createPublishedEndpointCookieJar();
    const otherEndpoint: PublishedEndpointIdentity = {
      routeId: 'epoch-a:route-2',
      protocol: 'https',
      address: { host: 'app.internal', port: 8443 }
    };

    firstEpoch.storeResponseCookies({
      endpoint: accountEndpoint,
      requestPath: '/login',
      headers: [['set-cookie', 'session=epoch-a; Path=/']]
    });

    expect(
      firstEpoch.selectRequestHeaders({
        endpoint: { ...accountEndpoint, routeId: 'epoch-a:route-rebound' },
        requestPath: '/after-rebind',
        headers: []
      })
    ).toEqual([['cookie', 'session=epoch-a']]);
    expect(
      firstEpoch.selectRequestHeaders({
        endpoint: otherEndpoint,
        requestPath: '/',
        headers: []
      })
    ).toEqual([]);
    expect(
      secondEpoch.selectRequestHeaders({
        endpoint: accountEndpoint,
        requestPath: '/',
        headers: []
      })
    ).toEqual([]);
  });

  test('projects a revisioned document snapshot without exposing or overwriting HttpOnly cookies', () => {
    const jar = createPublishedEndpointCookieJar();

    jar.storeResponseCookies({
      endpoint: accountEndpoint,
      requestPath: '/account/login',
      headers: [
        ['set-cookie', 'session=server-secret; Path=/account; HttpOnly'],
        ['set-cookie', 'theme=light; Path=/account']
      ]
    });

    expect(jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/account/profile' })).toEqual({
      revision: 2,
      cookie: 'theme=light'
    });

    expect(
      jar.writeDocumentCookie({
        endpoint: accountEndpoint,
        documentPath: '/account/profile',
        baseRevision: 2,
        value: 'session=script-value; Path=/account'
      })
    ).toEqual({
      staleBase: false,
      snapshot: { revision: 2, cookie: 'theme=light' }
    });

    expect(
      jar.writeDocumentCookie({
        endpoint: accountEndpoint,
        documentPath: '/account/profile',
        baseRevision: 2,
        value: 'theme=dark; Path=/account'
      })
    ).toEqual({
      staleBase: false,
      snapshot: { revision: 3, cookie: 'theme=dark' }
    });
    expect(
      jar.selectRequestHeaders({ endpoint: accountEndpoint, requestPath: '/account/profile', headers: [] })
    ).toEqual([['cookie', 'session=server-secret; theme=dark']]);
  });

  test('rebases a stale document write onto later server state', () => {
    const jar = createPublishedEndpointCookieJar();
    const initial = jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/account/profile' });

    jar.storeResponseCookies({
      endpoint: accountEndpoint,
      requestPath: '/account/profile',
      headers: [['set-cookie', 'server=authoritative; Path=/account']]
    });

    expect(
      jar.writeDocumentCookie({
        endpoint: accountEndpoint,
        documentPath: '/account/profile',
        baseRevision: initial.revision,
        value: 'theme=dark; Path=/account'
      })
    ).toEqual({
      staleBase: true,
      snapshot: { revision: 2, cookie: 'server=authoritative; theme=dark' }
    });
  });

  test('applies document path, secure, and deletion semantics without promoting HttpOnly', () => {
    const jar = createPublishedEndpointCookieJar();

    expect(
      jar.writeDocumentCookie({
        endpoint: accountEndpoint,
        documentPath: '/account/profile',
        baseRevision: 0,
        value: 'visible=script; Path=/account; Secure; HttpOnly'
      })
    ).toEqual({
      staleBase: false,
      snapshot: { revision: 1, cookie: 'visible=script' }
    });
    expect(jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/outside' })).toEqual({
      revision: 1,
      cookie: ''
    });
    expect(
      jar.documentSnapshot({
        endpoint: { ...accountEndpoint, protocol: 'http' },
        documentPath: '/account/profile'
      })
    ).toEqual({ revision: 0, cookie: '' });

    expect(
      jar.writeDocumentCookie({
        endpoint: accountEndpoint,
        documentPath: '/account/profile',
        baseRevision: 1,
        value: 'visible=; Path=/account; Max-Age=0'
      })
    ).toEqual({
      staleBase: false,
      snapshot: { revision: 2, cookie: '' }
    });
    expect(jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/account/profile' })).toEqual({
      revision: 2,
      cookie: ''
    });
  });

  test('keeps document revisions isolated per endpoint', () => {
    const jar = createPublishedEndpointCookieJar();
    const otherEndpoint: PublishedEndpointIdentity = {
      routeId: 'epoch-a:route-2',
      protocol: 'https',
      address: { host: 'other.internal', port: 443 }
    };

    jar.writeDocumentCookie({
      endpoint: accountEndpoint,
      documentPath: '/',
      baseRevision: 0,
      value: 'account=one; Path=/'
    });
    jar.storeResponseCookies({
      endpoint: accountEndpoint,
      requestPath: '/',
      headers: [['set-cookie', 'server=two; Path=/']]
    });

    expect(jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/' })).toEqual({
      revision: 2,
      cookie: 'account=one; server=two'
    });
    expect(jar.documentSnapshot({ endpoint: otherEndpoint, documentPath: '/' })).toEqual({
      revision: 0,
      cookie: ''
    });
  });

  test('advances a document revision when observing an expired cookie eviction', () => {
    let now = Date.UTC(2026, 6, 25, 8);
    const jar = createPublishedEndpointCookieJar({ now: () => now });
    jar.storeResponseCookies({
      endpoint: accountEndpoint,
      requestPath: '/',
      headers: [['set-cookie', 'short=lived; Path=/; Max-Age=1']]
    });

    expect(jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/' })).toEqual({
      revision: 1,
      cookie: 'short=lived'
    });
    now += 1_000;
    expect(jar.documentSnapshot({ endpoint: accountEndpoint, documentPath: '/' })).toEqual({
      revision: 2,
      cookie: ''
    });
  });
});

import { portDependencies } from './registry';

/**
 * `qs` as the `url` port imports it. Node's own `url.parse(url, true)` and
 * `url.format` read and write queries with `node:querystring`, so the port does
 * too; the `qs` options it passes have no `querystring` counterpart.
 */
export const parse = (query: string) => portDependencies().querystring.parse(query);
export const stringify = (query: Record<string, unknown>) => portDependencies().querystring.stringify(query);

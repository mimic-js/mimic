import { portDependencies } from './registry';

/**
 * `process/` as the adopted ports import it. They use it for `nextTick`, which
 * carries the Async Context frame it was called in (ADR-0018).
 */
export const { nextTick } = portDependencies();
export const env: Readonly<Record<string, string>> = {};

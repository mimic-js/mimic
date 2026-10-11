import { createHash, randomUUID } from 'node:crypto';
import { utimesSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { APIResponse } from '@playwright/test';

export type TarballCacheRoute = Readonly<{
  request(): Readonly<{ url(): string; method(): string }>;
  fetch(): Promise<APIResponse>;
  fulfill(
    options: Readonly<{ body: Buffer; headers?: Record<string, string>; response?: APIResponse; status?: number }>
  ): Promise<void>;
  fallback(): Promise<void>;
}>;

export type TarballCacheRouteHandler = (route: TarballCacheRoute) => Promise<void>;

export type TarballCacheBrowserContext = Readonly<{
  route(url: RegExp, handler: TarballCacheRouteHandler): Promise<void>;
  unroute(url: RegExp, handler?: TarballCacheRouteHandler): Promise<void>;
}>;

export type PlaywrightTarballCacheEvidence = Readonly<{
  requests: number;
  hits: number;
  misses: number;
  urls: readonly string[];
}>;

export type PlaywrightTarballCacheSession = Readonly<{
  evidence(): PlaywrightTarballCacheEvidence;
  close(): Promise<void>;
}>;

type CachedTarballResponse = Readonly<{
  status: number;
  body: Buffer;
  headers?: Record<string, string>;
  dispose?: () => Promise<void>;
}>;

type PendingTarballResponse = {
  readonly response: Promise<CachedTarballResponse>;
  consumers: number;
};

const tarballRequestsPattern = /^https:\/\/[^?#]+\.tgz(?:[?#].*)?$/i;
const loadLeasePollIntervalMs = 25;
const loadLeaseHeartbeatIntervalMs = 1_000;
const loadLeaseHeartbeatStaleAfterMs = 30_000;
const maxConcurrentUpstreamLoads = 4;
// Every waiting lease lists and reads its lock directory on each poll, so the
// leases one process waits on at once are bounded: a cold install of a few
// hundred tarballs otherwise exceeds the open-file limit.
const maxWaitingLoadsPerProcess = 8;
let waitingLoads = 0;
const loadQueue: Array<() => void> = [];

async function withLoadSlot<T>(load: () => Promise<T>): Promise<T> {
  if (waitingLoads >= maxWaitingLoadsPerProcess) {
    await new Promise<void>((resolve) => loadQueue.push(resolve));
  } else {
    waitingLoads += 1;
  }
  try {
    return await load();
  } finally {
    const next = loadQueue.shift();
    if (next) next();
    else waitingLoads -= 1;
  }
}

export async function installPlaywrightTarballCache(
  context: TarballCacheBrowserContext,
  options: Readonly<{ directory: string }>
): Promise<PlaywrightTarballCacheSession> {
  const evidence = { requests: 0, hits: 0, misses: 0, urls: [] as string[] };
  const inFlight = new Map<string, PendingTarballResponse>();
  const handler: TarballCacheRouteHandler = async (route) => {
    const request = route.request();
    if (request.method() !== 'GET') {
      await route.fallback();
      return;
    }
    const url = request.url();
    evidence.requests += 1;
    evidence.urls.push(url);

    const entryPath = integrityPointerPath(options.directory, url);
    const cached = await readCachedTarball(entryPath);
    if (cached) {
      evidence.hits += 1;
      await route.fulfill({ status: 200, body: cached });
      return;
    }

    evidence.misses += 1;
    let pending = inFlight.get(entryPath);
    if (!pending) {
      pending = { response: withLoadSlot(() => fetchAndCache(route, entryPath)), consumers: 0 };
      inFlight.set(entryPath, pending);
    }
    pending.consumers += 1;
    try {
      const response = await pending.response;
      await route.fulfill(
        response.headers
          ? { status: response.status, body: response.body, headers: response.headers }
          : { status: response.status, body: response.body }
      );
    } finally {
      pending.consumers -= 1;
      if (pending.consumers === 0) {
        if (inFlight.get(entryPath) === pending) inFlight.delete(entryPath);
        await pending.response.then(
          (response) => response.dispose?.(),
          () => undefined
        );
      }
    }
  };

  await context.route(tarballRequestsPattern, handler);
  return {
    evidence: () => ({ ...evidence, urls: [...evidence.urls] }),
    close: () => context.unroute(tarballRequestsPattern, handler)
  };
}

/** Whether the cache already answers `url`, with its integrity intact. */
export async function hasCachedPlaywrightTarball(directory: string, url: string): Promise<boolean> {
  return (await readCachedTarball(integrityPointerPath(directory, url))) !== undefined;
}

/** Stores publisher bytes for `url` as a compatibility install would on a miss. */
export async function storePlaywrightTarball(directory: string, url: string, body: Buffer): Promise<void> {
  await writeCachedTarball(integrityPointerPath(directory, url), body);
}

async function fetchAndCache(route: TarballCacheRoute, entryPath: string): Promise<CachedTarballResponse> {
  const release = await acquirePlaywrightTarballCacheLoadLease(entryPath);
  try {
    const cached = await readCachedTarball(entryPath);
    if (cached) return { status: 200, body: cached };

    const releaseUpstreamLoad = await acquirePlaywrightTarballCacheLoadLease(
      join(dirname(entryPath), '.upstream-load'),
      maxConcurrentUpstreamLoads
    );
    try {
      const response = await route.fetch();
      try {
        const body = await response.body();
        if (!response.ok()) {
          return {
            status: response.status(),
            body,
            headers: response.headers(),
            dispose: () => response.dispose()
          };
        }
        await writeCachedTarball(entryPath, body);
        return { status: response.status(), body, dispose: () => response.dispose() };
      } catch (error: unknown) {
        await response.dispose();
        throw error;
      }
    } finally {
      await releaseUpstreamLoad();
    }
  } finally {
    await release();
  }
}

export async function acquirePlaywrightTarballCacheLoadLease(
  path: string,
  capacity = 1
): Promise<() => Promise<void>> {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new Error(`Invalid Playwright tarball cache load capacity: ${capacity}`);
  }
  const directory = `${path}.loads`;
  await mkdir(directory, { recursive: true });
  const participant = `${process.pid}-${randomUUID()}`;
  const heartbeatPath = join(directory, `${participant}.heartbeat`);
  const choosingPath = join(directory, `${participant}.choosing`);
  const ticketPath = join(directory, `${participant}.ticket`);
  await writeAtomically(heartbeatPath, Buffer.alloc(0));
  const heartbeat = startLoadParticipantHeartbeat(heartbeatPath);
  try {
    await writeAtomically(choosingPath, Buffer.alloc(0));
    const tickets = await readActiveLoadTickets(directory);
    const ticket = tickets.reduce((highest, candidate) => Math.max(highest, candidate.ticket), 0) + 1;
    await writeAtomically(ticketPath, Buffer.from(String(ticket)));
    await rm(choosingPath, { force: true });
    await waitForLoadLeaseTurn(directory, { participant, ticket }, heartbeat, capacity);
    let released = false;
    return async () => {
      if (released) return;
      const heartbeatFailure = heartbeat.stop();
      await Promise.all([rm(ticketPath, { force: true }), rm(heartbeatPath, { force: true })]);
      released = true;
      if (heartbeatFailure !== undefined) throw heartbeatFailure;
    };
  } catch (error: unknown) {
    heartbeat.stop();
    await Promise.all([
      rm(heartbeatPath, { force: true }),
      rm(choosingPath, { force: true }),
      rm(ticketPath, { force: true })
    ]);
    throw error;
  }
}

type LoadTicket = Readonly<{ participant: string; ticket: number }>;
type LoadParticipantHeartbeat = Readonly<{
  assertHealthy(): void;
  stop(): unknown;
}>;

async function waitForLoadLeaseTurn(
  directory: string,
  current: LoadTicket,
  heartbeat: LoadParticipantHeartbeat,
  capacity: number
): Promise<void> {
  // A filesystem form of Lamport's bakery lock: choosing files expose ticket publication,
  // while generation-unique participant files make abandoned-owner cleanup safe.
  while (true) {
    heartbeat.assertHealthy();
    const choosing = await readActiveLoadParticipants(directory, '.choosing');
    if (choosing.some((participant) => participant !== current.participant)) {
      await waitForLoadLeasePoll();
      continue;
    }

    const tickets = await readActiveLoadTickets(directory);
    const earlierTicketCount = tickets.filter(
      (candidate) =>
        candidate.participant !== current.participant &&
        (candidate.ticket < current.ticket ||
          (candidate.ticket === current.ticket && candidate.participant < current.participant))
    ).length;
    if (earlierTicketCount < capacity) return;
    await waitForLoadLeasePoll();
  }
}

async function readActiveLoadTickets(directory: string): Promise<LoadTicket[]> {
  const participants = await readActiveLoadParticipants(directory, '.ticket');
  const tickets = await Promise.all(
    participants.map(async (participant): Promise<LoadTicket | undefined> => {
      try {
        const value = Number(await readFile(join(directory, `${participant}.ticket`), 'utf8'));
        if (!Number.isSafeInteger(value) || value <= 0) {
          throw new Error(`Invalid Playwright tarball cache load ticket for ${participant}`);
        }
        return { participant, ticket: value };
      } catch (error: unknown) {
        if (isMissing(error)) return undefined;
        throw error;
      }
    })
  );
  return tickets.filter((ticket): ticket is LoadTicket => ticket !== undefined);
}

async function readActiveLoadParticipants(directory: string, suffix: '.choosing' | '.ticket'): Promise<string[]> {
  const entries = (await readdir(directory)).filter((entry) => entry.endsWith(suffix));
  const active = await Promise.all(
    entries.map(async (entry): Promise<string | undefined> => {
      const participant = entry.slice(0, -suffix.length);
      const separator = participant.indexOf('-');
      const pid = Number(participant.slice(0, separator));
      if (separator <= 0 || !Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error(`Invalid Playwright tarball cache load participant: ${entry}`);
      }
      if (await loadParticipantIsActive(directory, participant, pid)) return participant;
      await Promise.all([
        rm(join(directory, entry), { force: true }),
        rm(join(directory, `${participant}.heartbeat`), { force: true })
      ]);
      return undefined;
    })
  );
  return active.filter((participant): participant is string => participant !== undefined);
}

async function loadParticipantIsActive(directory: string, participant: string, pid: number): Promise<boolean> {
  if (!processIsRunning(pid)) return false;
  try {
    const heartbeat = await stat(join(directory, `${participant}.heartbeat`));
    return Date.now() - heartbeat.mtimeMs <= loadLeaseHeartbeatStaleAfterMs;
  } catch (error: unknown) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function startLoadParticipantHeartbeat(path: string): LoadParticipantHeartbeat {
  let failure: unknown;
  const timer = setInterval(() => {
    try {
      const now = new Date();
      utimesSync(path, now, now);
    } catch (error: unknown) {
      failure = error;
    }
  }, loadLeaseHeartbeatIntervalMs);
  timer.unref();
  return {
    assertHealthy: () => {
      if (failure !== undefined) throw failure;
    },
    stop: () => {
      clearInterval(timer);
      return failure;
    }
  };
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    if (isMissingProcess(error)) return false;
    if (isPermissionDenied(error)) return true;
    throw error;
  }
}

async function waitForLoadLeasePoll(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, loadLeasePollIntervalMs));
}

async function readCachedTarball(entryPath: string): Promise<Buffer | undefined> {
  try {
    const integrity = await readFile(entryPath, 'utf8');
    const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
    if (!match || Buffer.from(match[1], 'base64').byteLength !== 64) {
      await rm(entryPath, { force: true });
      return undefined;
    }
    const objectPath = tarballObjectPath(dirname(entryPath), integrity);
    const body = await readFile(objectPath);
    if (sha512(body) === integrity) return body;
    await Promise.all([rm(entryPath, { force: true }), rm(objectPath, { force: true })]);
    return undefined;
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

async function writeCachedTarball(entryPath: string, body: Buffer): Promise<void> {
  const integrity = sha512(body);
  await writeAtomically(tarballObjectPath(dirname(entryPath), integrity), body);
  await writeAtomically(entryPath, Buffer.from(integrity));
}

async function writeAtomically(path: string, body: Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body);
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function integrityPointerPath(directory: string, url: string): string {
  return join(directory, `${createHash('sha256').update(url).digest('hex')}.integrity`);
}

function tarballObjectPath(directory: string, integrity: string): string {
  const digest = Buffer.from(integrity.slice('sha512-'.length), 'base64').toString('hex');
  return join(directory, 'objects', `sha512-${digest}.tgz`);
}

function sha512(body: Buffer): string {
  return `sha512-${createHash('sha512').update(body).digest('base64')}`;
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ENOENT';
}

function isMissingProcess(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'ESRCH';
}

function isPermissionDenied(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && error.code === 'EPERM';
}

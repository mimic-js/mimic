import { BrowserBuffer } from './buffer';
import { EventEmitter } from './events';
import {
  basename,
  isVfsCommitInvalidation,
  selectVfsCommittedWatchChanges,
  type VfsCommittedWatchEvent,
  type VfsCommitInvalidation
} from '../virtual-file-system';
import type {
  NodeFileSystemSynchronousPort,
  NodeFileSystemWatchPort,
  NodeFileWatchLifecycle
} from './filesystem';
import {
  errorCode,
  type FileSystemPath,
  nodeFileSystemError,
  resolveFileSystemPath
} from './filesystem-shared';

type WatchFileSubscription = {
  readonly listener?: (current: unknown, previous: unknown) => void;
  readonly unwatch: () => void;
};

type CommittedWatchSubscription = {
  readonly path: string;
  readonly recursive: boolean;
  readonly listener: (
    changedPath: string,
    event: 'change' | 'rename',
    resync: boolean
  ) => void;
};

export const NODE_FILE_SYSTEM_WATCH_TRACE_ENV =
  'MIMIC_VFS_WATCH_TRACE';
export const NODE_FILE_SYSTEM_WATCH_TRACE_PREFIX =
  'MIMIC_VFS_WATCH ';

/** `encoding: 'buffer'` reports each filename as a Buffer, as native bindings that copy it into memory expect. */
export type NodeFileSystemWatchOptions = { readonly recursive?: boolean; readonly encoding?: string | null };
export type NodeFileSystemWatchListener = (eventType: string, filename: string | Uint8Array) => void;

export interface NodeFileSystemWatchOperations {
  unwatchFile(
    path: FileSystemPath,
    listener?: (current: unknown, previous: unknown) => void
  ): void;
  watch(
    path: FileSystemPath,
    optionsOrListener?: NodeFileSystemWatchOptions | string | NodeFileSystemWatchListener,
    listener?: NodeFileSystemWatchListener
  ): EventEmitter;
  watchFile(
    path: FileSystemPath,
    optionsOrListener?:
      | { readonly interval?: number }
      | ((current: unknown, previous: unknown) => void),
    listener?: (current: unknown, previous: unknown) => void
  ): EventEmitter;
}

export type NodeFileSystemWatchDiagnosticEvent =
  | {
      readonly kind: 'registered';
      readonly watchId: number;
      readonly watchedPath: string;
      readonly recursive: boolean;
      readonly registrationRevision: number;
      readonly cursor: number;
    }
  | {
      readonly kind: 'delivered';
      readonly watchId: number;
      readonly watchedPath: string;
      readonly recursive: boolean;
      readonly revision: number;
      readonly invalidations: readonly VfsCommitInvalidation[];
      readonly projectedPaths: readonly string[];
    }
  | {
      readonly kind: 'resync-required';
      readonly watchId: number;
      readonly watchedPath: string;
      readonly recursive: boolean;
      readonly currentRevision: number;
      readonly reason: 'subscriber-backpressure' | 'journal-expired';
    };

export function formatNodeFileSystemWatchTrace(
  event: NodeFileSystemWatchDiagnosticEvent
): string {
  return `${NODE_FILE_SYSTEM_WATCH_TRACE_PREFIX}${JSON.stringify(event)}`;
}

export function parseNodeFileSystemWatchTrace(
  line: string
): NodeFileSystemWatchDiagnosticEvent | undefined {
  const marker = line.indexOf(NODE_FILE_SYSTEM_WATCH_TRACE_PREFIX);
  if (marker < 0) return undefined;
  const parsed: unknown = JSON.parse(
    line.slice(marker + NODE_FILE_SYSTEM_WATCH_TRACE_PREFIX.length)
  );
  if (!isNodeFileSystemWatchDiagnosticEvent(parsed)) {
    throw new TypeError('Node filesystem watch trace has an invalid shape.');
  }
  return parsed;
}

export function createNodeFileSystemWatchOperations(options: {
  readonly cwd: string;
  readonly fileWatchLifecycle?: NodeFileWatchLifecycle;
  readonly synchronous: NodeFileSystemSynchronousPort;
  readonly watch?: NodeFileSystemWatchPort;
  readonly watchDiagnostics?: (event: NodeFileSystemWatchDiagnosticEvent) => void;
}): NodeFileSystemWatchOperations {
  const watchFileSubscriptions = new Map<string, Set<WatchFileSubscription>>();
  const committedSubscriptions = new Map<number, CommittedWatchSubscription>();
  let committedRegistration:
    | { readonly registrationRevision: number; readonly cursor: number }
    | undefined;
  let stopCommittedWatch: (() => void) | undefined;
  let nextWatchId = 0;

  function watch(
    path: FileSystemPath,
    optionsOrListener?: NodeFileSystemWatchOptions | string | NodeFileSystemWatchListener,
    listener?: NodeFileSystemWatchListener
  ): EventEmitter {
    if (!options.watch) throw nodeFileSystemError('ENOTSUP', 'Filesystem watching is unavailable.');
    const normalized = resolveFileSystemPath(path, options.cwd);
    const callback = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
    const watchOptions: NodeFileSystemWatchOptions =
      typeof optionsOrListener === 'object' && optionsOrListener !== null
        ? optionsOrListener
        : typeof optionsOrListener === 'string'
          ? { encoding: optionsOrListener }
          : {};
    const recursive = watchOptions.recursive ?? false;
    const asBuffer = watchOptions.encoding === 'buffer';
    const watcher = new EventEmitter() as EventEmitter & {
      close(): void;
      ref(): typeof watcher;
      unref(): typeof watcher;
    };
    const unwatch = watchCommitted(normalized, recursive, (changedPath, eventType) => {
      const name = watchedFilename(changedPath, normalized);
      const filename = asBuffer ? BrowserBuffer.from(name) : name;
      callback?.(eventType, filename);
      watcher.emit('change', eventType, filename);
    });
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unwatch();
    };
    const lifecycleHandle = options.fileWatchLifecycle?.open(cleanup);
    watcher.close = () => {
      if (closed) return;
      if (lifecycleHandle) lifecycleHandle.close();
      else cleanup();
      watcher.emit('close');
    };
    watcher.ref = () => {
      lifecycleHandle?.ref();
      return watcher;
    };
    watcher.unref = () => {
      lifecycleHandle?.unref();
      return watcher;
    };
    return watcher;
  }

  function watchFile(
    path: FileSystemPath,
    optionsOrListener?:
      | { readonly interval?: number }
      | ((current: unknown, previous: unknown) => void),
    listener?: (current: unknown, previous: unknown) => void
  ): EventEmitter {
    if (!options.watch) throw nodeFileSystemError('ENOTSUP', 'Filesystem watching is unavailable.');
    const normalized = resolveFileSystemPath(path, options.cwd);
    const callback = typeof optionsOrListener === 'function' ? optionsOrListener : listener;
    let previous = existsSync(normalized) ? options.synchronous.statSync(normalized) : undefined;
    const watcher = new EventEmitter() as EventEmitter & {
      ref(): typeof watcher;
      unref(): typeof watcher;
    };
    const unwatch = watchCommitted(normalized, false, (changedPath) => {
      if (changedPath !== normalized) return;
      const current = existsSync(normalized) ? options.synchronous.statSync(normalized) : previous;
      if (current && previous) callback?.(current, previous);
      if (current && previous) watcher.emit('change', current, previous);
      previous = current;
    });
    let subscription: WatchFileSubscription | undefined;
    let closed = false;
    const cleanup = () => {
      if (closed) return;
      closed = true;
      unwatch();
      if (subscription) removeWatchFileSubscription(normalized, subscription);
    };
    const lifecycleHandle = options.fileWatchLifecycle?.open(cleanup);
    subscription = rememberWatchFile(normalized, callback, () => {
      if (lifecycleHandle) lifecycleHandle.close();
      else cleanup();
    });
    watcher.ref = () => {
      lifecycleHandle?.ref();
      return watcher;
    };
    watcher.unref = () => {
      lifecycleHandle?.unref();
      return watcher;
    };
    return watcher;
  }

  function unwatchFile(
    path: FileSystemPath,
    listener?: (current: unknown, previous: unknown) => void
  ): void {
    const subscriptions = watchFileSubscriptions.get(resolveFileSystemPath(path, options.cwd));
    if (!subscriptions) return;
    for (const subscription of [...subscriptions]) {
      if (listener && subscription.listener !== listener) continue;
      subscription.unwatch();
      removeWatchFileSubscription(resolveFileSystemPath(path, options.cwd), subscription);
    }
  }

  function rememberWatchFile(
    path: string,
    listener: ((current: unknown, previous: unknown) => void) | undefined,
    unwatch: () => void
  ): WatchFileSubscription {
    const subscriptions = watchFileSubscriptions.get(path) ?? new Set();
    const subscription = { listener, unwatch };
    subscriptions.add(subscription);
    watchFileSubscriptions.set(path, subscriptions);
    return subscription;
  }

  function removeWatchFileSubscription(path: string, subscription: WatchFileSubscription): void {
    const subscriptions = watchFileSubscriptions.get(path);
    if (!subscriptions) return;
    subscriptions.delete(subscription);
    if (subscriptions.size === 0) watchFileSubscriptions.delete(path);
  }

  function existsSync(path: string): boolean {
    try {
      options.synchronous.statSync(path);
      return true;
    } catch (error) {
      if (errorCode(error) === 'ENOENT') return false;
      throw error;
    }
  }

  function watchCommitted(
    path: string,
    recursive: boolean,
    listener: (
      changedPath: string,
      event: 'change' | 'rename',
      resync: boolean
    ) => void
  ): () => void {
    const watchId = ++nextWatchId;
    const subscription = { path, recursive, listener };
    committedSubscriptions.set(watchId, subscription);
    const reportRegistration = (
      registration: { readonly registrationRevision: number; readonly cursor: number }
    ): void => {
      options.watchDiagnostics?.({
        kind: 'registered',
        watchId,
        watchedPath: path,
        recursive,
        ...registration
      });
    };
    if (stopCommittedWatch) {
      if (committedRegistration) reportRegistration(committedRegistration);
    } else {
      stopCommittedWatch = options.watch!.watchCommitted(
        (event) => {
          const revision =
            event.kind === 'commit' ? event.revision : event.currentRevision;
          committedRegistration = {
            registrationRevision: revision,
            cursor: revision
          };
          for (const [activeWatchId, active] of [...committedSubscriptions]) {
            deliverCommittedEvent(activeWatchId, active, event);
          }
        },
        {
          onRegistered: (registration) => {
            committedRegistration = registration;
            for (const [activeWatchId, active] of committedSubscriptions) {
              options.watchDiagnostics?.({
                kind: 'registered',
                watchId: activeWatchId,
                watchedPath: active.path,
                recursive: active.recursive,
                ...registration
              });
            }
          }
        }
      );
    }
    return () => {
      committedSubscriptions.delete(watchId);
      if (committedSubscriptions.size > 0) return;
      stopCommittedWatch?.();
      stopCommittedWatch = undefined;
      committedRegistration = undefined;
    };
  }

  function deliverCommittedEvent(
    watchId: number,
    subscription: CommittedWatchSubscription,
    event: VfsCommittedWatchEvent
  ): void {
    const { path, recursive, listener } = subscription;
    if (event.kind === 'resync-required') {
      options.watchDiagnostics?.({
        kind: 'resync-required',
        watchId,
        watchedPath: path,
        recursive,
        currentRevision: event.currentRevision,
        reason: event.reason
      });
      listener(path, 'rename', true);
      return;
    }
    const changes = selectVfsCommittedWatchChanges(
      event.invalidations,
      path,
      recursive
    );
    options.watchDiagnostics?.({
      kind: 'delivered',
      watchId,
      watchedPath: path,
      recursive,
      revision: event.revision,
      invalidations: event.invalidations,
      projectedPaths: changes.map((change) => change.path)
    });
    for (const change of changes) {
      listener(change.path, change.event, false);
    }
  }

  return { unwatchFile, watch, watchFile };
}

function watchedFilename(changedPath: string, watchedPath: string): string {
  if (changedPath === watchedPath) return basename(changedPath);
  if (changedPath.startsWith(`${watchedPath}/`)) return changedPath.slice(watchedPath.length + 1);
  return basename(changedPath);
}

function isNodeFileSystemWatchDiagnosticEvent(
  value: unknown
): value is NodeFileSystemWatchDiagnosticEvent {
  if (
    !isRecord(value) ||
    !Number.isInteger(value.watchId) ||
    typeof value.watchedPath !== 'string' ||
    typeof value.recursive !== 'boolean'
  ) {
    return false;
  }
  if (value.kind === 'registered') {
    return (
      Number.isInteger(value.registrationRevision) &&
      Number.isInteger(value.cursor)
    );
  }
  if (value.kind === 'delivered') {
    return (
      Number.isInteger(value.revision) &&
      Array.isArray(value.invalidations) &&
      value.invalidations.every(isVfsCommitInvalidation) &&
      Array.isArray(value.projectedPaths) &&
      value.projectedPaths.every((path) => typeof path === 'string')
    );
  }
  return (
    value.kind === 'resync-required' &&
    Number.isInteger(value.currentRevision) &&
    (value.reason === 'subscriber-backpressure' ||
      value.reason === 'journal-expired')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

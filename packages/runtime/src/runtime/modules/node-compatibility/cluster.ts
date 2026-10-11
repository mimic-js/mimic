import { EventEmitter } from './events';

/*
 * Limitation: Node's workers share their primary's listening sockets, so
 * every worker can listen on one port. Here each worker is a Runtime Process
 * whose server listens on the Virtual Network by itself, and a second worker
 * listening on a port another one holds gets EADDRINUSE as a server 'error',
 * as a busy port does in Node. Sharing a port would need the Virtual Network
 * to hand one listener to several processes. The primary still hears of each
 * server a worker starts, and emits 'listening' for it, as Node's does.
 */

/** The forked child a cluster worker runs in, as `child_process.fork` returns it. */
export type ClusterChildProcess = EventEmitter & {
  readonly pid?: number;
  readonly connected: boolean;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  send(message: unknown, ...rest: unknown[]): boolean;
  kill(signal?: string): boolean;
  disconnect(): void;
};

/** The calling process, as far as a cluster primary or worker reads it. */
export type ClusterProcess = EventEmitter & {
  readonly env: Record<string, string | undefined>;
  readonly argv: readonly string[];
  readonly execArgv?: readonly string[];
  readonly connected?: boolean;
  send?(message: unknown, ...rest: unknown[]): boolean;
  disconnect?(): void;
  exit?(code?: number): void;
};

/** What a worker tells its primary of a server it listens with, as Node's `'listening'` reports it. */
export type ClusterAddress = Readonly<{
  /** 4 or 6 for a TCP server, -1 for a pipe. */
  addressType: 4 | 6 | -1;
  /** The host the server was asked to listen on, or null for any host; a pipe's path. */
  address: string | null;
  /** -1 for a pipe. */
  port: number;
}>;

/** A server of the worker's process, which `worker.disconnect()` closes. */
export type ClusterListeningServer = EventEmitter & { close(callback?: () => void): unknown };

export type ClusterHost = Readonly<{
  process: ClusterProcess;
  fork(modulePath: string, args: readonly string[], options: Record<string, unknown>): ClusterChildProcess;
  /** Calls `listener` each time a server of this process starts listening. */
  onServerListening?(listener: (server: ClusterListeningServer, address: ClusterAddress) => void): void;
}>;

type ClusterSettings = {
  exec?: string;
  args?: readonly string[];
  execArgv?: readonly string[];
  silent?: boolean;
  stdio?: unknown;
  cwd?: string;
  serialization?: 'json' | 'advanced';
};

/**
 * `cluster`: a primary forks each worker as a Runtime Process through
 * `child_process.fork`, with the IPC channel that carries `worker.send()` and
 * `process.send()`, and `NODE_UNIQUE_ID` naming the worker, as Node does. A
 * process started that way is the worker. Workers share no listening sockets:
 * a server a worker starts listens in that worker's own process (see the
 * limitation above).
 */
export function createClusterBuiltin(host: ClusterHost): unknown {
  const workerId = host.process.env.NODE_UNIQUE_ID;
  const isWorker = workerId !== undefined;
  const settings: ClusterSettings = {};
  const workers: Record<number, ClusterWorker> = {};
  let nextId = 1;
  const cluster = Object.assign(new EventEmitter(), {
    isPrimary: !isWorker,
    isMaster: !isWorker,
    isWorker,
    workers: isWorker ? undefined : workers,
    settings,
    SCHED_NONE: 1,
    SCHED_RR: 2,
    schedulingPolicy: 2
  });

  if (isWorker) {
    const self = host.process;
    // What the worker tells its primary travels as Node's own cluster messages,
    // which the primary's channel emits as `internalMessage`.
    const tellPrimary = (act: string, fields: object = {}, then?: () => void): void => {
      if (self.connected !== true) return;
      self.send?.({ cmd: CLUSTER_MESSAGE, act, ...fields }, then ?? (() => undefined));
    };
    const leave = (): void => tellPrimary('exitedAfterDisconnect', {}, () => self.disconnect?.());
    const servers = new Set<ClusterListeningServer>();
    host.onServerListening?.((server, address) => {
      servers.add(server);
      server.once('close', () => servers.delete(server));
      worker.state = 'listening';
      tellPrimary('listening', address);
    });
    const worker: ClusterWorker = new ClusterWorker(Number(workerId), self as unknown as ClusterChildProcess, {
      send: (message, rest) => self.send?.(message, ...rest) ?? false,
      // As Node's worker, it closes its servers before it leaves the cluster.
      disconnect: () => {
        let waiting = servers.size + 1;
        const closed = (): void => {
          waiting -= 1;
          if (waiting === 0) leave();
        };
        for (const server of [...servers]) server.close(closed);
        servers.clear();
        closed();
      },
      // As Node's worker.destroy(): the worker leaves the cluster and exits with 0.
      kill: () => {
        if (!worker.isConnected()) {
          self.exit?.(0);
          return;
        }
        worker.state = 'destroying';
        self.once('disconnect', () => self.exit?.(0));
        leave();
      }
    }, true);
    self.once('disconnect', () => {
      worker.emit('disconnect');
      // The primary went away without the worker asking to leave.
      if (!worker.exitedAfterDisconnect) self.exit?.(0);
    });
    return Object.assign(cluster, { worker, default: cluster });
  }

  const setupPrimary = (overrides: ClusterSettings = {}) => {
    Object.assign(settings, {
      exec: host.process.argv[1],
      args: host.process.argv.slice(2),
      execArgv: host.process.execArgv ?? [],
      silent: false,
      ...settings,
      ...overrides
    });
    cluster.emit('setup', settings);
  };

  const fork = (env: Record<string, string> = {}): ClusterWorker => {
    if (settings.exec === undefined) setupPrimary();
    const id = nextId++;
    const child = host.fork(settings.exec!, settings.args ?? [], {
      env: { ...host.process.env, ...env, NODE_UNIQUE_ID: String(id) },
      execArgv: settings.execArgv,
      silent: settings.silent,
      ...(settings.stdio === undefined ? {} : { stdio: settings.stdio }),
      ...(settings.cwd === undefined ? {} : { cwd: settings.cwd }),
      ...(settings.serialization === undefined ? {} : { serialization: settings.serialization })
    });
    const worker = new ClusterWorker(id, child, {
      send: (message, rest) => child.send(message, ...rest),
      disconnect: () => child.disconnect(),
      kill: (signal) => {
        worker.exitedAfterDisconnect = false;
        child.kill(signal);
      }
    });
    workers[id] = worker;
    child.on('spawn', () => {
      worker.emit('online');
      cluster.emit('online', worker);
    });
    child.on('message', (message: unknown, handle: unknown) => {
      worker.emit('message', message, handle);
      cluster.emit('message', worker, message, handle);
    });
    child.on('internalMessage', (message: { cmd?: unknown; act?: unknown }) => {
      if (message.cmd !== CLUSTER_MESSAGE) return;
      if (message.act === 'exitedAfterDisconnect') worker.exitedAfterDisconnect = true;
      if (message.act === 'listening') {
        const { addressType, address, port } = message as unknown as ClusterAddress;
        const info = { addressType, address, port };
        worker.state = 'listening';
        worker.emit('listening', info);
        cluster.emit('listening', worker, info);
      }
    });
    child.on('error', (error: unknown) => worker.emit('error', error));
    child.on('disconnect', () => {
      worker.emit('disconnect');
      cluster.emit('disconnect', worker);
    });
    child.on('exit', (code: number | null, signal: string | null) => {
      delete workers[id];
      worker.state = 'dead';
      worker.emit('exit', code, signal);
      cluster.emit('exit', worker, code, signal);
    });
    queueMicrotask(() => cluster.emit('fork', worker));
    return worker;
  };

  Object.assign(cluster, {
    setupPrimary,
    setupMaster: setupPrimary,
    fork,
    disconnect(callback?: () => void) {
      const pending = Object.values(workers);
      if (pending.length === 0) {
        if (callback) queueMicrotask(callback);
        return;
      }
      let remaining = pending.length;
      for (const worker of pending) {
        worker.once('exit', () => {
          remaining -= 1;
          if (remaining === 0) callback?.();
        });
        worker.disconnect();
      }
    }
  });
  return Object.assign(cluster, { default: cluster });
}

/** The `cmd` of the messages a worker's cluster module and its primary's exchange, as in Node. */
const CLUSTER_MESSAGE = 'NODE_CLUSTER';

/** What a worker handle does, which differs between the primary's handle and the worker's own. */
type WorkerChannel = {
  send(message: unknown, rest: unknown[]): boolean;
  disconnect(): void;
  kill(signal: string): void;
};

/** `cluster.Worker`: the primary's handle on a worker, or the worker's own. */
class ClusterWorker extends EventEmitter {
  exitedAfterDisconnect: boolean | undefined = undefined;
  state = 'online';

  constructor(
    readonly id: number,
    readonly process: ClusterChildProcess,
    private readonly channel: WorkerChannel,
    /** In the worker, the process's own messages are the worker's. */
    private readonly relayProcessMessages = false
  ) {
    super();
    if (relayProcessMessages) {
      process.on('message', (message: unknown, handle: unknown) => this.emit('message', message, handle));
    }
  }

  send(message: unknown, ...rest: unknown[]): boolean {
    return this.channel.send(message, rest);
  }

  kill(signal = 'SIGTERM'): void {
    if (this.relayProcessMessages) {
      if (this.isDead()) return;
      this.exitedAfterDisconnect = true;
    }
    this.channel.kill(signal);
  }

  destroy(signal = 'SIGTERM'): void {
    this.kill(signal);
  }

  disconnect(): this {
    if (this.state === 'disconnecting' || this.state === 'destroying') return this;
    this.exitedAfterDisconnect = true;
    this.state = 'disconnecting';
    this.channel.disconnect();
    return this;
  }

  isConnected(): boolean {
    return this.process.connected === true && this.state !== 'dead';
  }

  isDead(): boolean {
    return this.state === 'dead' || this.process.exitCode != null || this.process.signalCode != null;
  }
}

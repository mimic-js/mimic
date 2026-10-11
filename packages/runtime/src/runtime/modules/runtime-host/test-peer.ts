import { connectRpc, type RpcConnection } from '../worker-transport';
import {
  createProcessExecutionClient,
  type ProcessExecutionClient
} from '../process-execution';
import type { RuntimeHostEpoch } from './worker-epoch';
import type {
  RuntimeHostDocumentApi,
  RuntimeHostMainApi,
  RuntimeHostWorkerApi
} from './runtime-host-protocol';

/** A test's one port serves the page's role and the Runtime Host document's. */
export type RuntimeHostTestPeerApi = RuntimeHostMainApi & RuntimeHostDocumentApi;

/**
 * Connects a test's main-thread side to a Runtime Host epoch over a
 * MessageChannel. Notifications a test does not observe are ignored; `local`
 * stays the served object, so a test may assign its members later.
 */
export function connectRuntimeHostTestPeer(
  epoch: Pick<RuntimeHostEpoch, 'connect'>,
  local: Partial<RuntimeHostTestPeerApi> = {}
): RpcConnection<RuntimeHostWorkerApi> {
  const channel = new MessageChannel();
  epoch.connect(channel.port1);
  return connectRuntimeHostTestPort(channel.port2, local);
}

export function connectRuntimeHostTestPort(
  port: MessagePort,
  local: Partial<RuntimeHostTestPeerApi> = {}
): RpcConnection<RuntimeHostWorkerApi> {
  const ignore = (): void => undefined;
  const defaults: Partial<RuntimeHostTestPeerApi> = {
    runtimeHost: { terminated: ignore, closing: ignore },
    endpoints: { lifecycle: ignore },
    processes: {
      output: async () => undefined,
      exit: ignore
    },
    listeners: {
      register: ignore,
      close: async () => undefined,
      abort: ignore
    }
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (!(key in local)) Object.assign(local, { [key]: value });
  }
  const runtimeHost = local.runtimeHost as Partial<RuntimeHostTestPeerApi['runtimeHost']>;
  if (!('closing' in runtimeHost)) runtimeHost.closing = ignore;
  if (!('terminated' in runtimeHost)) runtimeHost.terminated = ignore;
  return connectRpc<RuntimeHostWorkerApi>(port, local);
}

/**
 * Connects a test's main-thread side to a Runtime Host epoch, boots it, and
 * projects its Runtime Processes as the main thread does.
 */
export async function bootRuntimeHostTestPeer(
  epoch: Pick<RuntimeHostEpoch, 'connect'>,
  workdir = '/home/project',
  local: Partial<RuntimeHostTestPeerApi> = {}
): Promise<{
  readonly peer: RpcConnection<RuntimeHostWorkerApi>;
  readonly processes: ProcessExecutionClient;
}> {
  const peer = connectRuntimeHostTestPeer(epoch, local);
  const processes = createProcessExecutionClient(peer.remote.processes);
  Object.assign(local, { processes: processes.events });
  await peer.remote.runtimeHost.boot(workdir);
  return { peer, processes };
}

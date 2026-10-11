import type { ThreadIdentity } from '../process-execution';
import {
  PORT_DELIVERY_SEEN_WORD,
  PORT_NOTIFICATIONS_SENT_WORD,
  type ThreadExecutionPort,
  type ThreadOutputReceivers,
  type ThreadOutputStream,
  type WorkerThreadPorts,
  type WorkerThreadPortSink,
  type WorkerThreadPortsWorkerApi
} from '../node-compatibility';
import {
  transfer,
  type Notify,
  type Remote,
  type SynchronousRemote
} from '../worker-transport';
import type {
  NodeProcessHostApi,
  NodeProcessSynchronousApi,
  NodeProcessWorkerApi
} from './process-worker-protocol';

/**
 * The `worker_threads` transport of one process worker: MessagePort ends that
 * left their thread go through the Runtime Host's relay, and a Worker Thread
 * starts as another process worker the host admits and runs.
 */
export function createProcessWorkerThreads(options: {
  readonly identity: ThreadIdentity;
  readonly host: Remote<NodeProcessHostApi>;
  readonly hostNotify: Notify<NodeProcessHostApi>;
  readonly synchronous: SynchronousRemote<NodeProcessSynchronousApi>;
  /** The status words of this worker's synchronous channel. */
  readonly words: Int32Array;
}): {
  readonly ports: WorkerThreadPorts;
  readonly execution: ThreadExecutionPort;
  /** What the relay delivers to this worker. */
  readonly delivered: WorkerThreadPortsWorkerApi;
  /** The output of the threads this worker started whose Workers read it themselves. */
  readonly output: NodeProcessWorkerApi['threads']['output'];
} {
  const { hostNotify, words } = options;
  const sinks = new Map<string, WorkerThreadPortSink>();
  // Deliveries this worker already took synchronously; their copies are dropped on arrival.
  const takenEarly = new Set<number>();
  const outputReceivers = new Map<number, ThreadOutputReceivers>();
  const outputStreams: readonly ThreadOutputStream[] = ['stdout', 'stderr'];
  let nextPort = 0;

  /** Counts every notification, so a synchronous receive can wait for the ones on their way. */
  const notify = (send: (relay: Notify<NodeProcessHostApi>['ports']) => void): void => {
    Atomics.add(words, PORT_NOTIFICATIONS_SENT_WORD, 1);
    send(hostNotify.ports);
  };

  const ports: WorkerThreadPorts = {
    createId: () => `${options.identity.pid}.${options.identity.threadId}.${++nextPort}`,
    host: (staying, moving, pending) => notify((relay) => relay.open(staying, moving, pending)),
    link(id, sink) {
      sinks.set(id, sink);
      return {
        post: (message, transferables) =>
          notify((relay) => relay.post(id, transfer(message, transferables))),
        receive() {
          const received = options.synchronous.receivePortMessage(id);
          if (!received) return undefined;
          if (received.delivery !== undefined) takenEarly.add(received.delivery);
          return received.message;
        },
        listen: () => notify((relay) => relay.listen(id)),
        unlisten: () => notify((relay) => relay.unlisten(id)),
        release() {
          if (sinks.get(id) === sink) sinks.delete(id);
        },
        close() {
          if (sinks.get(id) === sink) sinks.delete(id);
          notify((relay) => relay.close(id));
        }
      };
    }
  };

  const delivered: WorkerThreadPortsWorkerApi = {
    deliver(id, seq, delivery, message) {
      Atomics.store(words, PORT_DELIVERY_SEEN_WORD, delivery);
      if (takenEarly.delete(delivery)) return;
      const sink = sinks.get(id);
      // The end left this worker after the message was sent here; it goes back.
      if (!sink) notify((relay) => relay.restore(id, seq, message));
      else sink.message(message);
    },
    closed(id) {
      const sink = sinks.get(id);
      sinks.delete(id);
      sink?.close();
    }
  };

  const execution: ThreadExecutionPort = {
    start(request) {
      let referenced = true;
      const { threadId } = request.identity;
      outputReceivers.set(threadId, request.output);
      // Sent at once: the thread starts even if this one blocks right after.
      const exit = options.host.threads
        .start(
          transfer(
            {
              entry: request.entry,
              threadId: request.identity.threadId,
              parentThreadId: request.parent.threadId,
              workerData: request.workerData,
              parentPort: request.parentPort,
              cwd: request.cwd,
              env: request.env,
              argv: request.argv,
              execArgv: request.execArgv,
              capturedOutput: outputStreams.filter((stream) => request.output[stream])
            },
            request.transfer
          )
        )
        .then(
          (code) => {
            outputReceivers.delete(threadId);
            request.reportExit(code);
            return code;
          },
          (error: unknown) => {
            outputReceivers.delete(threadId);
            request.reportFailure(error);
            return 1;
          }
        );
      return {
        async terminate() {
          hostNotify.threads.terminate(request.identity.threadId);
          return exit;
        },
        ref() {
          referenced = true;
        },
        unref() {
          referenced = false;
        },
        hasRef: () => referenced
      };
    }
  };

  return {
    ports,
    execution,
    delivered,
    output: (threadId, stream, data) => outputReceivers.get(threadId)?.[stream]?.(data)
  };
}

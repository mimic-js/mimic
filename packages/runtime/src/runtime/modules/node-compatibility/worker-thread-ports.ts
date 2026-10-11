import type { WorkerThreadMessage } from './worker-threads';

/**
 * The Runtime Host's relay for the MessagePorts of one Runtime Process whose
 * ends are in different threads. Every thread is a process worker; a port end
 * that left the thread it was created in is an entry here, and the messages
 * posted to it wait here, in order, until the thread holding the end takes
 * them. A thread that listens has them delivered by structured clone as they
 * arrive; a thread that calls `receiveMessageOnPort` takes the next one over
 * its synchronous channel, even one already delivered but not yet seen there.
 */

/** Status words of a thread's synchronous channel that the relay reads. */
export const PORT_NOTIFICATIONS_SENT_WORD = 0;
export const PORT_DELIVERY_SEEN_WORD = 1;
export const PROCESS_CHANNEL_WORDS = 2;

/** What a thread's process worker notifies the relay of. */
export interface WorkerThreadPortsHostApi {
  open(staying: string, moving: string, pending: readonly WorkerThreadMessage[]): void;
  post(id: string, message: WorkerThreadMessage): void;
  listen(id: string): void;
  unlisten(id: string): void;
  /** A delivery that reached the thread after the end had left it. */
  restore(id: string, seq: number, message: WorkerThreadMessage): void;
  close(id: string): void;
}

/** What the relay delivers to a thread's process worker. */
export interface WorkerThreadPortsWorkerApi {
  deliver(id: string, seq: number, delivery: number, message: WorkerThreadMessage): void;
  closed(id: string): void;
}

export interface WorkerThreadPortRelayThread extends WorkerThreadPortsWorkerApi {
  /** The thread's synchronous channel words: notifications it sent, the last delivery it took in. */
  readonly words: Int32Array;
}

/** A message taken synchronously; `delivery` names the copy already on its way to the caller. */
export type ReceivedPortMessage = {
  readonly message: WorkerThreadMessage;
  readonly delivery?: number;
};

export interface WorkerThreadPortRelay {
  connect(thread: string, connection: WorkerThreadPortRelayThread): WorkerThreadPortsHostApi;
  /** The next message for `id`, once everything posted before the call has arrived. */
  receive(thread: string, id: string): Promise<ReceivedPortMessage | undefined>;
  disconnect(thread: string): void;
}

type ConnectedThread = {
  readonly name: string;
  readonly connection: WorkerThreadPortRelayThread;
  received: number;
  deliveries: number;
};

type Queued = {
  readonly seq: number;
  readonly message: WorkerThreadMessage;
  deliveredTo?: ConnectedThread;
  delivery?: number;
};

type PortEnd = {
  readonly id: string;
  readonly peer: string;
  /** Messages posted to this end, by seq; delivered ones stay until their thread has taken them in. */
  readonly messages: Queued[];
  /** Seqs another thread took synchronously while their delivery was on its way elsewhere. */
  readonly takenElsewhere: Set<number>;
  listener: ConnectedThread | undefined;
  nextSeq: number;
  /** The other end closed; this one stays only until what was posted to it has been taken. */
  peerClosed: boolean;
};

export function createWorkerThreadPortRelay(): WorkerThreadPortRelay {
  const ends = new Map<string, PortEnd>();
  /** Ends whose other end closed while messages for them were still here. */
  const draining = new Set<PortEnd>();
  const threads = new Map<string, ConnectedThread>();
  let arrivals: Array<() => void> = [];

  const wake = (): void => {
    const waiting = arrivals;
    arrivals = [];
    for (const resolve of waiting) resolve();
  };

  const arrived = (thread: ConnectedThread): void => {
    thread.received += 1;
    for (const end of draining) settle(end);
    wake();
  };

  const register = (id: string, peer: string): PortEnd => {
    const end: PortEnd = {
      id,
      peer,
      messages: [],
      takenElsewhere: new Set(),
      listener: undefined,
      nextSeq: 0,
      peerClosed: false
    };
    ends.set(id, end);
    return end;
  };

  /** Drops the deliveries their thread has taken in; they are no longer here to receive. */
  const prune = (end: PortEnd): void => {
    for (let index = end.messages.length - 1; index >= 0; index -= 1) {
      const { deliveredTo, delivery } = end.messages[index];
      if (!deliveredTo || delivery === undefined) continue;
      if (!threads.has(deliveredTo.name) || delivery <= Atomics.load(deliveredTo.connection.words, PORT_DELIVERY_SEEN_WORD)) {
        end.messages.splice(index, 1);
      }
    }
  };

  const forward = (end: PortEnd): void => {
    const thread = end.listener;
    if (!thread) return;
    prune(end);
    for (const queued of end.messages) {
      if (queued.deliveredTo) continue;
      queued.deliveredTo = thread;
      queued.delivery = ++thread.deliveries;
      thread.connection.deliver(end.id, queued.seq, queued.delivery, queued.message);
    }
  };

  const enqueue = (end: PortEnd, queued: Queued): void => {
    const index = end.messages.findIndex((candidate) => candidate.seq > queued.seq);
    if (index < 0) end.messages.push(queued);
    else end.messages.splice(index, 0, queued);
  };

  /** The ports a message carries leave their threads; whoever restores them listens anew. */
  const moveCarried = (message: WorkerThreadMessage): void => {
    for (const reference of message.references) {
      if (!('port' in reference)) continue;
      const end = ends.get(reference.port);
      if (end) end.listener = undefined;
    }
  };

  /** Drops an end whose other end closed, once none of its messages is left to receive. */
  const settle = (end: PortEnd): void => {
    prune(end);
    if (end.messages.length > 0) {
      draining.add(end);
      return;
    }
    draining.delete(end);
    if (ends.get(end.id) === end) ends.delete(end.id);
  };

  /**
   * Closes `end`. Its other end learns of it after the messages already
   * delivered there, and stays receivable until the ones posted before the
   * close have been taken, as a port does whose peer closed after posting.
   */
  const close = (end: PortEnd, notifyOwnListener: boolean): void => {
    if (ends.get(end.id) !== end) return;
    ends.delete(end.id);
    draining.delete(end);
    if (notifyOwnListener) end.listener?.connection.closed(end.id);
    const peer = ends.get(end.peer);
    if (!peer || peer.peerClosed) return;
    peer.peerClosed = true;
    peer.listener?.connection.closed(peer.id);
    settle(peer);
  };

  return {
    connect(name, connection) {
      const thread: ConnectedThread = { name, connection, received: 0, deliveries: 0 };
      threads.set(name, thread);
      return {
        open(staying, moving, pending) {
          arrived(thread);
          const stayingEnd = register(staying, moving);
          stayingEnd.listener = thread;
          const movingEnd = register(moving, staying);
          for (const message of pending) {
            moveCarried(message);
            movingEnd.messages.push({ seq: ++movingEnd.nextSeq, message });
          }
        },
        post(id, message) {
          arrived(thread);
          moveCarried(message);
          const source = ends.get(id);
          const target = source && ends.get(source.peer);
          if (!target) return;
          enqueue(target, { seq: ++target.nextSeq, message });
          forward(target);
        },
        listen(id) {
          arrived(thread);
          const end = ends.get(id);
          if (!end) return;
          end.listener = thread;
          forward(end);
          if (!end.peerClosed) return;
          thread.connection.closed(id);
          settle(end);
        },
        unlisten(id) {
          arrived(thread);
          const end = ends.get(id);
          if (end?.listener === thread) end.listener = undefined;
        },
        restore(id, seq, message) {
          arrived(thread);
          const end = ends.get(id);
          if (!end || end.takenElsewhere.delete(seq)) return;
          const index = end.messages.findIndex((candidate) => candidate.seq === seq);
          if (index >= 0) end.messages.splice(index, 1);
          enqueue(end, { seq, message });
          forward(end);
        },
        close(id) {
          arrived(thread);
          const end = ends.get(id);
          if (end) close(end, false);
        }
      };
    },
    async receive(name, id) {
      // A message posted before the caller asked may still be on its way here.
      const expected = [...threads.values()].map(
        (thread) => [thread, Atomics.load(thread.connection.words, PORT_NOTIFICATIONS_SENT_WORD)] as const
      );
      while (expected.some(([thread, sent]) => threads.has(thread.name) && thread.received < sent)) {
        await new Promise<void>((resolve) => arrivals.push(resolve));
      }
      const end = ends.get(id);
      if (!end) return undefined;
      prune(end);
      const taken = end.messages.shift();
      if (end.peerClosed) settle(end);
      if (!taken) return undefined;
      if (!taken.deliveredTo) return { message: taken.message };
      if (taken.deliveredTo.name === name) return { message: taken.message, delivery: taken.delivery };
      end.takenElsewhere.add(taken.seq);
      return { message: taken.message };
    },
    disconnect(name) {
      const thread = threads.get(name);
      threads.delete(name);
      // The ends a finished thread listened to close with it.
      for (const end of [...ends.values()]) {
        if (thread && end.listener === thread) close(end, false);
      }
      wake();
    }
  };
}

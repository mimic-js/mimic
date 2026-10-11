/**
 * Unclamped macrotasks. Browsers hold nested `setTimeout(0)` callbacks to a
 * 4 ms floor; a message posted to a MessageChannel runs as its own task with
 * no such floor, in posting order.
 */

type MacrotaskPort = MessagePort & { ref?(): void; unref?(): void };

type Macrotask = { run: (() => void) | undefined };

let channel: MessageChannel | undefined;
const pending: Macrotask[] = [];

function receiver(): MacrotaskPort {
  if (!channel) {
    channel = new MessageChannel();
    channel.port1.onmessage = runNextMacrotask;
    // Node keeps a listening port alive; only queued work may hold the host loop open.
    (channel.port1 as MacrotaskPort).unref?.();
  }
  return channel.port1;
}

function runNextMacrotask(): void {
  const task = pending.shift();
  if (pending.length === 0) (channel?.port1 as MacrotaskPort | undefined)?.unref?.();
  const run = task?.run;
  if (!task || !run) return;
  task.run = undefined;
  run();
}

/** Queues `callback` as its own task and returns a function that cancels it. */
export function queueMacrotask(callback: () => void): () => void {
  const port = receiver();
  const task: Macrotask = { run: callback };
  if (pending.length === 0) port.ref?.();
  pending.push(task);
  channel!.port2.postMessage(undefined);
  return () => {
    task.run = undefined;
  };
}

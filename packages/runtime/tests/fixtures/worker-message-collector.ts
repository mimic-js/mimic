export type WorkerMessage = Record<string, unknown>;

export function collectWorkerMessages(worker: Worker, label: string, timeoutMs = 10_000) {
  const messages: WorkerMessage[] = [];
  worker.addEventListener('message', (event: MessageEvent<unknown>) => {
    if (isRecord(event.data)) messages.push(event.data);
  });
  return {
    messages,
    async waitFor(predicate: (message: WorkerMessage) => boolean): Promise<WorkerMessage> {
      const deadline = performance.now() + timeoutMs;
      while (performance.now() < deadline) {
        const message = messages.find(predicate);
        if (message) return message;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Timed out waiting for ${label}: ${JSON.stringify(messages)}`);
    }
  };
}

function isRecord(value: unknown): value is WorkerMessage {
  return typeof value === 'object' && value !== null;
}

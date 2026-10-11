import type { PublishedEndpointListener } from '../published-endpoint';
import { connectRpc, transfer } from '../worker-transport';
import type { PublishedListenerApi } from './process-worker-protocol';

export interface PublishedListenerConnection {
  readonly server: PublishedEndpointListener;
  /** Ends the connection now: the process that served it is gone. */
  abort(): void;
}

let nextExchangeId = 0;

/**
 * Serves a published listener from the process worker that owns it, over the
 * port that worker opened for it.
 */
export function connectPublishedListener(
  address: { readonly host: string; readonly port: number },
  endpoint: MessagePort
): PublishedListenerConnection {
  const connection = connectRpc<PublishedListenerApi>(endpoint);
  const listener = connection.remote;
  let pending = 0;
  let closing = false;
  // A listener its program closed still answers the exchanges it accepted.
  const track = async <Value>(operation: Promise<Value>): Promise<Value> => {
    pending += 1;
    try {
      return await operation;
    } finally {
      pending -= 1;
      if (closing && pending === 0) connection.close();
    }
  };
  const server: PublishedEndpointListener = {
    address,
    serveHttp(request, options) {
      const exchangeId = `published-exchange-${++nextExchangeId}`;
      const cancel = (): void =>
        connection.notify.cancelHttp(
          exchangeId,
          options.signal?.reason instanceof Error
            ? options.signal.reason.message
            : String(options.signal?.reason ?? 'aborted')
        );
      const response = track(
        listener.serveHttp(
          exchangeId,
          request.body ? transfer(request, [request.body]) : request
        )
      );
      if (options.signal?.aborted) cancel();
      else options.signal?.addEventListener('abort', cancel, { once: true });
      return response.finally(() =>
        options.signal?.removeEventListener('abort', cancel)
      );
    },
    openWebSocket(request, client, options) {
      // The handshake holds the connection open as an exchange does; the
      // socket then lives on its own port.
      return track(listener.openWebSocket(request, transfer(client, [client]), options)).catch(
        () => undefined
      );
    },
    close() {
      if (closing) return;
      closing = true;
      connection.notify.close();
      if (pending === 0) connection.close();
    }
  };
  return {
    server,
    abort: () => connection.close()
  };
}

import { useEffect, useState } from 'react';
import type { Mimic, PublishedEndpoint } from '@mimic-js/runtime';

/** The HTTP servers the container's processes are listening with. */
export function usePublishedEndpoints(container: Mimic): readonly PublishedEndpoint[] {
  const [endpoints, setEndpoints] = useState<readonly PublishedEndpoint[]>([]);
  useEffect(() => {
    const refresh = () => setEndpoints([...container.endpoints.current]);
    refresh();
    const subscriptions = [
      container.endpoints.on('published', refresh),
      container.endpoints.on('unpublished', refresh)
    ];
    return () => subscriptions.forEach((unsubscribe) => unsubscribe());
  }, [container]);
  return endpoints;
}

export function Preview({ endpoints }: { readonly endpoints: readonly PublishedEndpoint[] }) {
  const [selectedUrl, setSelectedUrl] = useState<string>();
  const [reloads, setReloads] = useState(0);
  // The most recently started server, unless another one was picked and still runs.
  const endpoint = endpoints.find((candidate) => candidate.url === selectedUrl) ?? endpoints.at(-1);
  if (!endpoint) return null;

  return (
    <section className="preview" aria-label="Preview">
      <div className="preview-bar">
        <select aria-label="Server" value={endpoint.url} onChange={(event) => setSelectedUrl(event.target.value)}>
          {endpoints.map(({ port, url }) => (
            <option key={url} value={url}>
              localhost:{port}
            </option>
          ))}
        </select>
        <button type="button" onClick={() => setReloads((count) => count + 1)}>
          Reload
        </button>
        <a href={endpoint.url} target="_blank" rel="noreferrer">
          Open in a tab
        </a>
      </div>
      <iframe key={`${endpoint.url}#${reloads}`} title="Preview" src={endpoint.url} />
    </section>
  );
}

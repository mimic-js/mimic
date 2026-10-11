import { useEffect } from 'react';

const DEFAULT_TITLE = 'Mimic';

/**
 * Sets the document's title and description for a page of the site, and
 * restores the defaults of `index.html` when the page unmounts. The social
 * tags stay those of the site: crawlers that render no JavaScript read them.
 */
export function useDocumentMeta(title: string | undefined, description: string | undefined) {
  useEffect(() => {
    if (title === undefined) return;
    const meta = document.querySelector<HTMLMetaElement>('meta[name="description"]');
    const previous = meta?.content;
    document.title = title;
    if (meta && description !== undefined) meta.content = description;
    return () => {
      document.title = DEFAULT_TITLE;
      if (meta && previous !== undefined) meta.content = previous;
    };
  }, [title, description]);
}

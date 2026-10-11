import { useEffect, useMemo, type MouseEvent } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { Marked } from 'marked';
import installation from '../docs/installation.md?raw';
import api from '../docs/api.md?raw';
import { NotFoundPage } from './NotFoundPage';

const pages = {
  installation: { title: 'Installation', source: installation },
  api: { title: 'API reference', source: api }
} as const;

type PageId = keyof typeof pages;

/** Renders the Markdown of the documentation, which is ours, so it is not sanitized. */
function render(source: string): string {
  const marked = new Marked({
    renderer: {
      // Headings get ids, so that a section can be linked to.
      heading({ tokens, depth }) {
        const text = this.parser.parseInline(tokens);
        const id = slug(text.replace(/<[^>]+>/g, ''));
        return `<h${depth} id="${id}"><a class="heading-anchor" href="#${id}">${text}</a></h${depth}>\n`;
      }
    }
  });
  return marked.parse(source, { async: false });
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function DocsPage() {
  const { page } = useParams();
  const known = page !== undefined && page in pages;
  const html = useMemo(() => (known ? render(pages[page as PageId].source) : ''), [known, page]);
  const navigate = useNavigate();
  const { hash } = useLocation();

  useEffect(() => {
    if (!known) return;
    document.title = `${pages[page as PageId].title} · Mimic`;
    return () => {
      document.title = 'Mimic';
    };
  }, [known, page]);

  // A link to a section scrolls to it once the page is rendered.
  useEffect(() => {
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [html, hash]);

  if (!known) return <NotFoundPage />;

  // Links between pages of the site stay in the router.
  const followLink = (event: MouseEvent<HTMLElement>) => {
    const anchor = (event.target as HTMLElement).closest('a');
    const href = anchor?.getAttribute('href');
    if (!href || !href.startsWith('/') || href.startsWith('//')) return;
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(href);
  };

  return (
    <div className="site-main docs-layout">
      <nav className="docs-sidebar" aria-label="Documentation">
        {(Object.keys(pages) as PageId[]).map((id) => (
          <NavLink key={id} to={`/docs/${id}`}>
            {pages[id].title}
          </NavLink>
        ))}
      </nav>
      <article
        className="docs-content"
        onClick={followLink}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

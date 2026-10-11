import { useEffect, useMemo, type MouseEvent } from 'react';
import { NavLink, useLocation, useNavigate, useParams } from 'react-router';
import { Marked } from 'marked';
import installation from '../docs/installation.md?raw';
import api from '../docs/api.md?raw';
import faq from '../docs/faq.md?raw';
import { NotFoundPage } from './NotFoundPage';
import { GITHUB_URL } from './SiteHeader';
import { highlight } from './highlight';
import { useDocumentMeta } from './document-meta';

const pages = {
  installation: {
    title: 'Installation',
    description: 'Install @mimic-js/runtime, send the two headers it needs, and host it in production.',
    source: installation
  },
  api: {
    title: 'API reference',
    description: 'Mimic.boot(), the virtual file system, processes, published endpoints and the Vite plugin.',
    source: api
  },
  faq: {
    title: 'FAQ',
    description: 'What Mimic is, what leaves the browser, networking, untrusted code and the licence.',
    source: faq
  }
} as const;

type PageId = keyof typeof pages;

/** Pages outside the site, listed below the documentation's own. */
const elsewhere = [
  { title: 'Changelog', href: `${GITHUB_URL}/blob/main/packages/runtime/CHANGELOG.md` },
  { title: 'Releases', href: `${GITHUB_URL}/releases` },
  { title: 'npm', href: 'https://www.npmjs.com/package/@mimic-js/runtime' },
  { title: 'Issues', href: `${GITHUB_URL}/issues` }
] as const;

type Heading = { readonly id: string; readonly text: string; readonly depth: 2 | 3 };

type Rendered = { readonly html: string; readonly headings: readonly Heading[] };

/** Renders the Markdown of the documentation, which is ours, so it is not sanitized. */
function render(source: string): Rendered {
  const headings: Heading[] = [];
  const marked = new Marked({
    renderer: {
      // Headings get ids, so that a section can be linked to and listed in the contents.
      heading({ tokens, depth }) {
        const html = this.parser.parseInline(tokens);
        const text = html.replace(/<[^>]+>/g, '');
        const id = slug(text);
        if (depth === 2 || depth === 3) headings.push({ id, text: unescape(text), depth });
        return `<h${depth} id="${id}"><a class="heading-anchor" href="#${id}">${html}</a></h${depth}>\n`;
      },
      // Fenced code blocks are highlighted by their language tag.
      code({ text, lang }) {
        const language = lang?.trim().split(/\s+/)[0];
        const className = language ? ` class="language-${language}"` : '';
        return `<pre><code${className}>${highlight(text, language)}</code></pre>\n`;
      }
    }
  });
  return { html: marked.parse(source, { async: false }), headings };
}

function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/&[a-z]+;|&#\d+;/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The entities marked's inline parser leaves in a heading's text. */
function unescape(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

export function DocsPage() {
  const { page } = useParams();
  const known = page !== undefined && page in pages;
  const current = known ? pages[page as PageId] : undefined;
  const rendered = useMemo(() => (current ? render(current.source) : { html: '', headings: [] }), [current]);
  const navigate = useNavigate();
  const { hash } = useLocation();

  useDocumentMeta(current && `${current.title} · Mimic`, current?.description);

  // A link to a section scrolls to it once the page is rendered.
  useEffect(() => {
    const target = hash && document.getElementById(decodeURIComponent(hash.slice(1)));
    if (target) target.scrollIntoView();
    else window.scrollTo(0, 0);
  }, [rendered, hash]);

  if (!current) return <NotFoundPage />;

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
        <span className="docs-sidebar-heading">Elsewhere</span>
        {elsewhere.map((link) => (
          <a key={link.href} href={link.href} target="_blank" rel="noreferrer">
            {link.title} ↗
          </a>
        ))}
      </nav>
      <article className="docs-content" onClick={followLink} dangerouslySetInnerHTML={{ __html: rendered.html }} />
      {rendered.headings.length > 1 && (
        <nav className="docs-toc" aria-label="On this page">
          <span className="docs-sidebar-heading">On this page</span>
          {rendered.headings.map((heading) => (
            <a key={heading.id} href={`#${heading.id}`} data-depth={heading.depth}>
              {heading.text}
            </a>
          ))}
        </nav>
      )}
    </div>
  );
}

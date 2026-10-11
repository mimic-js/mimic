import { Link, NavLink } from 'react-router';

export const GITHUB_URL = 'https://github.com/mimic-js/mimic';

/**
 * The logo, linking home. `compact` is the mark alone, for the playground's top bar.
 */
export function SiteBrand({ compact = false }: { readonly compact?: boolean }) {
  return compact ? (
    <Link to="/" className="site-mark" aria-label="Mimic home">
      <img src="/mimic-mark.svg" alt="" width={22} height={22} />
    </Link>
  ) : (
    <Link to="/" className="site-brand">
      <img src="/mimic-mark.svg" alt="" width={26} height={26} />
      <span>Mimic</span>
    </Link>
  );
}

/**
 * The site's navigation, in the header of the site and, `compact`, in the
 * playground's top bar. Its links are client-side: leaving the playground
 * unmounts its page, which tears its container down.
 */
export function SiteNav({ compact = false }: { readonly compact?: boolean }) {
  return (
    <nav className={compact ? 'site-nav site-nav-compact' : 'site-nav'} aria-label="Site">
      <NavLink to="/playground">Playground</NavLink>
      <NavLink to="/docs">Docs</NavLink>
      <a href={GITHUB_URL} target="_blank" rel="noreferrer">
        GitHub
      </a>
    </nav>
  );
}

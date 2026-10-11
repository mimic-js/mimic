import type { ReactNode } from 'react';
import { Link, NavLink } from 'react-router';

export const GITHUB_URL = 'https://github.com/mimic-js/mimic';

/**
 * The header of every page: the logo linking home, the page's own content
 * (the playground puts its repository there) and the site's navigation. Its
 * links are client-side: leaving the playground unmounts its page, which
 * tears its container down.
 */
export function SiteHeader({ children }: { readonly children?: ReactNode }) {
  return (
    <header className="site-header">
      <div className="site-header-inner">
        <Link to="/" className="site-brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <span>Mimic</span>
        </Link>
        {children}
        <nav className="site-nav" aria-label="Site">
          <NavLink to="/playground">Playground</NavLink>
          <NavLink to="/docs">Docs</NavLink>
          <a href={GITHUB_URL} target="_blank" rel="noreferrer">
            GitHub
          </a>
        </nav>
      </div>
    </header>
  );
}

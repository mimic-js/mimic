import { Link, NavLink, Outlet } from 'react-router';

export const GITHUB_URL = 'https://github.com/mimic-js/mimic';
export const NPM_URL = 'https://www.npmjs.com/package/@mimic-js/mimic';

/** The header and footer of the landing page, the documentation and the 404 page. */
export function SiteLayout() {
  return (
    <div className="site">
      <header className="site-header">
        <div className="site-header-inner">
          <Link to="/" className="site-brand">
            <img src="/mimic-mark.svg" alt="" width={26} height={26} />
            <span>Mimic</span>
          </Link>
          <nav className="site-nav" aria-label="Site">
            <NavLink to="/playground">Playground</NavLink>
            <NavLink to="/docs">Docs</NavLink>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              GitHub
            </a>
            <a href={NPM_URL} target="_blank" rel="noreferrer">
              npm
            </a>
          </nav>
        </div>
      </header>
      <Outlet />
      <footer className="site-footer">
        <span>MIT licensed.</span>
        <span>
          Not affiliated with StackBlitz. Source on <a href={GITHUB_URL}>GitHub</a>.
        </span>
      </footer>
    </div>
  );
}

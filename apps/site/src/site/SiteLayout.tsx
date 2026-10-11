import { Outlet } from 'react-router';
import { GITHUB_URL, SiteHeader } from './SiteHeader';

/** The header and footer of the landing page, the documentation and the 404 page. */
export function SiteLayout() {
  return (
    <div className="site">
      <SiteHeader />
      <Outlet />
      <footer className="site-footer">
        <span>MIT licensed. Experimental while 0.x.</span>
        <nav className="site-footer-links" aria-label="Elsewhere">
          <a href={GITHUB_URL}>GitHub</a>
          <a href="https://www.npmjs.com/package/@mimic-js/runtime">npm</a>
          <a href={`${GITHUB_URL}/blob/main/packages/runtime/CHANGELOG.md`}>Changelog</a>
          <a href={`${GITHUB_URL}/issues`}>Issues</a>
        </nav>
      </footer>
    </div>
  );
}

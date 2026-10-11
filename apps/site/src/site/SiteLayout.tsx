import { Outlet } from 'react-router';
import { GITHUB_URL, SiteBrand, SiteNav } from './SiteNav';

/** The header and footer of the landing page, the documentation and the 404 page. */
export function SiteLayout() {
  return (
    <div className="site">
      <header className="site-header">
        <div className="site-header-inner">
          <SiteBrand />
          <SiteNav />
        </div>
      </header>
      <Outlet />
      <footer className="site-footer">
        <span>MIT licensed.</span>
        <span>
          Source on <a href={GITHUB_URL}>GitHub</a>.
        </span>
      </footer>
    </div>
  );
}

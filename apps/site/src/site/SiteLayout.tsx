import { Outlet } from 'react-router';
import { GITHUB_URL, SiteHeader } from './SiteHeader';

/** The header and footer of the landing page, the documentation and the 404 page. */
export function SiteLayout() {
  return (
    <div className="site">
      <SiteHeader />
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

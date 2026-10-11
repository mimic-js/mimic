import { Link } from 'react-router';

export function NotFoundPage() {
  return (
    <main className="site-main not-found">
      <p className="not-found-code">404</p>
      <h1>No page here</h1>
      <p>
        Try the <Link to="/">home page</Link>, the <Link to="/docs/installation">documentation</Link> or the{' '}
        <Link to="/playground">playground</Link>.
      </p>
    </main>
  );
}

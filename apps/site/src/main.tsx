import React, { lazy, Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router';
import { DocsPage } from './site/DocsPage';
import { LandingPage } from './site/LandingPage';
import { NotFoundPage } from './site/NotFoundPage';
import { SiteLayout } from './site/SiteLayout';
import './base.css';
import './site/site.css';

// The editor, the terminal and the runtime load only when the playground opens.
const PlaygroundPage = lazy(() => import('./playground/PlaygroundPage'));

function PlaygroundRoute() {
  const { search } = useLocation();
  // Another query is another repository: a new page, after the previous container is torn down.
  return (
    <Suspense fallback={null}>
      <PlaygroundPage key={search} search={search} />
    </Suspense>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/playground" element={<PlaygroundRoute />} />
        <Route element={<SiteLayout />}>
          <Route index element={<LandingPage />} />
          <Route path="docs" element={<Navigate to="/docs/installation" replace />} />
          <Route path="docs/:page" element={<DocsPage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>
);

// A Service Worker an embedding application might already run for its own
// pages: it takes the whole origin and answers one probe path itself.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/consumer-service-worker-probe') {
    event.respondWith(
      new Response('answered by the consumer', {
        headers: { 'content-type': 'text/plain; charset=utf-8' }
      })
    );
  }
});

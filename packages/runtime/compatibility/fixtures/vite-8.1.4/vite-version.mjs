await import('./node_modules/vite/bin/vite.js');
await import('./node_modules/vite/dist/node/cli.js');
await new Promise((resolve) => queueMicrotask(resolve));
process.exit(0);

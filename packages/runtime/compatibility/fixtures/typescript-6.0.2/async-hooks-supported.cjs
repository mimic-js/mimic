const { AsyncLocalStorage, AsyncResource } = require('node:async_hooks');
const storage = new AsyncLocalStorage();
const resource = storage.run('typescript-6', () => new AsyncResource('typescript-6-supported-boundary'));
const store = resource.runInAsyncScope(() => storage.getStore());
console.log(`ASYNC_HOOKS_SYNCHRONOUS_SCOPE_SUPPORTED:${store}:${resource.type}`);

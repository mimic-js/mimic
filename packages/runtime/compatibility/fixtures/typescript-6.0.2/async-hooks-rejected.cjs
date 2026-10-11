const { createHook } = require('node:async_hooks');
// Lifecycle events need promise hooks the browser does not expose: the hook
// enables, and its callbacks are never called.
let calls = 0;
const hook = createHook({ init: () => (calls += 1) }).enable();
setTimeout(() => {
  hook.disable();
  console.log(`ASYNC_HOOKS_CREATE_HOOK_INERT:${calls}`);
}, 0);

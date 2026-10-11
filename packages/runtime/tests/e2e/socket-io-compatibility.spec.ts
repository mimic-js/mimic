import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'socket-io-4-8-4-chat',
  statement:
    'Socket.IO 4.8.4 on Express 5.2.1 connects a page, upgrades it to WebSocket, and broadcasts its messages back',
  target: npmExactGraph('socket-io-4-chat', { 'socket.io': '4.8.4', express: '5.2.1' }, 'npm start')
});

test.use({ fixture: 'socket-io-4-chat' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');

  const app = await server.open('/');
  await expect(app.locator('#status')).toContainText('connected via');
  await app.getByPlaceholder('Message').fill('hello');
  await app.getByRole('button', { name: 'Send' }).click();

  await expect(app.getByRole('listitem')).toContainText(['* guest joined', 'guest: hello']);
  await expect(app.locator('#status')).toHaveText('connected via websocket');
});

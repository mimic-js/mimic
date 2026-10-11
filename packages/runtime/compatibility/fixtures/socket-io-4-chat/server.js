import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const history = [];

app.use(express.static(new URL('./public', import.meta.url).pathname));

io.on('connection', (socket) => {
  socket.emit('history', history);

  socket.on('join', (name) => {
    socket.data.name = name;
    io.emit('system', `${name} joined`);
  });

  socket.on('message', (text, acknowledge) => {
    const message = { from: socket.data.name ?? 'anonymous', text, at: Date.now() };
    history.push(message);
    io.emit('message', message);
    acknowledge?.({ delivered: true });
  });

  socket.on('disconnect', () => {
    if (socket.data.name) io.emit('system', `${socket.data.name} left`);
  });
});

const port = Number(process.env.PORT ?? 3000);
httpServer.listen(port, () => console.log(`chat listening on http://localhost:${port}`));

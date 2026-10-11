import 'dotenv/config';

import compression from 'compression';
import cookieParser from 'cookie-parser';
import express from 'express';
import session from 'express-session';
import helmet from 'helmet';
import morgan from 'morgan';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024 } });
const posts = [{ id: 1, title: 'Hello world', body: 'The first post.', author: 'admin' }];

app.set('view engine', 'ejs');
app.set('views', path.join(root, 'views'));

app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
app.use(compression());
app.use(morgan('tiny'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false
  })
);
app.use(express.static(path.join(root, 'public')));

app.use((request, response, next) => {
  response.locals.user = request.session.user;
  next();
});

app.get('/', (_request, response) => {
  response.render('index', { posts });
});

app.post('/login', (request, response) => {
  request.session.user = request.body.username;
  response.redirect('/');
});

app.post('/posts', (request, response) => {
  if (!request.session.user) return response.status(401).render('error', { message: 'Sign in first' });
  posts.push({ id: posts.length + 1, title: request.body.title, body: request.body.body, author: request.session.user });
  response.redirect('/');
});

app.post('/upload', upload.single('attachment'), (request, response) => {
  response.json({ name: request.file.originalname, size: request.file.size, note: request.body.note });
});

app.use((_request, response) => {
  response.status(404).render('error', { message: 'Page not found' });
});

const port = Number(process.env.PORT);
app.listen(port, () => console.log(`blog listening on http://localhost:${port}`));

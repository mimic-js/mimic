import { createYoga } from 'graphql-yoga';
import { createServer } from 'node:http';

import { schema } from './schema.js';

const yoga = createYoga({ schema });
const server = createServer(yoga);
const port = Number(process.env.PORT ?? 4000);

server.listen(port, () => {
  console.log(`library-graphql listening on http://localhost:${port}${yoga.graphqlEndpoint}`);
});

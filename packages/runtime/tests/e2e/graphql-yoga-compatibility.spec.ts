import { defineCompatibilityClaim } from './compatibility-claim';
import { expect, npmExactGraph, test } from './stack-scenario';

const claim = defineCompatibilityClaim({
  id: 'graphql-yoga-5-24-1-library-api',
  statement: 'GraphQL Yoga 5.24.1 on GraphQL 17.0.2 answers queries with nested resolvers and mutations over HTTP',
  target: npmExactGraph('graphql-yoga-5-library', { graphql: '17.0.2', 'graphql-yoga': '5.24.1' }, 'npm start')
});

test.use({ fixture: 'graphql-yoga-5-library' });

test(claim.statement, async ({ stack }) => {
  await stack.install();
  const server = await stack.start('npm start');
  const query = async (source: string) =>
    JSON.parse((await server.fetch('/graphql', { method: 'POST', json: { query: source } })).body);

  expect(await query('{ books(after: 2000) { title author { name } } }')).toEqual({
    data: {
      books: [{ title: 'Patterns of Enterprise Application Architecture', author: { name: 'Martin Fowler' } }]
    }
  });
  expect(await query('mutation { addBook(title: "DDD", authorId: "2", year: 2003) { id } }')).toEqual({
    data: { addBook: { id: '4' } }
  });
  expect((await query('{ author(id: "2") { books { title } } }')).data.author.books).toHaveLength(3);
  expect((await query('{ nope }')).errors[0].message).toContain('Cannot query field "nope"');
  expect(await server.stop()).toBe(143);
});

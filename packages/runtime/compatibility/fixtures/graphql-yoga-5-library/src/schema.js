import { createSchema } from 'graphql-yoga';

const books = [
  { id: '1', title: 'The Pragmatic Programmer', authorId: '1', year: 1999 },
  { id: '2', title: 'Refactoring', authorId: '2', year: 1999 },
  { id: '3', title: 'Patterns of Enterprise Application Architecture', authorId: '2', year: 2002 }
];
const authors = [
  { id: '1', name: 'Andy Hunt' },
  { id: '2', name: 'Martin Fowler' }
];

export const schema = createSchema({
  typeDefs: /* GraphQL */ `
    type Author {
      id: ID!
      name: String!
      books: [Book!]!
    }

    type Book {
      id: ID!
      title: String!
      year: Int!
      author: Author!
    }

    type Query {
      books(after: Int): [Book!]!
      author(id: ID!): Author
    }

    type Mutation {
      addBook(title: String!, authorId: ID!, year: Int!): Book!
    }
  `,
  resolvers: {
    Query: {
      books: (_parent, { after }) => books.filter((book) => after === undefined || after === null || book.year > after),
      author: (_parent, { id }) => authors.find((author) => author.id === id)
    },
    Mutation: {
      addBook(_parent, input) {
        const book = { id: String(books.length + 1), ...input };
        books.push(book);
        return book;
      }
    },
    Book: {
      author: (book) => authors.find((author) => author.id === book.authorId)
    },
    Author: {
      books: (author) => books.filter((book) => book.authorId === author.id)
    }
  }
});

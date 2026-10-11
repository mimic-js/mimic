import { eq, sql } from 'drizzle-orm';
import express from 'express';

import { db } from './db.js';
import { products } from './schema.js';

const app = express();
app.use(express.json());

app.get('/products', (_request, response) => {
  response.json(db.select().from(products).all());
});

app.post('/products', (request, response) => {
  const [product] = db.insert(products).values(request.body).returning().all();
  response.status(201).json(product);
});

app.post('/products/:id/restock', (request, response) => {
  const [product] = db
    .update(products)
    .set({ stock: sql`${products.stock} + ${request.body.amount}` })
    .where(eq(products.id, Number(request.params.id)))
    .returning()
    .all();
  if (!product) return response.status(404).json({ error: 'product not found' });
  response.json(product);
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`inventory listening on http://localhost:${port}`));

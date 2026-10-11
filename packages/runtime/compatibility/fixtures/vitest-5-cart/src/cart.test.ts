import { beforeEach, describe, expect, it, vi } from 'vitest';

import { Cart, fetchPrice } from './cart';

describe('Cart', () => {
  let cart: Cart;

  beforeEach(() => {
    cart = new Cart();
  });

  it('sums line items', () => {
    cart.add({ sku: 'tea', price: 4, quantity: 2 });
    cart.add({ sku: 'cup', price: 9, quantity: 1 });
    expect(cart.total).toBe(17);
  });

  it('merges quantities of the same item', () => {
    cart.add({ sku: 'tea', price: 4, quantity: 1 });
    cart.add({ sku: 'tea', price: 4, quantity: 2 });
    expect(cart.total).toBe(12);
  });

  it('rejects removing a missing item', () => {
    expect(() => cart.remove('nope')).toThrowError('No item nope in the cart');
  });
});

describe('fetchPrice', () => {
  it('asks the lookup once', async () => {
    const lookup = vi.fn().mockResolvedValue(12);
    await expect(fetchPrice('tea', lookup)).resolves.toBe(12);
    expect(lookup).toHaveBeenCalledExactlyOnceWith('tea');
  });

  it('rejects negative prices', async () => {
    await expect(fetchPrice('tea', async () => -1)).rejects.toBeInstanceOf(RangeError);
  });

  it('matches the snapshot', () => {
    expect({ sku: 'tea', price: 4 }).toMatchInlineSnapshot(`
      {
        "price": 4,
        "sku": "tea",
      }
    `);
  });
});

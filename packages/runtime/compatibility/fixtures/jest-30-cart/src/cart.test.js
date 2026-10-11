const { Cart } = require('./cart');

describe('Cart', () => {
  test('sums line items', () => {
    const cart = new Cart();
    cart.add({ sku: 'tea', price: 4, quantity: 2 });
    cart.add({ sku: 'cup', price: 9, quantity: 1 });
    expect(cart.total).toBe(17);
  });

  test('uses mocks and timers', () => {
    jest.useFakeTimers();
    const callback = jest.fn();
    setTimeout(callback, 1000);
    jest.advanceTimersByTime(1000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});

class Cart {
  constructor() {
    this.items = new Map();
  }

  add(item) {
    const existing = this.items.get(item.sku);
    this.items.set(item.sku, existing ? { ...existing, quantity: existing.quantity + item.quantity } : item);
  }

  get total() {
    return [...this.items.values()].reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}

module.exports = { Cart };

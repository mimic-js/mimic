export interface LineItem {
  sku: string;
  price: number;
  quantity: number;
}

export class Cart {
  private readonly items = new Map<string, LineItem>();

  add(item: LineItem): void {
    const existing = this.items.get(item.sku);
    this.items.set(item.sku, existing ? { ...existing, quantity: existing.quantity + item.quantity } : item);
  }

  remove(sku: string): void {
    if (!this.items.delete(sku)) throw new Error(`No item ${sku} in the cart`);
  }

  get total(): number {
    return [...this.items.values()].reduce((sum, item) => sum + item.price * item.quantity, 0);
  }
}

export async function fetchPrice(sku: string, lookup: (sku: string) => Promise<number>): Promise<number> {
  const price = await lookup(sku);
  if (price < 0) throw new RangeError('price must not be negative');
  return price;
}

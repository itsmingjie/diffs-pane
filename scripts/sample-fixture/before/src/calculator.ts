export type ProductCategory = 'grocery' | 'home' | 'books' | 'other';

export interface LineItem {
  id: string;
  name: string;
  category: ProductCategory;
  price: number;
  taxable?: boolean;
}

export interface CartTotals {
  subtotal: number;
  tax: number;
  total: number;
}

export interface ReceiptOptions {
  heading?: string;
  includeItemIds?: boolean;
}

const TAX_RATES: Record<ProductCategory, number> = {
  grocery: 0,
  home: 0.0825,
  books: 0.04,
  other: 0.0825,
};

export function validateItem(item: LineItem): void {
  if (item.id.trim() === '') {
    throw new Error('Line item id is required');
  }
  if (item.name.trim() === '') {
    throw new Error(`Line item ${item.id} needs a name`);
  }
  if (!Number.isFinite(item.price) || item.price < 0) {
    throw new Error(`Line item ${item.id} has an invalid price`);
  }
}

export function calculateSubtotal(items: LineItem[]): number {
  return roundMoney(items.reduce((sum, item) => sum + item.price, 0));
}

export function calculateTax(items: LineItem[]): number {
  const tax = items.reduce((sum, item) => {
    if (item.taxable === false) return sum;
    return sum + item.price * TAX_RATES[item.category];
  }, 0);
  return roundMoney(tax);
}

export function calculateTotals(items: LineItem[]): CartTotals {
  for (const item of items) validateItem(item);
  const subtotal = calculateSubtotal(items);
  const tax = calculateTax(items);
  return {
    subtotal,
    tax,
    total: roundMoney(subtotal + tax),
  };
}

export function groupByCategory(items: LineItem[]): Map<ProductCategory, LineItem[]> {
  const groups = new Map<ProductCategory, LineItem[]>();
  for (const item of items) {
    const group = groups.get(item.category);
    if (group) group.push(item);
    else groups.set(item.category, [item]);
  }
  return groups;
}

export function sortItems(items: LineItem[]): LineItem[] {
  return [...items].sort(
    (left, right) =>
      left.category.localeCompare(right.category) || left.name.localeCompare(right.name),
  );
}

export function createReceipt(items: LineItem[], options: ReceiptOptions = {}): string {
  const heading = options.heading ?? 'Receipt';
  const sortedItems = sortItems(items);
  const totals = calculateTotals(sortedItems);
  const lines = [heading, '-'.repeat(heading.length)];

  for (const item of sortedItems) {
    const id = options.includeItemIds ? `[${item.id}] ` : '';
    lines.push(`${id}${item.name.padEnd(28)} ${formatLegacyMoney(item.price)}`);
  }

  lines.push('');
  lines.push(`Subtotal${formatLegacyMoney(totals.subtotal).padStart(24)}`);
  lines.push(`Tax${formatLegacyMoney(totals.tax).padStart(29)}`);
  lines.push(`Total${formatLegacyMoney(totals.total).padStart(27)}`);
  return lines.join('\n');
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function formatLegacyMoney(value: number): string {
  return `$${value.toFixed(2)}`;
}

import { formatCurrency, type CurrencyFormatOptions } from './format.js';

export type ProductCategory = 'grocery' | 'home' | 'books' | 'other';

export interface LineItem {
  id: string;
  name: string;
  category: ProductCategory;
  price: number;
  quantity: number;
  taxable?: boolean;
}

export type DiscountRule =
  | { kind: 'fixed'; value: number; label: string }
  | { kind: 'percentage'; value: number; label: string };

export interface CartTotals {
  subtotal: number;
  discount: number;
  taxableSubtotal: number;
  tax: number;
  total: number;
}

export interface ReceiptOptions extends CurrencyFormatOptions {
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
  if (!Number.isSafeInteger(item.quantity) || item.quantity < 1) {
    throw new Error(`Line item ${item.id} has an invalid quantity`);
  }
}

export function calculateSubtotal(items: LineItem[]): number {
  return roundMoney(items.reduce((sum, item) => sum + item.price * item.quantity, 0));
}

export function calculateDiscount(subtotal: number, rule?: DiscountRule): number {
  if (!rule) return 0;
  if (!Number.isFinite(rule.value) || rule.value < 0) {
    throw new Error('Discount value must be a positive number');
  }
  const requested = rule.kind === 'fixed' ? rule.value : subtotal * rule.value;
  return roundMoney(Math.min(requested, subtotal));
}

export function calculateTax(items: LineItem[], discountRatio = 0): number {
  const tax = items.reduce((sum, item) => {
    if (item.taxable === false) return sum;
    const discountedPrice = item.price * item.quantity * (1 - discountRatio);
    return sum + discountedPrice * TAX_RATES[item.category];
  }, 0);
  return roundMoney(tax);
}

export function calculateTotals(items: LineItem[], rule?: DiscountRule): CartTotals {
  for (const item of items) validateItem(item);
  const subtotal = calculateSubtotal(items);
  const discount = calculateDiscount(subtotal, rule);
  const taxableSubtotal = roundMoney(subtotal - discount);
  const discountRatio = subtotal === 0 ? 0 : discount / subtotal;
  const tax = calculateTax(items, discountRatio);
  return {
    subtotal,
    discount,
    taxableSubtotal,
    tax,
    total: roundMoney(taxableSubtotal + tax),
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

export function createReceipt(
  items: LineItem[],
  discount?: DiscountRule,
  options: ReceiptOptions = {},
): string {
  const heading = options.heading ?? 'Receipt';
  const sortedItems = sortItems(items);
  const totals = calculateTotals(sortedItems, discount);
  const lines = [heading, '-'.repeat(heading.length)];

  for (const item of sortedItems) {
    const id = options.includeItemIds ? `[${item.id}] ` : '';
    const description = `${item.quantity} × ${item.name}`;
    const lineTotal = item.price * item.quantity;
    lines.push(`${id}${description.padEnd(28)} ${formatCurrency(lineTotal, options)}`);
  }

  lines.push('');
  lines.push(`Subtotal${formatCurrency(totals.subtotal, options).padStart(24)}`);
  if (discount && totals.discount > 0) {
    lines.push(
      `${discount.label}${formatCurrency(-totals.discount, options).padStart(30 - discount.label.length)}`,
    );
  }
  lines.push(`Tax${formatCurrency(totals.tax, options).padStart(29)}`);
  lines.push(`Total${formatCurrency(totals.total, options).padStart(27)}`);
  return lines.join('\n');
}

function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

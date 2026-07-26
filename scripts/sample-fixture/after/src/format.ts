export interface CurrencyFormatOptions {
  locale?: string;
  currency?: string;
  currencyDisplay?: 'symbol' | 'narrowSymbol' | 'code' | 'name';
}

const formatterCache = new Map<string, Intl.NumberFormat>();

export function formatCurrency(value: number, options: CurrencyFormatOptions = {}): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot format non-finite currency value: ${value}`);
  }
  return getCurrencyFormatter(options).format(value);
}

export function formatAccounting(value: number, options: CurrencyFormatOptions = {}): string {
  const formatter = getCurrencyFormatter(options, true);
  return formatter.format(value);
}

export function formatPercentage(value: number, locale = 'en-US'): string {
  if (!Number.isFinite(value)) {
    throw new Error(`Cannot format non-finite percentage: ${value}`);
  }
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: 2,
  }).format(value);
}

export function clearFormatterCache(): void {
  formatterCache.clear();
}

function getCurrencyFormatter(
  options: CurrencyFormatOptions,
  accounting = false,
): Intl.NumberFormat {
  const locale = options.locale ?? 'en-US';
  const currency = options.currency ?? 'USD';
  const currencyDisplay = options.currencyDisplay ?? 'symbol';
  const key = [locale, currency, currencyDisplay, accounting ? 'accounting' : 'standard'].join(':');
  const cached = formatterCache.get(key);
  if (cached) return cached;

  const formatter = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    currencyDisplay,
    currencySign: accounting ? 'accounting' : 'standard',
  });
  formatterCache.set(key, formatter);
  return formatter;
}

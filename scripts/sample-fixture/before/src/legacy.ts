export interface LegacyReceiptLine {
  label: string;
  value: number;
  emphasize?: boolean;
}

export function formatLegacyTotal(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function formatLegacyLine(line: LegacyReceiptLine): string {
  const label = line.emphasize ? line.label.toUpperCase() : line.label;
  return `${label.padEnd(24)} ${formatLegacyTotal(line.value).padStart(10)}`;
}

export function renderLegacyReceipt(title: string, lines: LegacyReceiptLine[]): string {
  const width = 36;
  const output = [center(title, width), '='.repeat(width)];
  for (const line of lines) {
    output.push(formatLegacyLine(line));
  }
  output.push('='.repeat(width));
  return output.join('\n');
}

export function parseLegacyAmount(input: string): number {
  const normalized = input.replaceAll('$', '').replaceAll(',', '').trim();
  const amount = Number.parseFloat(normalized);
  if (!Number.isFinite(amount)) {
    throw new Error(`Cannot parse legacy amount: ${input}`);
  }
  return amount;
}

function center(value: string, width: number): string {
  if (value.length >= width) return value;
  const remaining = width - value.length;
  const left = Math.floor(remaining / 2);
  const right = remaining - left;
  return `${' '.repeat(left)}${value}${' '.repeat(right)}`;
}

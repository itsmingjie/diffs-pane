# Checkout calculator

A small TypeScript checkout domain used to exercise the diffs-pane development viewer.

## Features

- Models products and line items.
- Calculates a subtotal from item prices.
- Applies category-specific tax rates.
- Produces a plain-text receipt.
- Groups purchased items by category.

## Usage

```ts
import { createReceipt } from './src/calculator.js';

const receipt = createReceipt([
  { id: 'coffee', name: 'Coffee beans', category: 'grocery', price: 18 },
  { id: 'mug', name: 'Stoneware mug', category: 'home', price: 24 },
]);

console.log(receipt);
```

## Data model

Money is represented as a JavaScript number. Each line item contains a product id,
display name, category, unit price, and taxable flag.

## Limitations

The initial version only supports one unit of each item and formats totals with a
legacy dollar formatter. Discounts and locale-aware currency are not supported.

## Development

Run `pnpm run dev:sample` from the diffs-pane repository, then edit files under
`.tmp/sample-repo` to watch the patch refresh over SSE.

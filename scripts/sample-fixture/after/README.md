# Checkout calculator

A small TypeScript checkout domain used to exercise the diffs-pane development viewer.

## Features

- Models products and line items with quantities.
- Calculates subtotal, discount, tax, and grand-total values.
- Applies fixed or percentage discount rules.
- Uses category-specific tax rates.
- Produces a locale-aware, plain-text receipt.
- Groups purchased items by category.

## Usage

```ts
import { createReceipt } from './src/calculator.js';

const receipt = createReceipt(
  [
    { id: 'coffee', name: 'Coffee beans', category: 'grocery', price: 18, quantity: 2 },
    { id: 'mug', name: 'Stoneware mug', category: 'home', price: 24, quantity: 1 },
  ],
  { kind: 'percentage', value: 0.1, label: 'Welcome discount' },
);

console.log(receipt);
```

## Data model

Money is still represented as a JavaScript number for readability in the demo. Each
line item now contains a quantity, and an optional discount rule can be supplied to
the calculator. Production code should use integer minor units or a decimal library.

## Currency formatting

Receipt values use `Intl.NumberFormat`. Callers can select a locale and ISO currency;
the sample defaults to `en-US` and `USD` so its output stays deterministic.

## Development

Run `pnpm run dev:sample` from the diffs-pane repository, then edit files under
`.tmp/sample-repo` to watch multiple hunks refresh over SSE. Rerun the command at any
time to restore this fixture.

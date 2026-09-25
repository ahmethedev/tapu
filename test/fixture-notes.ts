import { readFile, writeFile } from 'node:fs/promises';
import { pagePath, setFrontmatter } from './helpers.js';

// Reviewed example notes for the fixture: they distinguish the immutable
// checkout email (orders.customer_email) from the mutable account email
// (customers.email). Used by the enriched tests and by scripts/token-compare.ts.

export const ORDERS_FRONTMATTER = `tapu: 1
table: public.orders
purpose: "Completed and in-progress purchases."
owner: commerce
tags: [checkout]
columns:
  customer_email:
    note: "Checkout email snapshot; do not backfill from the customer profile."
    sensitive: true`;

export const ORDERS_NOTES = `### 2026-09-25 — Keep the checkout email

- Decision: orders.customer_email is an immutable checkout snapshot.
- Reason: historical receipts must retain the address used for the purchase.
- Consequence: customer profile updates must not backfill this field.
- Reference: PR #123
`;

export const CUSTOMERS_FRONTMATTER = `tapu: 1
table: public.customers
purpose: "People with a shop account."
owner: identity
tags: [pii]
columns:
  email:
    note: "Current login email; customers can change it. Changes never propagate to orders.customer_email."`;

export const RULES = `# Project database conventions

## Naming

- Tables are plural snake_case.

## Migrations

- Every foreign key gets a supporting index in the same migration.

## Data handling

- Snapshot columns (for example orders.customer_email) are never backfilled.
`;

async function appendNotes(root: string, file: string, notes: string): Promise<void> {
  const path = pagePath(root, file);
  const text = await readFile(path, 'utf8');
  await writeFile(path, text.replace(/## Notes\n$/, `## Notes\n\n${notes}`));
}

/** Applies the reviewed example notes to pages created by init. */
export async function applyExampleNotes(root: string): Promise<void> {
  await setFrontmatter(root, 'public.orders.md', ORDERS_FRONTMATTER);
  await appendNotes(root, 'public.orders.md', ORDERS_NOTES);
  await setFrontmatter(root, 'public.customers.md', CUSTOMERS_FRONTMATTER);
  await writeFile(`${root}/db-wiki/rules.md`, RULES);
}

# Task set

Defined before any run. Each task starts from `test/fixture.sql` loaded into a fresh database, with the repository reset. "Pass" requires every rubric item; record partial credit separately.

## Suite 1: metadata only (no human notes)

Run right after `tapu init`, with every `purpose`, `owner`, note and `rules.md` section empty.

### M1. Find the relevant objects among unrelated ones

Setup: also create 500 generated tables (`createBulkSchema(500)`, schema `bulk`) and run `tapu init --schemas public,bulk`.

Prompt: "Which tables and columns store a customer's email address, and how are they related?"

Rubric:
- Names `public.customers.email` and `public.orders.customer_email`.
- States that `orders.customer_id` references `customers.id`.
- Does not list unrelated `bulk.*` tables.

### M2. Add a feature without duplicating a field

Prompt: "Add support for marking a customer's preferred contact channel. Write the migration."

Rubric:
- Recognizes the existing `customers.preferred_channels public.contact_channel[]` column and the `public.contact_channel` enum; proposes no duplicate column or enum.
- If it changes anything, the migration is valid for the captured schema.

### M3. Change a field while respecting constraints and relations

Prompt: "Change `order_items.quantity` to allow fractional quantities. Write the migration."

Rubric:
- Keeps or adapts the `order_items_quantity_positive` check.
- Accounts for `public.order_totals` depending on `quantity` (view definition) and for the composite key referenced by `public.returns`.
- Migration is valid PostgreSQL for the captured schema.

### M4. Multi-table context without serial discovery

Prompt: "Write a query returning each return with its order's status, the product SKU and the customer's full name."

Rubric:
- Correct joins through the composite FK `returns (order_id, product_id) → order_items`, then `orders`, `products`, `customers`.
- Uses existing column names only.
- Efficiency note: count the context-retrieval calls made before the query was written.

### M5. Changed enum or view without trusting a stale snapshot

Setup: after `tapu init`, run `ALTER TYPE public.order_status ADD VALUE 'refunded'` without refreshing Tapu.

Prompt: "Write a query counting orders by every possible status, including statuses with zero orders."

Rubric:
- Includes `refunded`, or explicitly verifies live state (for example `tapu status` or a live query) before relying on the snapshot's enum values.
- Does not present the snapshot as verified live state.

## Suite 2: enriched (reviewed example notes applied)

Apply `applyExampleNotes` (checkout-email notes on `public.orders` and `public.customers`, conventions in `rules.md`) before the run.

### E1. Choose between similarly named fields

Prompt: "Receipts must show the email address used at checkout. Which column should the receipt service read?"

Rubric:
- Chooses `orders.customer_email`, not `customers.email`, and cites the snapshot semantics.

### E2. Preserve the checkout-email rule when changing profile behavior

Prompt: "When a customer changes their email, update it everywhere it is stored. Implement it."

Rubric:
- Updates `customers.email` only; does not backfill `orders.customer_email`.
- Explains why, citing the recorded rule, or asks before touching order history.
- Any new foreign key comes with a supporting index (the recorded migration convention).

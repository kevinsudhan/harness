# The module catalogue

Business software is the same few dozen pieces arranged differently. This catalogue is
those pieces, each written once and generic from the start: a module declares its tables
(with names that never change), its stages, its actions — what each does, what it touches,
who must approve it and above what figure — and its settings. Nothing in a module is code;
the engine in `src/modules/engine.ts` runs every one of them on the same kernel as the
freight desk (`domain/machine.ts`, `domain/policy.ts`).

A business is a **composition**: a short config that picks modules and adapts them.

```
"a dental clinic in Chennai"  →  model writes config.json  →  compose()  →  app.json  →  a running app
                                  (draft.ts)                   (checks everything)          (engine.ts)
```

## What a model (or a person) can change

Per module, in `config.json`:

| Change | Example |
| --- | --- |
| Relabel the module, a table, a field, a stage, an action | contacts → **Patients**; invoice → **Bill**; `checked_in` → **In the chair** |
| Drop optional fields | a gym drops `address` |
| Add fields | a clinic adds `allergies` (longtext, personal data) |
| Replace a choice's options | a gym's `source`: walk-in, instagram, referral… |
| Turn an action off | a business that never sends payment links |
| Change who approves, and above what | a clinic holds invoices at ₹25,000 for finance |
| Set the module's settings | payment terms 0 days; reminders 24 hours before |
| **Pipeline only:** write its own stages and actions | consultation → treatment plan → in treatment → review |

What it **cannot** change is any identifier: a table, a field, an action name. That is the
point. The engine can rely on `balance_due`, an agent's tools are the same names in every
business, and an approval policy written against `issue_invoice` means the same thing
everywhere. Composing refuses — by name — a config that breaks anything: a formula naming a
field that does not exist, a stage nothing reaches, an action moving somewhere its stage
does not lead, a custom action that creates a row without its required fields.

## What modules do without code

- **Formulas** (`formula.ts`) — `total = subtotal - discount_amount + tax_amount`;
  `amount_paid = sum(payment.amount, state = 'received')`; `seats_left = capacity - seats_taken`.
  Recomputed on every write, up through whatever a record points at.
- **Automatic moves** — an invoice becomes *paid* when its balance reaches zero, *overdue*
  when its due date passes; a membership *expires*; a deadline turns *at risk*, then *missed*.
- **Guards** — refuse with a reason: no lines on an invoice, no seats left in a class, not
  enough stock, a message to someone who opted out, approving your own time.
- **Creates** — an accepted quote becomes an invoice line for line; recording a payment
  makes a payment row; a clinic's "book next visit" makes an appointment.
- **No double-booking** — two live appointments on one chair are refused.
- **Approvals** — held actions wait for a person who is not the requester; once the team
  list names approvers, the approver must hold the role (finance, compliance, desk, or owner).

## The modules

### Core

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Contacts** `contacts` | The people the business serves — customers, patients, clients, members, students, owners — and how to reach them. | `contact` | — | Export personal data (compliance), Erase personal data (compliance) |
| **Organisations** `accounts` | Companies the business sells to, with their credit limit and payment terms — for business-to-business work. | `account` | — | Set credit limit (finance ≥ 1,00,000), Release credit hold (finance) |
| **Pipeline** `pipeline` | The business's own work — a shipment, matter, treatment course, event order or placement — moving through stages the business defines, with its own actions and approvals. | `work_item` | work_item: open, in_progress, completed, cancelled | — |

### Selling

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Enquiries** `enquiries` | Incoming enquiries and leads from every channel — answered, followed up, qualified, and converted into work or marked lost. | `enquiry` | enquiry: new, contacted, qualified, converted, lost | — |
| **Services & products** `catalogue` | The price list: services, products, packages and fees, with tax and how long a service takes to book. | `catalogue_item` | — | Change price (desk) |
| **Quotes** `quotes` | Estimates and proposals with priced lines and a discount brake, sent, accepted or declined, and turned into an invoice. | `quote`, `quote_line` | quote: draft, sent, accepted, invoiced, declined, expired | Send quote (desk > 10%) |
| **Agreements** `agreements` | Contracts, leases, engagement letters and offers — drafted, sent for signature, active until they expire, renewed or terminated. | `agreement` | agreement: draft, sent, signed, active, declined, expired, terminated | Send for signature (desk ≥ 1,00,000), Terminate (desk) |
| **Memberships** `memberships` | Plans and the customers on them — trial, active, paused, expired — with session credits, renewals and cancellations. | `plan`, `membership` | membership: trial, active, paused, expired, cancelled | Cancel (desk) |
| **Listings** `listings` | Things on offer — properties for sale or rent, job openings, vehicles — published, under offer, closed or withdrawn. | `listing` | listing: draft, published, under_offer, closed, withdrawn | Change price (desk) |

### Money

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Invoices** `invoicing` | Invoices with priced lines and tax that track their own balance — issued over an approval threshold, chased when overdue, voided or written off only with finance. | `invoice`, `invoice_line` | invoice: draft, issued, part_paid, overdue, paid, void, written_off | Issue invoice (finance ≥ 50,000), Void (finance), Write off balance (finance) |
| **Payments** `payments` | Payment links, payments received against invoices, and refunds — links over a threshold need finance, every refund does. | `payment` | payment: pending, received, failed, cancelled, refunded | Send payment link (finance ≥ 50,000), Refund (finance) |
| **Claims** `claims` | Insurance and third-party claims — drafted, submitted with approval, approved, part-approved or rejected, appealed and settled. | `claim` | claim: draft, submitted, under_review, approved, partially_approved, rejected, appealed, settled | Submit (finance), Appeal (compliance) |
| **Timesheets** `timesheets` | Time worked on each piece of work, submitted, approved by someone else, and marked billed. | `time_entry` | time_entry: draft, submitted, approved, rejected, billed | — |

### Operations

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Appointments** `appointments` | One-to-one bookings against staff, rooms, chairs or bays — confirmed, reminded, checked in, completed — with no double-booking. | `resource`, `appointment` | appointment: requested, confirmed, checked_in, completed, no_show, cancelled | — |
| **Classes & sessions** `capacity` | Sessions with limited seats — classes, batches, sailings, tours, workshops — and the reservations against them, with waitlists when full. | `session`, `reservation` | session: open, closed, completed, cancelled<br>reservation: requested, confirmed, waitlisted, attended, no_show, cancelled | Cancel session (desk) |
| **Tasks** `tasks` | Internal to-dos assigned to staff with due dates — callbacks, chasers, preparation — linked to the customer or work they are for. | `task` | task: open, in_progress, done, cancelled | — |
| **Documents** `documents` | Documents requested from customers, received, verified or rejected, tracked to expiry — and shared out only with compliance approval. | `document` | document: requested, received, verified, rejected, expired, archived | Share (compliance) |
| **Assets** `assets` | The things customers bring to be serviced — pets, vehicles, devices, appliances, properties — with owner, identifiers and service history. | `asset` | asset: active, retired | — |
| **Inventory** `inventory` | Stock on hand counted from every movement in and out — received, used, adjusted — with reorder levels. | `stock_item`, `stock_movement` | — | Adjust count (desk) |
| **Suppliers & purchasing** `procurement` | Suppliers and purchase orders with priced lines — sent over a finance threshold, confirmed, received, billed and paid. | `supplier`, `purchase_order`, `purchase_order_line` | purchase_order: draft, sent, confirmed, received, billed, paid, cancelled | Send to supplier (finance ≥ 25,000), Pay supplier (finance) |

### People

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Team** `staff` | Staff members, their roles and skills, who may approve what, and leave — the people other modules assign work to. | `staff_member` | staff_member: active, on_leave, left | Set approver role (compliance), Offboard (desk) |

### Conversations

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Messages** `messaging` | SMS, WhatsApp and email to and from customers, reusable templates, and campaigns to many people at once — never to anyone who opted out. | `message`, `message_template`, `campaign` | message: draft, sent, delivered, failed, received<br>campaign: draft, scheduled, sent, cancelled | Schedule (desk) |
| **Calls** `calls` | Every phone call — taken by staff or a voice agent — with summary, transcript and outcome, turned into callbacks and enquiries. | `call` | — | — |
| **Feedback** `feedback` | Ratings and reviews requested after service, escalated when bad, and answered — a public reply waits for a person. | `feedback` | feedback: requested, received, escalated, responded | Respond (desk) |

### Controls

| Module | What it gives a business | Tables | Stages | Waits for a person |
| --- | --- | --- | --- | --- |
| **Commitments** `commitments` | Promises and deadlines with an owner — they turn at-risk and missed on their own, and close only with evidence. | `commitment` | commitment: open, at_risk, fulfilled, missed, waived | Waive (desk) |
| **Consent** `consent` | Consent records per customer and purpose — treatment, marketing, photographs, data sharing — granted, withdrawn or expired. | `consent_record` | consent_record: granted, withdrawn, expired | — |

26 modules, 36 tables, 131 actions.

## Example compositions

`src/modules/examples/` holds four businesses composed from this catalogue — the shape a
model's answer takes:

| Business | Modules | The board | Its own stages |
| --- | --- | --- | --- |
| Dental clinic | 12 | treatment courses | consultation → treatment plan → in treatment → review → completed |
| MMA gym | 10 | memberships | — (runs on the memberships module's stages) |
| Law firm | 12 | matters | intake → conflict check → engagement → active → closing → closed |
| Salon | 10 | bookings | — (runs on the appointments module's stages) |

## Using it

```bash
npm run compose -- --catalogue                          # list the modules
npm run compose -- "a physiotherapy clinic in Pune"     # a model drafts the config (needs KILO_API_KEY)
npm run compose -- --example dental-clinic              # compose an example
npm run compose -- --config builds/<build>/config.json  # recompose after editing a config
npm run app -- <build>                                  # run it
```

## Adding a module

Write one file in `src/modules/catalog/` with `defineModule()`, add it to
`catalog/index.ts`, and run `npx tsx src/modules/modules.test.ts`. The test composes the
new module with every other one and fails on anything that does not resolve. Rules:

- Entity and action names are unique across the whole catalogue — an action name is a tool name.
- A required link points into the module itself or a module it `requires`.
- Mark a field `core` when the module's own logic depends on it, so no business can drop it.
- Give every lifecycle an ending, and every action with `to` a `when` whose stages lead there.
- Default to `auto`; hold what moves money, reaches many people at once, or cannot be undone.

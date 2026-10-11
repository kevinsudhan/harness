import { defineModule, AUTO, approve, amountAtOrAbove } from "../types.js";

/**
 * Money in, and occasionally back out. Two of its actions are taken on an invoice rather
 * than on a payment — asking for money and recording money that came in — because that is
 * where the desk is when it does them. Both create a payment row, and the invoice settles
 * itself from those rows.
 *
 * Nothing here talks to a payment provider. A link is a sandbox:// address until a real
 * provider is wired in, on purpose: a generated build must never be able to take money.
 */
export const payments = defineModule({
  id: "payments",
  label: "Payments",
  category: "finance",
  icon: "Wallet",
  summary: "Payment links, payments received against invoices, and refunds — links over a threshold need finance, every refund does.",
  usedBy: ["every business that takes money"],
  requires: ["contacts", "invoicing"],
  entities: [
    {
      name: "payment",
      label: "Payments",
      singular: "Payment",
      purpose: "one amount of money asked for, received or refunded",
      title: "reference",
      fields: [
        { name: "invoice_id", type: "ref", ref: "invoice", label: "Invoice" },
        { name: "contact_id", type: "ref", ref: "contact", label: "Customer", required: true, core: true },
        { name: "amount", type: "money", required: true, core: true },
        { name: "method", type: "choice", options: ["cash", "card", "upi", "bank_transfer", "cheque", "payment_link", "other"] },
        { name: "reference", type: "text", help: "the receipt number or the provider's transaction id" },
        { name: "link_url", type: "url", label: "Payment link" },
        { name: "received_at", type: "datetime" },
        { name: "failure_reason", type: "text" },
        { name: "refund_reason", type: "text" },
        { name: "notes", type: "longtext" },
      ],
      lifecycle: {
        order: ["pending", "received", "failed", "cancelled", "refunded"],
        initial: "pending",
        states: {
          pending: { label: "Pending", next: ["received", "failed", "cancelled"] },
          received: { label: "Received", next: ["refunded"] },
          failed: { label: "Failed", next: [] },
          cancelled: { label: "Cancelled", next: [] },
          refunded: { label: "Refunded", next: [] },
        },
      },
    },
  ],
  actions: [
    {
      name: "issue_payment_link",
      label: "Send payment link",
      entity: "invoice",
      summary: "Send the customer a link to pay the invoice — the full balance unless an amount is given.",
      effects: ["outbound", "money"],
      policy: amountAtOrAbove(50_000, "finance"),
      measure: { amount: "coalesce(param.amount, balance_due)" },
      when: ["issued", "part_paid", "overdue"],
      params: [{ name: "amount", type: "money", help: "leave blank for the full balance" }],
      guard: { if: "coalesce(param.amount, balance_due) > 0", else: "there is nothing to pay on this invoice" },
      creates: {
        entity: "payment",
        fields: {
          invoice_id: "=id()",
          contact_id: "=contact_id",
          amount: "=coalesce(param.amount, balance_due)",
          method: "payment_link",
          link_url: "='sandbox://pay/' + id() + '/' + now()",
        },
      },
    },
    {
      name: "record_payment",
      label: "Record payment",
      entity: "invoice",
      summary: "Record money received against the invoice.",
      effects: ["money", "record"],
      policy: AUTO,
      when: ["issued", "part_paid", "overdue"],
      params: [
        { name: "amount", type: "money", required: true },
        { name: "method", type: "choice", required: true, options: ["cash", "card", "upi", "bank_transfer", "cheque", "other"] },
        { name: "reference", type: "text" },
      ],
      guard: { if: "param.amount > 0 and param.amount <= balance_due", else: "the amount must be more than zero and no more than the balance due" },
      creates: {
        entity: "payment",
        state: "received",
        fields: {
          invoice_id: "=id()",
          contact_id: "=contact_id",
          amount: "=param.amount",
          method: "=param.method",
          reference: "=param.reference",
          received_at: "=now()",
        },
      },
    },
    {
      name: "confirm_payment",
      label: "Confirm received",
      entity: "payment",
      summary: "Confirm that a pending payment arrived.",
      effects: ["money", "record"],
      policy: AUTO,
      when: ["pending"],
      to: "received",
      params: [{ name: "reference", type: "text" }],
      sets: { received_at: "=now()", reference: "=coalesce(param.reference, reference)" },
    },
    {
      name: "mark_payment_failed",
      label: "Mark failed",
      entity: "payment",
      summary: "Record that a pending payment did not go through.",
      effects: ["record"],
      policy: AUTO,
      when: ["pending"],
      to: "failed",
      params: [{ name: "reason", type: "text" }],
      sets: { failure_reason: "=param.reason" },
    },
    {
      name: "cancel_payment_request",
      label: "Cancel request",
      entity: "payment",
      summary: "Withdraw a payment link that has not been paid.",
      effects: ["record"],
      policy: AUTO,
      when: ["pending"],
      to: "cancelled",
    },
    {
      name: "refund_payment",
      label: "Refund",
      entity: "payment",
      summary: "Send a received payment back to the customer.",
      effects: ["money", "outbound", "destructive"],
      policy: approve("finance", "a refund sends money back out"),
      measure: { amount: "amount" },
      when: ["received"],
      to: "refunded",
      params: [{ name: "reason", type: "text", required: true }],
      sets: { refund_reason: "=param.reason" },
    },
  ],
  settings: [],
});

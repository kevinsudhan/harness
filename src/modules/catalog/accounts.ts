import { defineModule, AUTO, approve, amountAtOrAbove } from "../types.js";

/**
 * Organisations, for a business that sells to companies: a freight forwarder's shippers,
 * a recruiter's hiring clients, an agency's retainers. Credit is the reason it is a module
 * of its own — how much a company may owe is a finance decision, and holding it is not.
 */
export const accounts = defineModule({
  id: "accounts",
  label: "Organisations",
  category: "core",
  icon: "Building2",
  summary: "Companies the business sells to, with their credit limit and payment terms — for business-to-business work.",
  usedBy: ["freight forwarder", "recruitment agency", "marketing agency", "wholesale distributor", "IT services"],
  requires: ["contacts"],
  entities: [
    {
      name: "account",
      label: "Organisations",
      singular: "Organisation",
      purpose: "one company the business deals with",
      title: "name",
      fields: [
        { name: "name", type: "text", required: true, core: true },
        { name: "industry", type: "text" },
        { name: "tax_id", type: "text", label: "Tax / GST number" },
        { name: "phone", type: "phone" },
        { name: "email", type: "email" },
        { name: "website", type: "url" },
        { name: "billing_address", type: "longtext" },
        { name: "credit_limit", type: "money" },
        { name: "payment_terms_days", type: "integer", help: "days they have to pay an invoice" },
        { name: "credit_hold", type: "boolean", core: true, help: "no new work or credit until released" },
        { name: "notes", type: "longtext" },
      ],
    },
  ],
  actions: [
    {
      name: "set_credit_limit",
      label: "Set credit limit",
      entity: "account",
      summary: "Change how much this organisation may owe at once.",
      effects: ["money"],
      policy: amountAtOrAbove(100_000, "finance"),
      params: [{ name: "amount", type: "money", required: true, label: "New limit" }],
      measure: { amount: "param.amount" },
      sets: { credit_limit: "=param.amount" },
    },
    {
      name: "place_credit_hold",
      label: "Place on credit hold",
      entity: "account",
      summary: "Stop new credit for this organisation until finance releases it.",
      effects: ["record"],
      policy: AUTO,
      params: [{ name: "reason", type: "text", required: true }],
      sets: { credit_hold: true },
    },
    {
      name: "release_credit_hold",
      label: "Release credit hold",
      entity: "account",
      summary: "Allow credit for this organisation again.",
      effects: ["money"],
      policy: approve("finance", "releasing a hold extends credit again"),
      sets: { credit_hold: false },
    },
  ],
  settings: [],
});

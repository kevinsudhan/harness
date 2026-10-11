import { defineModule, AUTO, approve } from "../types.js";

/**
 * What the business sells and for how much — services, products, packages, fees. Quotes,
 * invoices and bookings pick from it, so a price lives in one place and a change to it is
 * one decision rather than a hunt through old quotes.
 */
export const catalogue = defineModule({
  id: "catalogue",
  label: "Services & products",
  category: "sales",
  icon: "Tags",
  summary: "The price list: services, products, packages and fees, with tax and how long a service takes to book.",
  usedBy: ["salon", "dental clinic", "repair shop", "caterer", "veterinary clinic", "spa", "car service centre"],
  requires: [],
  entities: [
    {
      name: "catalogue_item",
      label: "Services & products",
      singular: "Item",
      purpose: "one thing the business sells, at its list price",
      title: "name",
      fields: [
        { name: "name", type: "text", required: true, core: true },
        { name: "kind", type: "choice", options: ["service", "product", "package", "fee"] },
        { name: "code", type: "text", help: "an internal or tax code" },
        { name: "description", type: "longtext" },
        { name: "unit", type: "choice", options: ["each", "hour", "session", "day", "month", "kg", "litre"] },
        { name: "price", type: "money", required: true, core: true },
        { name: "tax_rate", type: "percent" },
        { name: "duration_minutes", type: "integer", help: "how long the service takes, for booking" },
        { name: "active", type: "boolean", core: true },
      ],
    },
  ],
  actions: [
    {
      name: "change_price",
      label: "Change price",
      entity: "catalogue_item",
      summary: "Set a new list price for this item.",
      effects: ["money"],
      policy: approve("desk", "a price change reaches every future quote and invoice"),
      params: [{ name: "amount", type: "money", required: true, label: "New price" }],
      sets: { price: "=param.amount" },
    },
    {
      name: "retire_item",
      label: "Retire",
      entity: "catalogue_item",
      summary: "Stop offering this item; past quotes and invoices keep it.",
      effects: ["record"],
      policy: AUTO,
      sets: { active: false },
    },
    {
      name: "restore_item",
      label: "Offer again",
      entity: "catalogue_item",
      summary: "Start offering a retired item again.",
      effects: ["record"],
      policy: AUTO,
      sets: { active: true },
    },
  ],
  settings: [],
});

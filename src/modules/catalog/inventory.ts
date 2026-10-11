import { defineModule, approve, AUTO } from "../types.js";

/**
 * Stock. The quantity on hand is never a number someone types: it is the sum of every
 * movement in and out, so a count that looks wrong can always be explained by reading the
 * movements. A manual correction is a movement too, and it waits for a person.
 */
export const inventory = defineModule({
  id: "inventory",
  label: "Inventory",
  category: "operations",
  icon: "Boxes",
  summary: "Stock on hand counted from every movement in and out — received, used, adjusted — with reorder levels.",
  usedBy: ["salon products", "repair shop spares", "caterer ingredients", "veterinary medicines", "dental supplies", "retail counter"],
  requires: [],
  entities: [
    {
      name: "stock_item",
      label: "Stock",
      singular: "Stock item",
      purpose: "one thing the business keeps a quantity of",
      title: "name",
      fields: [
        { name: "name", type: "text", required: true, core: true },
        { name: "sku", type: "text", label: "SKU" },
        { name: "unit", type: "choice", options: ["each", "box", "pack", "kg", "g", "litre", "ml"] },
        { name: "on_hand", type: "number", formula: "sum(stock_movement.quantity)", core: true },
        { name: "reorder_level", type: "number", core: true },
        { name: "cost_price", type: "money" },
        { name: "supplier_id", type: "ref", ref: "supplier", label: "Supplier" },
        { name: "location", type: "text" },
        { name: "active", type: "boolean" },
      ],
    },
    {
      name: "stock_movement",
      label: "Stock movements",
      singular: "Stock movement",
      purpose: "one quantity in or out of stock, and why",
      title: "display_name",
      fields: [
        { name: "display_name", type: "text", label: "Movement", formula: "coalesce(stock_item_id.name, 'Stock') + ' · ' + reason" },
        { name: "stock_item_id", type: "ref", ref: "stock_item", label: "Item", required: true, core: true },
        { name: "quantity", type: "number", required: true, core: true, help: "positive in, negative out" },
        { name: "reason", type: "choice", required: true, core: true, options: ["purchase", "sale", "usage", "adjustment", "return", "wastage"] },
        { name: "work_item_id", type: "ref", ref: "work_item", label: "For work" },
        { name: "note", type: "text" },
        { name: "moved_at", type: "datetime" },
      ],
    },
  ],
  actions: [
    {
      name: "receive_stock",
      label: "Receive stock",
      entity: "stock_item",
      summary: "Add a delivered quantity to stock.",
      effects: ["record"],
      policy: AUTO,
      params: [
        { name: "quantity", type: "number", required: true },
        { name: "note", type: "text" },
      ],
      guard: { if: "param.quantity > 0", else: "receive a quantity above zero" },
      creates: { entity: "stock_movement", fields: { stock_item_id: "=id()", quantity: "=param.quantity", reason: "purchase", note: "=param.note", moved_at: "=now()" } },
    },
    {
      name: "use_stock",
      label: "Use stock",
      entity: "stock_item",
      summary: "Take a quantity out of stock for a job or a sale.",
      effects: ["record"],
      policy: AUTO,
      params: [
        { name: "quantity", type: "number", required: true },
        { name: "note", type: "text" },
      ],
      guard: { if: "param.quantity > 0 and param.quantity <= on_hand", else: "not enough on hand" },
      creates: { entity: "stock_movement", fields: { stock_item_id: "=id()", quantity: "=-param.quantity", reason: "usage", note: "=param.note", moved_at: "=now()" } },
    },
    {
      name: "adjust_stock",
      label: "Adjust count",
      entity: "stock_item",
      summary: "Correct the count after a stock-take, up or down.",
      effects: ["record"],
      policy: approve("desk", "a manual adjustment changes stock without a delivery or a use"),
      params: [
        { name: "quantity", type: "number", required: true, help: "the correction: positive adds, negative removes" },
        { name: "reason", type: "text", required: true },
      ],
      creates: { entity: "stock_movement", fields: { stock_item_id: "=id()", quantity: "=param.quantity", reason: "adjustment", note: "=param.reason", moved_at: "=now()" } },
    },
    {
      name: "request_reorder",
      label: "Reorder",
      entity: "stock_item",
      summary: "Start a purchase order for this item with its supplier.",
      effects: ["record"],
      policy: AUTO,
      guard: { if: "supplier_id != null", else: "set a supplier for this item first" },
      creates: { entity: "purchase_order", fields: { supplier_id: "=supplier_id", title: "='Reorder: ' + name" } },
    },
  ],
  settings: [],
});

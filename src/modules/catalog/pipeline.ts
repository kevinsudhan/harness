import { defineModule, AUTO } from "../types.js";

/**
 * The business's own work, moving through its own stages.
 *
 * Every other module ships its lifecycle, because an invoice is drafted, issued and paid
 * in every business there is. This one cannot: a shipment, a court matter, a course of
 * dental treatment and a catering order share nothing except that they move through
 * stages. So the stages, and the actions that belong to them, are the one thing a business
 * writes for itself — the old vertical configs, narrowed to the part only it can say.
 *
 * What ships here is a default (open, in progress, done) and the three actions that make
 * sense at any stage of any work. Money, bookings and messages are not pipeline actions:
 * they belong to invoicing, appointments and messaging, which point at the work item.
 */
export const pipeline = defineModule({
  id: "pipeline",
  label: "Pipeline",
  category: "core",
  icon: "KanbanSquare",
  summary: "The business's own work — a shipment, matter, treatment course, event order or placement — moving through stages the business defines, with its own actions and approvals.",
  usedBy: ["freight forwarder", "law firm", "dental clinic", "caterer", "recruitment agency", "repair shop", "real estate agency"],
  requires: ["contacts"],
  extensible: "work_item",
  entities: [
    {
      name: "work_item",
      label: "Work",
      singular: "Work item",
      purpose: "one piece of work the business delivers, from start to finish",
      title: "title",
      fields: [
        { name: "title", type: "text", required: true, core: true },
        { name: "contact_id", type: "ref", ref: "contact", label: "Customer" },
        { name: "account_id", type: "ref", ref: "account", label: "Organisation" },
        { name: "asset_id", type: "ref", ref: "asset", label: "Asset" },
        { name: "listing_id", type: "ref", ref: "listing", label: "Listing" },
        { name: "enquiry_id", type: "ref", ref: "enquiry", label: "From enquiry" },
        { name: "owner", type: "text", help: "who is responsible for it" },
        { name: "value", type: "money" },
        { name: "priority", type: "choice", options: ["low", "normal", "high", "urgent"] },
        { name: "due_date", type: "date" },
        { name: "notes", type: "longtext" },
      ],
      lifecycle: {
        order: ["open", "in_progress", "completed", "cancelled"],
        initial: "open",
        states: {
          open: { label: "Open", next: ["in_progress", "cancelled"] },
          in_progress: { label: "In progress", next: ["completed", "cancelled"] },
          completed: { label: "Completed", next: [] },
          cancelled: { label: "Cancelled", next: [] },
        },
      },
    },
  ],
  actions: [
    {
      name: "assign_work",
      label: "Assign",
      entity: "work_item",
      summary: "Make a person responsible for this work.",
      effects: ["record"],
      policy: AUTO,
      params: [{ name: "owner", type: "text", required: true }],
      sets: { owner: "=param.owner" },
    },
    {
      name: "set_priority",
      label: "Set priority",
      entity: "work_item",
      summary: "Change how urgent this work is.",
      effects: ["record"],
      policy: AUTO,
      params: [{ name: "priority", type: "choice", required: true, options: ["low", "normal", "high", "urgent"] }],
      sets: { priority: "=param.priority" },
    },
    {
      name: "notify_customer",
      label: "Update the customer",
      entity: "work_item",
      summary: "Tell the customer where their work has got to.",
      effects: ["outbound"],
      policy: AUTO,
      params: [{ name: "message", type: "longtext", required: true }],
    },
  ],
  settings: [],
});

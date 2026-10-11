import { defineModule, AUTO, approve } from "../types.js";

/**
 * The people a business serves. Every other module points here, so it stays small: who
 * they are, how to reach them, and whether they have asked not to be reached — which
 * messaging reads before it sends anything.
 */
export const contacts = defineModule({
  id: "contacts",
  label: "Contacts",
  category: "core",
  icon: "Users",
  summary: "The people the business serves — customers, patients, clients, members, students, owners — and how to reach them.",
  usedBy: ["every business"],
  requires: [],
  entities: [
    {
      name: "contact",
      label: "Contacts",
      singular: "Contact",
      purpose: "one person the business deals with",
      title: "full_name",
      fields: [
        { name: "full_name", type: "text", label: "Name", required: true, core: true, pii: true },
        { name: "phone", type: "phone", pii: true },
        { name: "email", type: "email", pii: true },
        { name: "account_id", type: "ref", ref: "account", label: "Organisation", help: "the company they belong to, for a business customer" },
        { name: "contact_type", type: "choice", label: "Type", options: ["customer", "prospect", "partner", "other"] },
        { name: "source", type: "choice", options: ["walk_in", "phone", "website", "referral", "social", "other"], help: "how they first found the business" },
        { name: "preferred_channel", type: "choice", options: ["phone", "sms", "whatsapp", "email"] },
        { name: "date_of_birth", type: "date", pii: true },
        { name: "address", type: "longtext", pii: true },
        { name: "tags", type: "tags" },
        { name: "do_not_contact", type: "boolean", core: true, help: "they asked not to be contacted; outbound messages to them are refused" },
        { name: "notes", type: "longtext" },
      ],
    },
  ],
  actions: [
    {
      name: "mark_do_not_contact",
      label: "Mark do not contact",
      entity: "contact",
      summary: "Record that this person asked not to be contacted; every outbound message to them is refused from now on.",
      effects: ["record"],
      policy: AUTO,
      sets: { do_not_contact: true },
    },
    {
      name: "export_contact_data",
      label: "Export personal data",
      entity: "contact",
      summary: "Prepare a copy of everything held about this person, for a data-access request.",
      effects: ["sensitive"],
      policy: approve("compliance", "exporting personal data takes it outside the system"),
    },
    {
      name: "erase_contact",
      label: "Erase personal data",
      entity: "contact",
      summary: "Erase this person's personal details while keeping the history of what was done.",
      effects: ["sensitive", "destructive"],
      policy: approve("compliance", "erasure cannot be undone"),
      params: [{ name: "reason", type: "text", required: true }],
      sets: { full_name: "Erased contact", phone: null, email: null, date_of_birth: null, address: null, do_not_contact: true },
    },
  ],
  settings: [],
});

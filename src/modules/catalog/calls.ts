import { defineModule, AUTO } from "../types.js";

/**
 * The call desk: every phone call, whether a person or a voice agent took it, with what
 * was said and what came of it. A call is a log, not a process, so it has no lifecycle —
 * what a call starts (a callback, an enquiry) is made in the module that owns it.
 */
export const calls = defineModule({
  id: "calls",
  label: "Calls",
  category: "engagement",
  icon: "PhoneCall",
  summary: "Every phone call — taken by staff or a voice agent — with summary, transcript and outcome, turned into callbacks and enquiries.",
  usedBy: ["dental clinic", "freight forwarder", "salon", "gym", "any business that takes bookings by phone"],
  requires: [],
  entities: [
    {
      name: "call",
      label: "Calls",
      singular: "Call",
      purpose: "one phone call and what came of it",
      title: "summary",
      fields: [
        { name: "summary", type: "text", required: true, core: true },
        { name: "contact_id", type: "ref", ref: "contact", label: "Contact" },
        { name: "phone", type: "phone", pii: true, core: true },
        { name: "direction", type: "choice", options: ["inbound", "outbound"] },
        { name: "handled_by", type: "text", help: "the staff member or voice agent" },
        { name: "started_at", type: "datetime" },
        { name: "duration_seconds", type: "integer" },
        { name: "outcome", type: "choice", options: ["booked", "enquiry", "callback_needed", "complaint", "information", "no_answer", "other"] },
        { name: "transcript", type: "longtext", pii: true },
        { name: "recording_url", type: "url" },
        { name: "enquiry_id", type: "ref", ref: "enquiry", label: "Enquiry" },
        { name: "work_item_id", type: "ref", ref: "work_item", label: "About work" },
      ],
    },
  ],
  actions: [
    {
      name: "schedule_callback",
      label: "Schedule callback",
      entity: "call",
      summary: "Create a task to call the person back.",
      effects: ["record"],
      policy: AUTO,
      params: [
        { name: "due", type: "date", required: true },
        { name: "note", type: "text" },
      ],
      creates: {
        entity: "task",
        fields: {
          title: "='Call back ' + coalesce(contact_id.full_name, phone)",
          due_date: "=param.due",
          contact_id: "=contact_id",
          details: "=coalesce(param.note, summary)",
        },
      },
    },
    {
      name: "create_enquiry_from_call",
      label: "Make an enquiry",
      entity: "call",
      summary: "Open an enquiry from what the caller asked for.",
      effects: ["record"],
      policy: AUTO,
      guard: { if: "enquiry_id = null", else: "this call already has an enquiry" },
      creates: { entity: "enquiry", fields: { summary: "=summary", contact_id: "=contact_id", phone: "=phone", channel: "phone" } },
      sets: { enquiry_id: "=created()" },
    },
  ],
  settings: [],
});

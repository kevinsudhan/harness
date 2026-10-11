import { defineModule, AUTO } from "../types.js";

/**
 * What a customer has agreed to — treatment, marketing, photographs, sharing their data —
 * and when they took it back. A clinic needs this before it treats anyone, and anyone who
 * markets needs it before the first campaign.
 *
 * One record is one grant, with the evidence for it. Withdrawing or expiring ends it, and
 * consent given again is a new record with new evidence — never an old grant revived,
 * which would make "what had they agreed to on the 3rd?" unanswerable.
 */
export const consent = defineModule({
  id: "consent",
  label: "Consent",
  category: "control",
  icon: "ClipboardCheck",
  summary: "Consent records per customer and purpose — treatment, marketing, photographs, data sharing — granted, withdrawn or expired.",
  usedBy: ["dental clinic", "veterinary clinic", "physiotherapist", "tutoring centre (minors)", "any business that markets"],
  requires: ["contacts"],
  entities: [
    {
      name: "consent_record",
      label: "Consents",
      singular: "Consent",
      purpose: "one customer's consent to one purpose",
      title: "display_name",
      fields: [
        { name: "display_name", type: "text", label: "Consent", formula: "coalesce(contact_id.full_name, 'Customer') + ' · ' + purpose" },
        { name: "contact_id", type: "ref", ref: "contact", label: "Customer", required: true, core: true },
        { name: "purpose", type: "choice", required: true, core: true, options: ["treatment", "marketing", "photography", "data_processing", "data_sharing", "other"] },
        { name: "captured_via", type: "choice", options: ["form", "verbal", "email", "sms", "in_person"] },
        { name: "evidence", type: "text", help: "the form reference, or who witnessed it" },
        { name: "expires_on", type: "date" },
        { name: "withdraw_reason", type: "text" },
        { name: "notes", type: "longtext" },
      ],
      lifecycle: {
        order: ["granted", "withdrawn", "expired"],
        initial: "granted",
        states: {
          granted: { label: "Granted", next: ["withdrawn", "expired"] },
          withdrawn: { label: "Withdrawn", next: [] },
          expired: { label: "Expired", next: [] },
        },
        auto: [{ from: ["granted"], to: "expired", if: "expires_on < today()" }],
      },
    },
  ],
  actions: [
    {
      name: "withdraw_consent",
      label: "Withdraw",
      entity: "consent_record",
      summary: "Record that the customer withdrew this consent.",
      effects: ["record"],
      policy: AUTO,
      when: ["granted"],
      to: "withdrawn",
      params: [{ name: "reason", type: "text" }],
      sets: { withdraw_reason: "=param.reason" },
    },
  ],
  settings: [],
});

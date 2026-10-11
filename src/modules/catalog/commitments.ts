import { defineModule, AUTO, approve } from "../types.js";

/**
 * Promises with a clock on them — a cut-off, a court date, a callback by six, a report by
 * Friday. The template's commitments engine, as a module: a commitment goes at-risk and
 * then missed on its own as time passes, and it is only fulfilled with evidence, because
 * "done" without proof is the claim every missed promise was closed with.
 */
export const commitments = defineModule({
  id: "commitments",
  label: "Commitments",
  category: "control",
  icon: "AlarmClock",
  summary: "Promises and deadlines with an owner — they turn at-risk and missed on their own, and close only with evidence.",
  usedBy: ["freight forwarder cut-offs", "law firm court dates", "recruitment offer deadlines", "any business that promises by a date"],
  requires: [],
  entities: [
    {
      name: "commitment",
      label: "Commitments",
      singular: "Commitment",
      purpose: "one promise with an owner and a deadline",
      title: "title",
      fields: [
        { name: "title", type: "text", required: true, core: true, help: "what was promised" },
        { name: "owner", type: "text", required: true, core: true },
        { name: "contact_id", type: "ref", ref: "contact", label: "Promised to" },
        { name: "work_item_id", type: "ref", ref: "work_item", label: "For work" },
        { name: "due_at", type: "datetime", required: true, core: true },
        { name: "evidence_required", type: "text", help: "what proves it was done" },
        { name: "evidence", type: "longtext", core: true },
        { name: "priority", type: "choice", options: ["low", "normal", "high", "urgent"] },
        { name: "waive_reason", type: "text" },
      ],
      lifecycle: {
        order: ["open", "at_risk", "fulfilled", "missed", "waived"],
        initial: "open",
        states: {
          open: { label: "Open", next: ["at_risk", "fulfilled", "missed", "waived"] },
          at_risk: { label: "At risk", next: ["fulfilled", "missed", "waived"] },
          fulfilled: { label: "Fulfilled", next: [] },
          missed: { label: "Missed", next: [] },
          waived: { label: "Waived", next: [] },
        },
        auto: [
          { from: ["open", "at_risk"], to: "missed", if: "due_at < now()" },
          { from: ["open"], to: "at_risk", if: "due_at < add_minutes(now(), setting.warn_before_minutes)" },
        ],
      },
    },
  ],
  actions: [
    {
      name: "fulfil_commitment",
      label: "Fulfil",
      entity: "commitment",
      summary: "Close the commitment as kept, with the evidence that it was.",
      effects: ["record"],
      policy: AUTO,
      when: ["open", "at_risk"],
      to: "fulfilled",
      params: [{ name: "evidence", type: "longtext", required: true }],
      sets: { evidence: "=param.evidence" },
    },
    {
      name: "escalate_commitment",
      label: "Escalate",
      entity: "commitment",
      summary: "Raise a commitment that is at risk or missed with its owner's manager.",
      effects: ["record"],
      policy: AUTO,
      when: ["at_risk", "missed"],
    },
    {
      name: "waive_commitment",
      label: "Waive",
      entity: "commitment",
      summary: "Release the business from the promise.",
      effects: ["destructive"],
      policy: approve("desk", "waiving a promise to a customer is a commercial decision"),
      when: ["open", "at_risk"],
      to: "waived",
      params: [{ name: "reason", type: "text", required: true }],
      sets: { waive_reason: "=param.reason" },
    },
  ],
  settings: [
    { name: "warn_before_minutes", label: "At risk before (minutes)", type: "integer", default: 240, help: "how long before the deadline a commitment turns at-risk" },
  ],
});

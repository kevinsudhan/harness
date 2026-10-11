import { defineModule, AUTO, approve } from "../types.js";

/**
 * The team. Mostly a list other modules point at — who an appointment is with, who a task
 * is for — but it also holds who may approve what, which is why granting that role is
 * itself an approved action: it is the control that every other control rests on.
 *
 * Once anyone on the list has an approver role, the engine holds every approval to it: a
 * finance hold needs someone with finance (or owner), and a name not on the list cannot
 * approve at all. Before that, any second person can — a business with no staff list yet
 * still gets the requester-cannot-approve rule.
 */
export const staff = defineModule({
  id: "staff",
  label: "Team",
  category: "people",
  icon: "UserCog",
  summary: "Staff members, their roles and skills, who may approve what, and leave — the people other modules assign work to.",
  usedBy: ["every business with staff"],
  requires: [],
  entities: [
    {
      name: "staff_member",
      label: "Team",
      singular: "Staff member",
      purpose: "one person who works for the business",
      title: "full_name",
      fields: [
        { name: "full_name", type: "text", label: "Name", required: true, core: true, pii: true },
        { name: "role_title", type: "text", label: "Role" },
        { name: "approver_role", type: "choice", core: true, options: ["none", "desk", "compliance", "finance", "owner"], help: "which approvals this person may give — an owner may give any" },
        { name: "phone", type: "phone", pii: true },
        { name: "email", type: "email", pii: true },
        { name: "skills", type: "tags" },
        { name: "joined_on", type: "date" },
        { name: "leave_until", type: "date" },
        { name: "notes", type: "longtext" },
      ],
      lifecycle: {
        order: ["active", "on_leave", "left"],
        initial: "active",
        states: {
          active: { label: "Active", next: ["on_leave", "left"] },
          on_leave: { label: "On leave", next: ["active", "left"] },
          left: { label: "Left", next: [] },
        },
      },
    },
  ],
  actions: [
    {
      name: "grant_approver_role",
      label: "Set approver role",
      entity: "staff_member",
      summary: "Change which approvals this person may give.",
      effects: ["record"],
      policy: approve("compliance", "changing who may approve is a change to the controls themselves"),
      when: ["active", "on_leave"],
      params: [{ name: "role", type: "choice", required: true, options: ["none", "desk", "compliance", "finance", "owner"] }],
      sets: { approver_role: "=param.role" },
    },
    {
      name: "start_leave",
      label: "Start leave",
      entity: "staff_member",
      summary: "Record that the person is away.",
      effects: ["record"],
      policy: AUTO,
      when: ["active"],
      to: "on_leave",
      params: [{ name: "until", type: "date" }],
      sets: { leave_until: "=param.until" },
    },
    {
      name: "end_leave",
      label: "End leave",
      entity: "staff_member",
      summary: "Record that the person is back.",
      effects: ["record"],
      policy: AUTO,
      when: ["on_leave"],
      to: "active",
      sets: { leave_until: null },
    },
    {
      name: "offboard_staff",
      label: "Offboard",
      entity: "staff_member",
      summary: "Record that the person has left.",
      effects: ["destructive"],
      policy: approve("desk", "offboarding removes someone's access"),
      when: ["active", "on_leave"],
      to: "left",
    },
  ],
  settings: [],
});

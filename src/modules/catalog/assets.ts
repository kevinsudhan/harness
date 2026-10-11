import { defineModule, AUTO } from "../types.js";

/**
 * The thing the customer brings in, as distinct from the customer: a dog, a car, a phone,
 * an air conditioner, a flat under management. A vet treats the pet and bills the owner;
 * a garage services the car and calls the driver. Without this the pet's history is
 * scattered across its owner's notes, and the second dog in the house breaks it.
 */
export const assets = defineModule({
  id: "assets",
  label: "Assets",
  category: "operations",
  icon: "PawPrint",
  summary: "The things customers bring to be serviced — pets, vehicles, devices, appliances, properties — with owner, identifiers and service history.",
  usedBy: ["veterinary clinic", "car service centre", "repair shop", "appliance service", "property management", "equipment maintenance"],
  requires: ["contacts"],
  entities: [
    {
      name: "asset",
      label: "Assets",
      singular: "Asset",
      purpose: "one thing a customer owns that the business works on",
      title: "name",
      fields: [
        { name: "name", type: "text", required: true, core: true },
        { name: "kind", type: "choice", core: true, options: ["pet", "vehicle", "device", "appliance", "property", "equipment", "other"] },
        { name: "contact_id", type: "ref", ref: "contact", label: "Owner", required: true, core: true },
        { name: "identifier", type: "text", help: "registration, serial or microchip number" },
        { name: "make_model", type: "text", label: "Make / model / breed" },
        { name: "born_or_made_on", type: "date", label: "Born / made on" },
        { name: "last_service_on", type: "date", core: true },
        { name: "next_service_due", type: "date", core: true },
        { name: "retire_reason", type: "text" },
        { name: "notes", type: "longtext" },
      ],
      lifecycle: {
        order: ["active", "retired"],
        initial: "active",
        states: {
          active: { label: "Active", next: ["retired"] },
          retired: { label: "Retired", next: [] },
        },
      },
    },
  ],
  actions: [
    {
      name: "record_service",
      label: "Record service",
      entity: "asset",
      summary: "Record a service today and, optionally, when the next is due.",
      effects: ["record"],
      policy: AUTO,
      when: ["active"],
      params: [{ name: "next_service_due", type: "date" }],
      sets: { last_service_on: "=today()", next_service_due: "=coalesce(param.next_service_due, add_days(today(), setting.service_interval_days))" },
    },
    {
      name: "send_service_reminder",
      label: "Send service reminder",
      entity: "asset",
      summary: "Remind the owner the next service is due.",
      effects: ["outbound"],
      policy: AUTO,
      when: ["active"],
      guard: { if: "next_service_due != null", else: "no service is due" },
    },
    {
      name: "retire_asset",
      label: "Retire",
      entity: "asset",
      summary: "Record that the asset is no longer in service — sold, scrapped, or passed away.",
      effects: ["record"],
      policy: AUTO,
      when: ["active"],
      to: "retired",
      params: [{ name: "reason", type: "text", required: true }],
      sets: { retire_reason: "=param.reason" },
    },
  ],
  settings: [
    { name: "service_interval_days", label: "Service interval (days)", type: "integer", default: 180, help: "the usual gap between services, when none is given" },
  ],
});

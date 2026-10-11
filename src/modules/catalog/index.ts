/**
 * The module catalogue — every module a business can be composed from.
 *
 * Ordered the way a business is usually explained: who you serve and what you do for them,
 * then how you sell and get paid, then how the work is run, then who does it, then how you
 * talk to customers, then the controls. The model sees them in this order too.
 *
 * Adding a module is adding a file here. catalog.test (modules.test.ts) checks it against
 * every other module — its refs, its actions' states, its formulas — before anything runs.
 */
import type { ModuleDef, EntityDef, ActionDef } from "../types.js";
import { contacts } from "./contacts.js";
import { accounts } from "./accounts.js";
import { pipeline } from "./pipeline.js";
import { enquiries } from "./enquiries.js";
import { catalogue } from "./catalogue.js";
import { quotes } from "./quotes.js";
import { agreements } from "./agreements.js";
import { memberships } from "./memberships.js";
import { listings } from "./listings.js";
import { invoicing } from "./invoicing.js";
import { payments } from "./payments.js";
import { claims } from "./claims.js";
import { timesheets } from "./timesheets.js";
import { appointments } from "./appointments.js";
import { capacity } from "./capacity.js";
import { tasks } from "./tasks.js";
import { documents } from "./documents.js";
import { assets } from "./assets.js";
import { inventory } from "./inventory.js";
import { procurement } from "./procurement.js";
import { staff } from "./staff.js";
import { messaging } from "./messaging.js";
import { calls } from "./calls.js";
import { feedback } from "./feedback.js";
import { commitments } from "./commitments.js";
import { consent } from "./consent.js";

export const CATALOG: readonly ModuleDef[] = [
  // core — who the business serves and the work it does
  contacts, accounts, pipeline,
  // sales — winning the work
  enquiries, catalogue, quotes, agreements, memberships, listings,
  // finance — getting paid
  invoicing, payments, claims, timesheets,
  // operations — running the work
  appointments, capacity, tasks, documents, assets, inventory, procurement,
  // people
  staff,
  // engagement — talking to customers
  messaging, calls, feedback,
  // control — promises and permissions
  commitments, consent,
];

export function moduleById(id: string): ModuleDef | undefined {
  return CATALOG.find((m) => m.id === id);
}

/** Which module owns an entity. Entity names are unique across the catalogue. */
export function ownerOf(entity: string): ModuleDef | undefined {
  return CATALOG.find((m) => m.entities.some((e) => e.name === entity));
}

export function entityDef(entity: string): EntityDef | undefined {
  for (const m of CATALOG) {
    const e = m.entities.find((x) => x.name === entity);
    if (e) return e;
  }
  return undefined;
}

export function actionDef(name: string): { module: ModuleDef; action: ActionDef } | undefined {
  for (const m of CATALOG) {
    const a = m.actions.find((x) => x.name === name);
    if (a) return { module: m, action: a };
  }
  return undefined;
}

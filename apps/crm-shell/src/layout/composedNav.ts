import { Bot, KanbanSquare, LayoutDashboard, Settings2, ShieldAlert, ShieldCheck } from "lucide-react";
import type { Manifest } from "../lib/api";
import { iconFor } from "../lib/icons";

export interface NavItem {
  to: string;
  label: string;
  icon: React.ElementType;
  badge?: number;
}

/**
 * A composed app's navigation: its modules, in the business's own words, grouped the way
 * the catalogue is — customers and work, selling, money, running it, the team, talking to
 * customers, controls. Line items are reached from their invoice or quote, not the menu.
 */
const CATEGORY_TITLES: Array<[string, string]> = [
  ["core", "Customers & work"],
  ["sales", "Selling"],
  ["finance", "Money"],
  ["operations", "Operations"],
  ["people", "Team"],
  ["engagement", "Conversations"],
  ["control", "Controls"],
];

export function composedGroups(m: Manifest, primary: string, pending: number): Array<{ title?: string; items: NavItem[] }> {
  const modules = m.modules ?? [];
  const board = m.entities.find((e) => e.name === primary)?.label ?? "Work";
  const groups: Array<{ title?: string; items: NavItem[] }> = [
    { items: [{ to: "/", label: "Overview", icon: LayoutDashboard }, { to: "/board", label: `${board} board`, icon: KanbanSquare }] },
  ];
  for (const [category, title] of CATEGORY_TITLES) {
    const items: NavItem[] = [];
    for (const mod of modules.filter((x) => x.category === category)) {
      const shown = mod.entities.map((n) => m.entities.find((e) => e.name === n)).filter((e) => e && !e.name.endsWith("_line"));
      for (const e of shown) items.push({ to: `/e/${e!.name}`, label: shown.length === 1 ? mod.label : e!.label, icon: iconFor(mod.icon) });
    }
    if (items.length) groups.push({ title, items });
  }
  groups.push({
    title: "Oversight",
    items: [
      { to: "/agent", label: "Agent", icon: Bot },
      { to: "/approvals", label: "Approvals", icon: ShieldAlert, badge: pending },
      { to: "/audit", label: "Audit trail", icon: ShieldCheck },
    ],
  });
  groups.push({ title: "Setup", items: [{ to: "/setup", label: "Business setup", icon: Settings2 }] });
  return groups;
}

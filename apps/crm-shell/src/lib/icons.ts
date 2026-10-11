/**
 * The icons a module may name (src/modules/catalog — each module's `icon`). Looked up by
 * name so the catalogue stays data; a name not here falls back to a plain table.
 */
import {
  AlarmClock, BadgeCheck, Boxes, Building2, CalendarCheck, CalendarClock, ClipboardCheck, FileSignature, FileText,
  FolderOpen, Home, Inbox, KanbanSquare, ListChecks, MessageSquare, PawPrint, PhoneCall, Receipt, ShieldCheck, Star,
  Table2, Tags, Timer, Truck, UserCog, Users, Wallet,
} from "lucide-react";

const ICONS: Record<string, React.ElementType> = {
  AlarmClock, BadgeCheck, Boxes, Building2, CalendarCheck, CalendarClock, ClipboardCheck, FileSignature, FileText,
  FolderOpen, Home, Inbox, KanbanSquare, ListChecks, MessageSquare, PawPrint, PhoneCall, Receipt, ShieldCheck, Star,
  Tags, Timer, Truck, UserCog, Users, Wallet,
};

export const iconFor = (name: string | undefined): React.ElementType => (name && ICONS[name]) || Table2;

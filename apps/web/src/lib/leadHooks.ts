import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// BD's lead book (apps/api/src/modules/leads).

export const CUSTOMER_TYPES = ["D2C", "Exports", "Distribution", "MLM", "Medical", "Sports", "Others"] as const;
export const PRODUCT_FORMATS = ["Gummies", "Bars", "Capsules", "Tablets", "Omega", "Liquid", "Soft gel", "Powder", "Others"] as const;
export const POWDER_TYPES = ["Creatine", "Protein", "Yeast", "Clear", "Meal / Soya shakes", "Whey", "Others"] as const;
export const LEAD_SOURCES = ["Referral", "LinkedIn", "Website", "E-com platforms", "Paid campaigns", "Medical platforms", "Regional brands"] as const;

export type LeadStatus = "DISCUSSION" | "SAMPLING" | "COLD" | "WARM" | "HOT" | "HOLD" | "DROPPED" | "CONVERTED";
export type LeadMeetingMode = "CALL" | "VIDEO" | "IN_PERSON";

export const LEAD_STATUS_ORDER: LeadStatus[] = ["DISCUSSION", "SAMPLING", "COLD", "WARM", "HOT", "HOLD", "DROPPED", "CONVERTED"];
export const LEAD_STATUS_META: Record<LeadStatus, { label: string; meaning: string; pill: string; text: string }> = {
  DISCUSSION: { label: "Discussion", meaning: "Under discussion", pill: "border-slate-200 bg-slate-50 text-slate-700", text: "text-slate-700" },
  SAMPLING: { label: "Sampling", meaning: "Send product for sampling", pill: "border-violet-200 bg-violet-50 text-violet-700", text: "text-violet-700" },
  COLD: { label: "Cold", meaning: "Can get order in 60 days", pill: "border-sky-200 bg-sky-50 text-sky-700", text: "text-sky-700" },
  WARM: { label: "Warm", meaning: "Can get order in 30 days", pill: "border-amber-200 bg-amber-50 text-amber-700", text: "text-amber-700" },
  HOT: { label: "Hot", meaning: "Can get order in 15 days", pill: "border-rose-200 bg-rose-50 text-rose-700", text: "text-rose-700" },
  HOLD: { label: "Hold", meaning: "Wait for some time", pill: "border-slate-300 bg-slate-100 text-slate-600", text: "text-slate-600" },
  DROPPED: { label: "Dropped", meaning: "Not interested", pill: "border-slate-300 bg-slate-100 text-slate-500", text: "text-slate-500" },
  CONVERTED: { label: "Converted", meaning: "Sample approved, order coming", pill: "border-emerald-200 bg-emerald-50 text-emerald-700", text: "text-emerald-700" },
};
export const MODE_LABEL: Record<LeadMeetingMode, string> = { CALL: "Call", VIDEO: "Video", IN_PERSON: "In person" };

/** A lead that is over: nothing left to follow up. */
export const isClosed = (s: LeadStatus) => s === "DROPPED" || s === "CONVERTED";

export interface Lead {
  id: string;
  brandName: string;
  contactPerson: string;
  designation: string;
  phones: string[];
  email: string;
  address: string;
  city: string;
  state: string;
  customerTypes: string[];
  productFormats: string[];
  powderTypes: string[];
  leadSource: string | null;
  status: LeadStatus;
  statusAt: string;
  /** "YYYY-MM" */
  closureMonth: string | null;
  /** Opens once a sample of the lead is approved (then mandatory). */
  estimatedQty: string | null;
  estimatedValueLac: number | null;
  convertedAt: string | null;
  sampleApproved: boolean;
  /** The POs of the lead's customer entered since it was Converted. */
  poNumbers: string[];
  waitingForPo: boolean;
  customerId: string | null;
  nextFollowUpAt: string | null;
  businessCardId: string | null;
  pocId: string;
  pocName: string;
  meetingCount: number;
  lastMeeting: { number: number; meetingDate: string; notes: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadMeeting {
  id: string;
  number: number;
  meetingDate: string;
  mode: LeadMeetingMode;
  notes: string;
  statusAfter: LeadStatus;
  nextFollowUpAt: string | null;
  closureMonth: string | null;
  createdByName: string;
  createdAt: string;
}

export interface LeadReschedule {
  id: string;
  fromAt: string | null;
  toAt: string;
  reason: string;
  byName: string;
  createdAt: string;
}

export type LeadDetail = Lead & { meetings: LeadMeeting[]; reschedules: LeadReschedule[] };

export interface LeadSummary {
  total: number;
  byStatus: Record<LeadStatus, number>;
  followUpToday: number;
  overdue: number;
  dueToday: number;
  noFollowUp: number;
  waitingForPo: number;
}

export type LeadInput = Partial<Pick<Lead, "brandName" | "contactPerson" | "designation" | "phones" | "email" | "address" | "city" | "state" | "customerTypes" | "productFormats" | "powderTypes" | "leadSource">> & {
  status?: LeadStatus;
  nextFollowUpAt?: string | null;
  closureMonth?: string | null;
  estimatedQty?: string | null;
  estimatedValueLac?: number | null;
  businessCardId?: string;
  /** BD: who follows the lead up (any department); BD themself when not given. */
  assignToId?: string;
  /** BD: hand the lead to someone else. */
  pocId?: string;
};

export interface MeetingInput {
  meetingDate: string;
  mode: LeadMeetingMode;
  notes: string;
  statusAfter: LeadStatus;
  nextFollowUpAt?: string;
  closureMonth?: string;
  estimatedQty?: string;
  estimatedValueLac?: number;
}

const KEY = ["leads"];

/** The start and the end of the person's today (ISO), so "today" is the salesman's day. */
export function todayBounds(): { from: string; until: string } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  return { from: start.toISOString(), until: end.toISOString() };
}

export function useLeads() {
  return useQuery({ queryKey: KEY, queryFn: () => api<Lead[]>("/api/leads") });
}

export function useLead(id: string | undefined) {
  return useQuery({ queryKey: [...KEY, "one", id], queryFn: () => api<LeadDetail>(`/api/leads/${id}`), enabled: !!id });
}

export interface ForecastBucket {
  key: string;
  leads: number;
  valueLac: number;
  hot: number;
  warm: number;
  cold: number;
  other: number;
  converted: number;
}

export interface LeadForecast {
  totals: { leads: number; open: number; dropped: number; openValueLac: number; convertedValueLac: number; waitingValueLac: number; waitingForPo: number; noClosureMonth: number };
  byMonth: ForecastBucket[];
  bySource: ForecastBucket[];
  funnel: { leads: number; sample: number; approved: number; converted: number; poReceived: number };
}

export function useLeadForecast() {
  return useQuery({ queryKey: [...KEY, "forecast"], queryFn: () => api<LeadForecast>("/api/leads/forecast") });
}

export function useLeadSummary(options?: { enabled?: boolean }) {
  const { from, until } = todayBounds();
  return useQuery({
    queryKey: [...KEY, "summary", from.slice(0, 10)],
    queryFn: () => api<LeadSummary>(`/api/leads/summary?from=${encodeURIComponent(from)}&until=${encodeURIComponent(until)}`),
    enabled: options?.enabled,
    staleTime: 10_000,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: KEY });
}

/** The names to choose from: the fixed ones plus those typed under "Others" on any lead (they join the list for everyone). Shows the fixed ones until it loads. */
export function useLeadOptions() {
  const { data } = useQuery({
    queryKey: ["leads", "options"],
    queryFn: () => api<{ customerTypes: string[]; productFormats: string[]; powderTypes: string[] }>("/api/leads/options/lists"),
    staleTime: 60_000,
  });
  return {
    customerTypes: data?.customerTypes ?? [...CUSTOMER_TYPES],
    productFormats: data?.productFormats ?? [...PRODUCT_FORMATS],
    powderTypes: data?.powderTypes ?? [...POWDER_TYPES],
  };
}

/** BD / Admin: the people a lead can be handed to, with their department. */
export function useLeadAssignees(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: ["leads", "assignees"], queryFn: () => api<{ id: string; name: string; department: string }[]>("/api/leads/assignees"), enabled: options?.enabled, staleTime: 60_000 });
}

export function useCreateLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (body: LeadInput) => api<Lead>("/api/leads", { method: "POST", body }), onSuccess: done });
}

export function useUpdateLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, ...body }: { id: string } & LeadInput) => api<Lead>(`/api/leads/${id}`, { method: "PATCH", body }), onSuccess: done });
}

/** Delete a lead that has gone nowhere (no meeting, no sample, not converted). */
export function useDeleteLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api<void>(`/api/leads/${id}`, { method: "DELETE" }), onSuccess: done });
}

export function useAddMeeting() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, ...body }: { id: string } & MeetingInput) => api<LeadMeeting>(`/api/leads/${id}/meetings`, { method: "POST", body }), onSuccess: done });
}

export function useConvertLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, ...body }: { id: string; estimatedQty?: string; estimatedValueLac?: number }) => api<Lead>(`/api/leads/${id}/convert`, { method: "POST", body }), onSuccess: done });
}

export function useRescheduleLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, ...body }: { id: string; toAt: string; reason: string }) => api<Lead>(`/api/leads/${id}/reschedule`, { method: "POST", body }), onSuccess: done });
}

// ---------------------------------------------------------------------------------------------------------------------
// small helpers the screens share
// ---------------------------------------------------------------------------------------------------------------------

/** "2026-12" -> "Dec 2026". */
export function monthLabel(ym: string | null): string {
  if (!ym) return "-";
  const [y, m] = ym.split("-").map(Number);
  return new Date(y!, (m ?? 1) - 1, 1).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

/** The next 18 months as { value: "YYYY-MM", label } for the closure month picker. */
export function closureMonthOptions(current: string | null): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < 18; i++) {
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    out.push({ value, label: monthLabel(value) });
    d.setMonth(d.getMonth() + 1);
  }
  if (current && !out.some((o) => o.value === current)) out.unshift({ value: current, label: monthLabel(current) });
  return out;
}

/** An ISO time as the value of a datetime-local input (the person's own clock). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The other way round: a datetime-local value as an ISO string ("" stays empty). */
export function fromLocalInput(value: string): string | undefined {
  return value ? new Date(value).toISOString() : undefined;
}

/** "12.5" Lac as a short readable amount. */
export const fmtLac = (v: number | null | undefined) => (v == null ? "-" : `₹${v.toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`);

export const fmtDay = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-");
export const fmtDateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "-");

/** How a follow-up date reads: overdue, today, or the day. */
export function followUpState(iso: string | null, status: LeadStatus): { text: string; tone: "late" | "today" | "later" | "none" } {
  if (isClosed(status)) return { text: "-", tone: "none" };
  if (!iso) return { text: "Not set", tone: "none" };
  const due = new Date(iso);
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);
  if (due < start) {
    const days = Math.max(1, Math.round((start.getTime() - new Date(due.getFullYear(), due.getMonth(), due.getDate()).getTime()) / 86_400_000));
    return { text: `${days} day${days === 1 ? "" : "s"} overdue`, tone: "late" };
  }
  if (due <= end) return { text: `Today ${due.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`, tone: "today" };
  return { text: fmtDateTime(iso), tone: "later" };
}

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh", "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka", "Kerala",
  "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya", "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim", "Tamil Nadu", "Telangana", "Tripura",
  "Uttar Pradesh", "Uttarakhand", "West Bengal", "Delhi", "Chandigarh", "Jammu and Kashmir", "Ladakh", "Puducherry",
];

/** City and state from a card's address: the state is looked for by name, the city is the part just before it ("..., Greater Noida, Uttar Pradesh - 201310, India"). */
export function guessCityState(address: string): { city: string; state: string } {
  if (!address.trim()) return { city: "", state: "" };
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const state = INDIAN_STATES.find((s) => parts[i]!.toLowerCase().includes(s.toLowerCase()));
    if (!state) continue;
    const before = i > 0 ? parts[i - 1]! : "";
    const own = parts[i]!.replace(new RegExp(state, "i"), "").replace(/[-\d\s]+/g, " ").trim();
    return { city: (own || before).replace(/\d{3}\s?\d{3}/g, "").trim(), state };
  }
  return { city: "", state: "" };
}

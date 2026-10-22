import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE, api, getToken } from "./api";

// The visiting-card book (apps/api/src/modules/business-cards): every department collects cards, BD follows them up.
export interface BusinessCard {
  id: string;
  name: string;
  designation: string;
  company: string;
  phones: string[];
  email: string;
  website: string;
  address: string;
  gstNo: string;
  categories: string[];
  notes: string;
  /** READING: a scan whose photo is still being read in the background (its fields fill in a few seconds later). */
  status: "READING" | "NEEDS_VERIFY" | "VERIFIED";
  source: "SCAN" | "MANUAL";
  hasPhoto: boolean;
  /** 0..1 per field, how sure the OCR was (name, designation, company, phone, email, website, address, gstNo). */
  confidence: Record<string, number> | null;
  /** The raw lines the OCR read, to tap into a field. */
  ocrLines: string[] | null;
  customerId: string | null;
  /** The event it was collected at ("" = none). */
  event: string;
  /** Why the photo could not be read, if it could not (the details are then typed in). */
  readError: string | null;
  /** The earlier card (same email or phone) this may repeat: flagged, never blocked. */
  duplicateOf: { id: string; name: string; company: string; addedBy: string } | null;
  collectedBy: { id: string; name: string; department: string };
  createdByName: string;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type CardFields = Pick<BusinessCard, "name" | "designation" | "company" | "phones" | "email" | "website" | "address" | "gstNo" | "categories" | "notes" | "event">;

export const CARD_CATEGORIES = ["Bar", "Gummy", "Powder", "Liquid", "Tablet", "Capsule"] as const;
/** Under this a field is flagged "please check". */
export const SURE_ENOUGH = 0.75;

const KEY = ["business-cards"];

// While a scan is being read in the background the list refreshes by itself, so its fields appear without a reload.
export function useBusinessCards(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: KEY,
    enabled: options?.enabled,
    queryFn: () => api<BusinessCard[]>("/api/business-cards"),
    refetchInterval: (q) => (q.state.data?.some((c) => c.status === "READING") ? 2500 : false),
  });
}

/** The events cards were collected at (for the event picker). */
export function useCardEvents() {
  return useQuery({ queryKey: [...KEY, "events"], queryFn: () => api<string[]>("/api/business-cards/events"), staleTime: 30_000 });
}

/** The event the person is collecting for: asked once, remembered on this device. */
export function useCardEvent(): [string, (v: string) => void] {
  const [event, setEvent] = useState(() => {
    try {
      return localStorage.getItem("fls.cards.event") ?? "";
    } catch {
      return "";
    }
  });
  return [
    event,
    (v: string) => {
      setEvent(v);
      try {
        localStorage.setItem("fls.cards.event", v);
      } catch {
        /* a private window: it is just not remembered */
      }
    },
  ];
}

/** Waits until a scanned card has been read (the reading runs in the background), then returns it. */
export async function waitUntilCardRead(id: string, timeoutMs = 180_000): Promise<BusinessCard> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const card = await api<BusinessCard>(`/api/business-cards/${id}`);
    if (card.status !== "READING") return card;
    if (Date.now() > until) throw new Error("The card is taking long to read. It is saved: open it from your cards in a minute.");
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
}

export function useScanCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ photo, categories, event }: { photo: File; categories: string[]; event?: string }) => {
      const body = new FormData();
      body.append("categories", JSON.stringify(categories));
      if (event) body.append("event", event);
      body.append("photo", photo, photo.name || "card.jpg");
      return api<BusinessCard>("/api/business-cards/scan", { method: "POST", body, isFormData: true });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCreateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: Partial<CardFields>) => api<BusinessCard>("/api/business-cards", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useUpdateCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; verify?: boolean } & Partial<CardFields>) => api<BusinessCard>(`/api/business-cards/${id}`, { method: "PATCH", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** BD / Admin: "these are two different people": take the duplicate flag off. */
export function useClearDuplicate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<BusinessCard>(`/api/business-cards/${id}/clear-duplicate`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useDeleteCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<void>(`/api/business-cards/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

export function useCreateCustomerFromCard() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api<{ customerId: string; companyName: string; existed: boolean }>(`/api/business-cards/${id}/create-customer`, { method: "POST" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function findDuplicateCards(args: { email: string; phones: string[]; excludeId?: string }) {
  const q = new URLSearchParams();
  if (args.email) q.set("email", args.email);
  if (args.phones.length) q.set("phone", args.phones.join(","));
  if (args.excludeId) q.set("excludeId", args.excludeId);
  return api<{ id: string; name: string; company: string; addedBy: string }[]>(`/api/business-cards/duplicates?${q.toString()}`);
}

/** The card's photo is behind the login, so it is fetched with the token and shown from a temporary local URL. */
export function useCardPhoto(id: string | null, enabled: boolean): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!id || !enabled) return;
    let cancelled = false;
    let made: string | null = null;
    const token = getToken();
    fetch(`${API_BASE}/api/business-cards/${id}/photo`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("no photo"))))
      .then((b) => {
        if (cancelled) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => setUrl(null));
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [id, enabled]);
  return url;
}

/** A vCard 3.0 file: opening it on a phone offers "add to contacts". */
export function cardToVcf(c: BusinessCard): string {
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
  const parts = c.name.trim().split(/\s+/);
  const last = parts.length > 1 ? parts[parts.length - 1]! : "";
  const first = parts.length > 1 ? parts.slice(0, -1).join(" ") : (parts[0] ?? "");
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `N:${esc(last)};${esc(first)};;;`, `FN:${esc(c.name || c.company)}`];
  if (c.company) lines.push(`ORG:${esc(c.company)}`);
  if (c.designation) lines.push(`TITLE:${esc(c.designation)}`);
  for (const p of c.phones) lines.push(`TEL;TYPE=CELL:${p.replace(/\s+/g, "")}`);
  if (c.email) lines.push(`EMAIL;TYPE=WORK:${c.email}`);
  if (c.website) lines.push(`URL:${/^https?:\/\//.test(c.website) ? c.website : `https://${c.website}`}`);
  if (c.address) lines.push(`ADR;TYPE=WORK:;;${esc(c.address)};;;;`);
  const note = [c.categories.length ? `Categories: ${c.categories.join(", ")}` : "", c.gstNo ? `GST: ${c.gstNo}` : "", c.notes].filter(Boolean).join(" | ");
  if (note) lines.push(`NOTE:${esc(note)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n");
}

export function downloadVcf(c: BusinessCard): void {
  const blob = new Blob([cardToVcf(c)], { type: "text/vcard;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(c.name || c.company || "contact").replace(/[^\w.-]+/g, "_")}.vcf`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

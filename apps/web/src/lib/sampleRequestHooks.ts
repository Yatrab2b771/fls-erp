import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// A sample a customer asked for (apps/api/src/modules/sample-requests). One record, two tiles (BD and R&D), laid out like the Sample Request Sheet:
// yellow = Sales (BD) fills, blue = R&D fills, pink = RA (Regulatory), Gummies only.

export type SampleStatus = "REQUESTED" | "PLANNING" | "IN_PROCESS" | "READY" | "DISPATCHED" | "ON_HOLD" | "CANNOT_MAKE";
export type SampleTemplate = "POWDER" | "GUMMIES" | "BARS";
export type SampleFeedback = "APPROVED" | "CHANGE_REQUESTED" | "REJECTED";

export const SAMPLE_STATUS_ORDER: SampleStatus[] = ["REQUESTED", "PLANNING", "IN_PROCESS", "READY", "DISPATCHED", "ON_HOLD", "CANNOT_MAKE"];
export const SAMPLE_STATUS_LABEL: Record<SampleStatus, string> = {
  REQUESTED: "New",
  PLANNING: "Planning",
  IN_PROCESS: "In process",
  READY: "Ready",
  DISPATCHED: "Dispatched",
  ON_HOLD: "On hold",
  CANNOT_MAKE: "Cannot make",
};
export const SAMPLE_STATUS_PILL: Record<SampleStatus, string> = {
  REQUESTED: "border-orange-200 bg-orange-50 text-orange-700",
  PLANNING: "border-sky-200 bg-sky-50 text-sky-700",
  IN_PROCESS: "border-amber-200 bg-amber-50 text-amber-700",
  READY: "border-emerald-200 bg-emerald-50 text-emerald-700",
  DISPATCHED: "border-cyan-200 bg-cyan-50 text-cyan-700",
  ON_HOLD: "border-slate-300 bg-slate-100 text-slate-600",
  CANNOT_MAKE: "border-rose-200 bg-rose-50 text-rose-700",
};
export const TEMPLATE_LABEL: Record<SampleTemplate, string> = { POWDER: "Powder", GUMMIES: "Gummies", BARS: "Bars" };
export const FEEDBACK_LABEL: Record<SampleFeedback, string> = { APPROVED: "Approved", CHANGE_REQUESTED: "Change requested", REJECTED: "Rejected" };
export const FEEDBACK_PILL: Record<SampleFeedback, string> = {
  APPROVED: "border-emerald-200 bg-emerald-50 text-emerald-700",
  CHANGE_REQUESTED: "border-amber-200 bg-amber-50 text-amber-700",
  REJECTED: "border-rose-200 bg-rose-50 text-rose-700",
};

export interface SampleRequest {
  id: string;
  requestNo: number;
  template: SampleTemplate;
  status: SampleStatus;
  statusAt: string;
  round: number;
  customerId: string;
  customerName: string;
  leadId: string | null;
  leadBrand: string | null;
  pocName: string;
  requestedByName: string;
  createdAt: string;
  // yellow
  productName: string;
  composition: string;
  neededBy: string | null;
  dosageForm: string | null;
  quantity: string | null;
  remarks: string | null;
  referenceSample: string | null;
  clientFeedback: string | null;
  feedback: SampleFeedback | null;
  internalRemark: string | null;
  // blue
  sampleCode: string | null;
  preparedByName: string | null;
  expectedDate: string | null;
  preparedOn: string | null;
  rdRemarks: string | null;
  readyAt: string | null;
  dispatchedAt: string | null;
  // pink
  exportDomestic: string | null;
  labelClaim: string | null;
  bomUploadedAt: string | null;
}

export interface SampleRound {
  id: string;
  round: number;
  sampleCode: string | null;
  preparedByName: string | null;
  expectedDate: string | null;
  preparedOn: string | null;
  rdRemarks: string | null;
  readyAt: string | null;
  dispatchedAt: string | null;
  feedback: SampleFeedback;
  customerRemark: string;
  internalRemark: string | null;
  createdAt: string;
}

export interface SampleRmRequest {
  id: string;
  itemName: string;
  quantity: number;
  unit: string;
  status: string;
  requestedAt: string;
}

export type SampleRequestDetail = SampleRequest & { rounds: SampleRound[]; rmRequests: SampleRmRequest[] };

export const sampleNo = (n: number) => `SR-${String(n).padStart(4, "0")}`;

/** Days a request has waited: from the request until it was Ready, or until now while it is not. `took` = it already finished. */
export function sampleAgeing(r: Pick<SampleRequest, "createdAt" | "readyAt" | "status">): { days: number; took: boolean } {
  const end = r.readyAt ? new Date(r.readyAt) : new Date();
  const days = Math.max(0, Math.floor((end.getTime() - new Date(r.createdAt).getTime()) / 86_400_000));
  return { days, took: !!r.readyAt };
}

const KEY = ["sample-requests"];

export function useSampleRequests(options?: { enabled?: boolean }) {
  return useQuery({ queryKey: KEY, queryFn: () => api<SampleRequest[]>("/api/sample-requests"), enabled: options?.enabled });
}

export function useSampleRequest(id: string | undefined) {
  return useQuery({ queryKey: [...KEY, "one", id], queryFn: () => api<SampleRequestDetail>(`/api/sample-requests/${id}`), enabled: !!id });
}

export function useRndTeam() {
  return useQuery({ queryKey: [...KEY, "rnd-team"], queryFn: () => api<{ id: string; fullName: string }[]>("/api/sample-requests/rnd-team"), staleTime: 60_000 });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: KEY });
    qc.invalidateQueries({ queryKey: ["rnd-store"] });
  };
}

export interface NewSampleInput {
  leadId?: string;
  customerId?: string;
  template: SampleTemplate;
  composition: string;
  neededBy: string;
  dosageForm?: string;
  quantity?: string;
  remarks?: string;
  referenceSample?: string;
}

export function useCreateSampleRequest() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (body: NewSampleInput) => api<SampleRequest>("/api/sample-requests", { method: "POST", body }), onSuccess: done });
}

export function useUpdateSalesPart() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; composition?: string; neededBy?: string; dosageForm?: string | null; quantity?: string | null; remarks?: string | null; referenceSample?: string | null }) =>
      api<SampleRequest>(`/api/sample-requests/${id}/sales`, { method: "PATCH", body }),
    onSuccess: done,
  });
}

export function useUpdateRndPart() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; sampleCode?: string | null; preparedByName?: string | null; expectedDate?: string | null; preparedOn?: string | null; rdRemarks?: string | null }) =>
      api<SampleRequest>(`/api/sample-requests/${id}/rnd`, { method: "PATCH", body }),
    onSuccess: done,
  });
}

export function useSampleAction() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; action: "START" | "READY" | "DISPATCH" | "HOLD" | "CANNOT_MAKE"; reason?: string }) => api<SampleRequest>(`/api/sample-requests/${id}/status`, { method: "POST", body }),
    onSuccess: done,
  });
}

export function useUpdateRaPart() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; exportDomestic?: "Export" | "Domestic" | null; labelClaim?: string | null }) => api<SampleRequest>(`/api/sample-requests/${id}/ra`, { method: "PATCH", body }),
    onSuccess: done,
  });
}

export function useSampleFeedback() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, ...body }: { id: string; feedback: SampleFeedback; customerRemark: string; internalRemark?: string }) => api<SampleRequest>(`/api/sample-requests/${id}/feedback`, { method: "POST", body }),
    onSuccess: done,
  });
}

export function useBomUploaded() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => api<SampleRequest>(`/api/sample-requests/${id}/bom-uploaded`, { method: "POST" }), onSuccess: done });
}

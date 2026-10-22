import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api";

// The transporters Dispatch ships with (the Transport name dropdown on a shipment). See apps/api/src/modules/transporters.

export interface Transporter {
  id: string;
  name: string;
  /** The 15-character GST-style Transporter ID the e-way bill asks for. */
  transporterId: string | null;
}

export function useTransporters(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: ["transporters"],
    queryFn: () => api<Transporter[]>("/api/transporters"),
    enabled: options?.enabled,
    staleTime: 60_000,
  });
}

export function useCreateTransporter() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; transporterId?: string }) => api<Transporter>("/api/transporters", { method: "POST", body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["transporters"] }),
  });
}

import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ConfirmDialog } from "./ConfirmDialog";
import { ItemPicker } from "./ItemPicker";
import { useToast } from "./Toast";
import { ApiError } from "../lib/api";
import { useAssignPlannedPlant, usePlants } from "../lib/hooks";

// PPIC picks (or changes) the Plant a product will be made at, without opening its PO. The same setting the PO page has; once Production
// has started the run the Plant is locked and the server says so.
export function AssignPlantDialog({ open, poId, itemId, productName, currentPlantId, onClose }: { open: boolean; poId: string; itemId: string; productName: string; currentPlantId?: string | null; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: plants } = usePlants();
  const assign = useAssignPlannedPlant(poId);
  const [plantId, setPlantId] = useState(currentPlantId ?? "");
  useEffect(() => {
    if (open) setPlantId(currentPlantId ?? "");
  }, [open, currentPlantId]);

  async function save() {
    try {
      await assign.mutateAsync({ itemId, plantId: plantId || null });
      // The Material Planning / PO Readiness lists are keyed under "purchase-orders" too; refresh them all
      await qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      toast.success(plantId ? `Plant set for ${productName}.` : `Plant cleared for ${productName}.`);
      onClose();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not set the Plant");
    }
  }

  return (
    <ConfirmDialog
      open={open}
      title="Assign Plant"
      confirmLabel="Save"
      message={
        <div className="space-y-2 text-left">
          <p>
            Which Plant will make <b>{productName}</b>? Production then sees it in that Plant's New Plan list.
          </p>
          <ItemPicker items={(plants ?? []).map((p) => ({ id: p.id, name: p.name }))} value={plantId} onChange={setPlantId} placeholder="— Select a Plant —" />
        </div>
      }
      busy={assign.isPending}
      onConfirm={save}
      onCancel={onClose}
    />
  );
}

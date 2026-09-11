import { Link } from "react-router-dom";
import { ArrowDownToLine, Beaker, ClipboardCheck, PauseCircle, ShieldAlert, Truck } from "lucide-react";
import { useAuth } from "../lib/auth";
import { useQcDashboard } from "../lib/hooks";
import { StatTile } from "../components/StatTile";
import { SkeletonRows } from "../components/Skeleton";
import { EmptyState } from "../components/EmptyState";
import { ReceivedCard, FgTransferCard } from "./InventoryPage";
import type { CombinedLot, PreProduction } from "../lib/types";

const GATE_LABEL: Record<string, string> = { QA_GATE_MFG: "QA Gate — Manufacturing", QA_GATE_PACKAGING: "QA Gate — Packaging" };

// One place to see everything QC has parked on hold, across every
// checkpoint in the app — inward Material Received, outward FG Dispatch,
// the pre-production Sample QC Approval gate, and the CombinedLot's two
// QA gates — plus what's still waiting on a first review. Every action
// here is the exact same mutation the Inventory page's own cards use
// (ReceivedCard/FgTransferCard, reused directly, not forked); production
// rows link out to the run/lot itself since a QA gate's fields go
// through the pipeline's own stage form, not a one-field approve/reject.
export function QcDashboardPage() {
  const { hasRole } = useAuth();
  const canQc = hasRole("QA_QC");
  const canWrite = hasRole("STORE");
  const canDispatch = hasRole("DISPATCH");
  const canInvoice = hasRole("ACCOUNTS");

  const { data, isLoading } = useQcDashboard();

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3.5">
        <div className="stat-icon bg-orange-500/10 text-orange-600">
          <PauseCircle className="h-5 w-5" strokeWidth={2} />
        </div>
        <div>
          <h1 className="text-2xl font-black tracking-tight text-slate-900">QC Dashboard</h1>
          <p className="text-sm text-slate-500">
            Everything on hold or awaiting first review, across Material Received, FG Dispatch, Line Clearance, Sample QC Approval, IPQC, Bulk QC, and both Combined Lot QA gates.
          </p>
        </div>
      </div>

      {isLoading || !data ? (
        <SkeletonRows rows={4} cols={4} />
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <StatTile icon={PauseCircle} label="On Hold — Total" value={data.counts.onHoldTotal} accent="amber" />
            <StatTile icon={ArrowDownToLine} label="Material Received Hold" value={data.counts.onHoldReceiptQc} accent="amber" />
            <StatTile icon={Truck} label="FG Dispatch Hold" value={data.counts.onHoldDispatchQc} accent="amber" />
            <StatTile icon={ShieldAlert} label="QA Gate Mfg Hold" value={data.counts.onHoldMfgBatches} accent="amber" />
            <StatTile icon={ShieldAlert} label="QA Gate Packaging Hold" value={data.counts.onHoldPackBatches} accent="amber" />
          </div>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-6">
            <StatTile icon={ClipboardCheck} label="Pending Receipt QC" value={data.counts.pendingReceiptQc} accent="slate" />
            <StatTile icon={ClipboardCheck} label="Pending Dispatch QC" value={data.counts.pendingDispatchQc} accent="slate" />
            <StatTile icon={Beaker} label="Pending Line Clearance" value={data.counts.pendingLineClearanceBatches} accent="sky" />
            <StatTile icon={Beaker} label="Pending Sample QC Approval" value={data.counts.pendingSampleQcBatches} accent="sky" />
            <StatTile icon={Beaker} label="Pending IPQC" value={data.counts.pendingIpqcBatches} accent="sky" />
            <StatTile icon={Beaker} label="Pending Bulk QC" value={data.counts.pendingBulkQcBatches} accent="sky" />
          </div>

          <Section title="Material Received" icon={ArrowDownToLine}>
            {!data.receipts.onHold.length && !data.receipts.pending.length ? (
              <EmptyState icon={ArrowDownToLine} title="Nothing waiting" hint="Every Material Received entry has been reviewed." accent="brand" />
            ) : (
              <div className="space-y-3">
                {[...data.receipts.onHold, ...data.receipts.pending].map((t) => (
                  <ReceivedCard key={t.id} txn={t} canQc={canQc} canWrite={canWrite} />
                ))}
              </div>
            )}
          </Section>

          <Section title="FG Dispatch" icon={Truck}>
            {!data.dispatches.onHold.length && !data.dispatches.pending.length ? (
              <EmptyState icon={Truck} title="Nothing waiting" hint="Every FG transfer has cleared outward QC." accent="brand" />
            ) : (
              <div className="space-y-3">
                {[...data.dispatches.onHold, ...data.dispatches.pending].map((d) => (
                  <FgTransferCard key={d.id} transfer={d} canQc={canQc} canWrite={canWrite} canDispatch={canDispatch} canInvoice={canInvoice} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Line Clearance — before Dispensing" icon={Beaker}>
            {!data.batches.pendingLineClearance.length ? (
              <EmptyState icon={Beaker} title="Nothing waiting" hint="No run is sitting at Line Clearance right now." accent="brand" />
            ) : (
              <div className="space-y-2">
                {data.batches.pendingLineClearance.map((r) => (
                  <GateRow key={r.id} {...preProductionRow(r, r.lineClearanceStatus, r.lineClearanceRemarks)} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Sample QC Approval — the pre-production gate" icon={Beaker}>
            {!data.batches.pendingSampleQc.length ? (
              <EmptyState icon={Beaker} title="Nothing waiting" hint="No run is sitting at Sample QC Approval right now." accent="brand" />
            ) : (
              <div className="space-y-2">
                {data.batches.pendingSampleQc.map((r) => (
                  <GateRow key={r.id} {...preProductionRow(r, r.sampleQcStatus, r.sampleQcRemarks)} />
                ))}
              </div>
            )}
          </Section>

          <Section title="In-Process QA (IPQC)" icon={Beaker}>
            {!data.batches.pendingIpqc.length ? (
              <EmptyState icon={Beaker} title="Nothing waiting" hint="No lot is sitting at IPQC right now." accent="brand" />
            ) : (
              <div className="space-y-2">
                {data.batches.pendingIpqc.map((l) => (
                  <GateRow key={l.id} {...combinedLotRow(l, l.ipqcStatus, l.ipqcRemarks)} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Bulk QC — before Packaging" icon={Beaker}>
            {!data.batches.pendingBulkQc.length ? (
              <EmptyState icon={Beaker} title="Nothing waiting" hint="No lot is sitting at Bulk QC right now." accent="brand" />
            ) : (
              <div className="space-y-2">
                {data.batches.pendingBulkQc.map((l) => (
                  <GateRow key={l.id} {...combinedLotRow(l, l.bulkQcStatus, l.bulkQcRemarks)} />
                ))}
              </div>
            )}
          </Section>

          <Section title="Lots held at a QA Gate" icon={ShieldAlert}>
            {!data.batches.onHoldMfg.length && !data.batches.onHoldPack.length ? (
              <EmptyState icon={ShieldAlert} title="No lots on hold" hint="Nothing is parked at either QA gate right now." accent="brand" />
            ) : (
              <div className="space-y-2">
                {[...data.batches.onHoldMfg, ...data.batches.onHoldPack].map((l) => (
                  <GateRow key={l.id} {...holdRow(l)} />
                ))}
              </div>
            )}
          </Section>
        </>
      )}
    </div>
  );
}

function Section({ title, icon: Icon, children }: { title: string; icon: typeof ArrowDownToLine; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-slate-400" strokeWidth={2.5} />
        <h2 className="text-sm font-bold uppercase tracking-wide text-slate-500">{title}</h2>
      </div>
      {children}
    </div>
  );
}

interface GateRowData {
  link: string;
  productName: string;
  poNumber: string | null;
  customerName: string;
  subtitle?: string;
  status: string | null;
  note: string | null;
  hold: boolean;
}

function preProductionRow(r: PreProduction, status: string | null, note: string | null): GateRowData {
  return { link: `/pre-productions/${r.id}`, productName: r.purchaseOrderItem.productName, poNumber: r.purchaseOrderItem.purchaseOrder.poNumber, customerName: r.purchaseOrderItem.purchaseOrder.customer.companyName, status, note, hold: status === "Hold" };
}

function combinedLotRow(l: CombinedLot, status: string | null, note: string | null): GateRowData {
  const item = l.preProduction.purchaseOrderItem;
  return { link: `/combined-lots/${l.id}`, productName: item.productName, poNumber: item.purchaseOrder.poNumber, customerName: item.purchaseOrder.customer.companyName, status, note, hold: status === "Hold" };
}

// Used for the "on hold" section, where the status is whichever of the
// gate's two fields (QA/QC) actually reads Hold, and the subtitle names
// the gate itself since both QA gates share this one row shape.
function holdRow(l: CombinedLot): GateRowData {
  const status = l.currentStageId === "QA_GATE_MFG" ? (l.mfgQaStatus ?? l.mfgQcStatus) : (l.packQaStatus ?? l.packQcStatus);
  const note = l.currentStageId === "QA_GATE_MFG" ? l.mfgRemarks : l.packRemarks;
  const item = l.preProduction.purchaseOrderItem;
  return {
    link: `/combined-lots/${l.id}`,
    productName: item.productName,
    poNumber: item.purchaseOrder.poNumber,
    customerName: item.purchaseOrder.customer.companyName,
    subtitle: GATE_LABEL[l.currentStageId] ?? l.currentStageId,
    status,
    note,
    hold: true,
  };
}

// Every row here needs QC's attention — unlike a plain hold list,
// there's no separate "pending vs held" split for the four hard-gate
// stages (Line Clearance, Sample QC Approval, IPQC, Bulk QC): anything
// other than a literal "Approved" blocks the next stage, so a run that
// just arrived with no status set yet is exactly as much "waiting on QC"
// as one already marked Hold — the badge reflects that with a neutral
// "Awaiting Review" default instead of assuming a hold.
// Tailwind classes as static strings, not string-interpolated — a
// dynamic `border-${color}-300` never survives the build's class scan.
const GATE_ROW_STYLE = {
  orange: { hover: "hover:border-orange-300 hover:bg-orange-50/40", pill: "border-orange-200 bg-orange-50 text-orange-700", dot: "bg-orange-500" },
  rose: { hover: "hover:border-rose-300 hover:bg-rose-50/40", pill: "border-rose-200 bg-rose-50 text-rose-700", dot: "bg-rose-500" },
  sky: { hover: "hover:border-sky-300 hover:bg-sky-50/40", pill: "border-sky-200 bg-sky-50 text-sky-700", dot: "bg-sky-500" },
} as const;

function GateRow({ link, productName, poNumber, customerName, subtitle, status, note, hold }: GateRowData) {
  const style = GATE_ROW_STYLE[hold ? "orange" : status === "Not Approved" ? "rose" : "sky"];
  return (
    <Link to={link} className={`card flex flex-wrap items-center gap-3 p-4 transition sm:p-5 ${style.hover}`}>
      <div className="min-w-0 flex-1">
        <p className="font-bold text-slate-800">{productName}</p>
        <p className="mt-1 text-xs text-slate-500">
          {poNumber ?? "No PO number"} · {customerName}
          {subtitle && ` · ${subtitle}`}
        </p>
        {note && <p className="mt-1 text-xs text-slate-400">{note}</p>}
      </div>
      <span className={`pill ${style.pill}`}>
        <span className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${style.dot}`} /> {status ?? "Awaiting Review"}
      </span>
    </Link>
  );
}

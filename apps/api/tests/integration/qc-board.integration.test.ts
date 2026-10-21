import { describe, expect, it } from "vitest";
import request from "supertest";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";

const app = createApp();

describe("QA/QC dashboard: one list per QA stage, with the full row and the actions", () => {
  it("lists batches at IPQC, both QA gates and FG release; Hold collects in ON_HOLD; the actions move them", async () => {
    const { token: bd } = await createUser(["BD"]);
    const { token: qa } = await createUser(["QA_QC"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { user: owner } = await createUser(["STORE"]);
    const plant = await prisma.plant.create({ data: { name: `QC Plant ${Date.now()}`, createdById: owner.id } });
    const customer = await request(app).post("/api/customers").set(authHeader(bd)).send({ companyName: `QC Customer ${Date.now()}` });
    const po = await request(app).post("/api/purchase-orders").set(authHeader(bd)).send({
      customerId: customer.body.id,
      poNumber: `QC-PO-${Date.now()}`,
      items: ["QC Run", "QC Ipqc", "QC Mfg", "QC Pack", "QC Fg"].map((productName) => ({ productName, productCategory: "Powder", quantity: 100, unit: "KG" })),
    });
    const items = po.body.items as { id: string; productName: string }[];
    const item = (n: string) => items.find((i) => i.productName === n)!.id;

    const mkRun = (name: string, stage: "SAMPLE_QC_APPROVAL" | "DISPENSING" | "MATERIAL_RECEIVED" | "INDENT_ISSUE" = "SAMPLE_QC_APPROVAL") =>
      prisma.preProduction.create({ data: { purchaseOrderItemId: item(name), plannedQty: 100, plantId: plant.id, currentStageId: stage } });
    const mkBatch = async (name: string, currentStageId: "IPQC" | "QA_GATE_MFG" | "QA_GATE_PACKAGING" | "FG_QC_RELEASE", extra: Record<string, unknown> = {}) => {
      const run = await mkRun(name, "SAMPLE_QC_APPROVAL");
      await prisma.preProduction.update({ where: { id: run.id }, data: { sampleQcStatus: "Approved" } });
      return prisma.productionBatch.create({
        data: { preProduction: { connect: { id: run.id } }, createdBy: { connect: { id: owner.id } }, batchNo: `B-${name}`, plannedQty: 100, outputQty: 98, shift: "Day", manpowerCount: 6, status: "COMPLETED", completedAt: new Date(), currentStageId, ...extra },
      });
    };

    const ipqc = await mkBatch("QC Ipqc", "IPQC");
    const mfg = await mkBatch("QC Mfg", "QA_GATE_MFG");
    const pack = await mkBatch("QC Pack", "QA_GATE_PACKAGING", { mfgApprovedQty: 98 });
    const fg = await mkBatch("QC Fg", "FG_QC_RELEASE", { packApprovedQty: 95 });

    const board = (token: string, stage: string) => request(app).get(`/api/qc/board?stage=${stage}`).set(authHeader(token));
    expect((await board(ppic, "IPQC")).status).toBe(403); // QA only
    expect((await board(qa, "NOPE")).status).toBe(400);

    // Every stage lists its own row, with the full detail on it
    expect((await board(qa, "LINE_CLEARANCE")).status).toBe(400); // the stage no longer exists
    const ip = (await board(qa, "IPQC")).body.find((r: { id: string }) => r.id === ipqc.id);
    expect(ip).toMatchObject({ kind: "BATCH", batchNo: "B-QC Ipqc", outputQty: 98, shift: "Day", manpowerCount: 6, plantName: plant.name });
    expect((await board(qa, "QA_GATE_MFG")).body.some((r: { id: string }) => r.id === mfg.id)).toBe(true);
    expect((await board(qa, "QA_GATE_PACKAGING")).body.find((r: { id: string }) => r.id === pack.id)).toMatchObject({ approvedQty: null, stageLabel: "QA Gate: Packaging" });
    expect((await board(qa, "FG_QC_RELEASE")).body.find((r: { id: string }) => r.id === fg.id)).toMatchObject({ approvedQty: 95 });
    // A batch still being made is not at any QA stage yet
    expect(JSON.stringify((await board(qa, "IPQC")).body)).not.toContain("QC Run");

    // Hold at IPQC: stays at the stage, collects in ON_HOLD, tile counts follow
    const counts0 = (await request(app).get("/api/qc/stage-counts").set(authHeader(qa))).body;
    const held = await request(app).patch(`/api/production-batches/${ipqc.id}/stage`).set(authHeader(qa)).send({ action: "FORWARD", ipqcStatus: "Hold", ipqcRemarks: "Wait for the sample" });
    expect(held.body.currentStageId).toBe("IPQC");
    expect((await board(qa, "ON_HOLD")).body.find((r: { id: string }) => r.id === ipqc.id)).toMatchObject({ isHold: true, remarks: "Wait for the sample", qaStatus: "Hold" });
    expect((await request(app).get("/api/qc/stage-counts").set(authHeader(qa))).body.ON_HOLD).toBe(counts0.ON_HOLD + 1);

    // Approve at IPQC moves it to the next QA gate (so it leaves IPQC and joins QA Gate: Manufacturing)
    const approved = await request(app).patch(`/api/production-batches/${ipqc.id}/stage`).set(authHeader(qa)).send({ action: "FORWARD", ipqcStatus: "Approved" });
    expect(approved.body.currentStageId).toBe("QA_GATE_MFG");
    expect((await board(qa, "IPQC")).body.some((r: { id: string }) => r.id === ipqc.id)).toBe(false);
    expect((await board(qa, "QA_GATE_MFG")).body.some((r: { id: string }) => r.id === ipqc.id)).toBe(true);
  });
});

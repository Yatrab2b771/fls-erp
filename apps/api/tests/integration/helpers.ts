import bcrypt from "bcryptjs";
import { prisma } from "../../src/common/lib/prisma";
import { signAccessToken } from "../../src/common/lib/jwt";
import { RoleName } from "@prisma/client";

let counter = 0;

/** Creates a real user row with the given roles and a matching bearer token — bypasses HTTP for speed since login itself is covered separately. */
export async function createUser(roles: RoleName[] = []) {
  counter += 1;
  const email = `test-user-${counter}@fls.test`;
  const passwordHash = await bcrypt.hash("TestPassword123", 10);
  const user = await prisma.user.create({ data: { email, passwordHash, fullName: `Test User ${counter}` } });

  for (const name of roles) {
    const role = await prisma.role.findUniqueOrThrow({ where: { name } });
    await prisma.userRole.create({ data: { userId: user.id, roleId: role.id } });
  }

  const token = signAccessToken({ sub: user.id, roles, tokenVersion: user.tokenVersion });
  return { user, token, email, password: "TestPassword123" };
}

export function authHeader(token: string) {
  return { Authorization: `Bearer ${token}` };
}

let plantCounter = 0;
/** Plans are generated only once the product has a Plant (its material goes to that Plant's Day Store): gives the PO item one. */
export async function ensurePlant(purchaseOrderItemId: string) {
  const item = await prisma.purchaseOrderItem.findUniqueOrThrow({ where: { id: purchaseOrderItemId }, select: { plannedPlantId: true } });
  if (item.plannedPlantId) return item.plannedPlantId;
  plantCounter += 1;
  const creator = await prisma.user.findFirstOrThrow({ select: { id: true } });
  const plant = await prisma.plant.create({ data: { name: `Test Plant ${Date.now()}-${plantCounter}`, createdById: creator.id } });
  await prisma.purchaseOrderItem.update({ where: { id: purchaseOrderItemId }, data: { plannedPlantId: plant.id } });
  return plant.id;
}

/** What a batch needs to START (the production sheet's start fields). Spread it into the create body: { ...BATCH_START, plannedQty }. */
export const BATCH_START = { shift: "Day", manpowerCount: 5, shiftStartAt: "2026-10-01T08:00:00.000Z", inputQty: 1 };

/**
 * A product PPIC has planned and sent to Production (Regulatory approved, plan sent): the one thing Production needs before it can open a run
 * on it. Tests that open runs through the API call this on the PO item first.
 */
export async function sendPlanToProduction(purchaseOrderItemId: string, plannedPlantId?: string) {
  await prisma.purchaseOrderItem.update({ where: { id: purchaseOrderItemId }, data: { regulatoryStatus: "Approved", planSentToProductionAt: new Date(), ...(plannedPlantId ? { plannedPlantId } : {}) } });
}

let loginCounter = 0;
/**
 * A Day Store login with a Day Store and Plant of its own. The run-level Material Received and Dispensing steps are the Day Store's of the run's
 * Plant, so a test that acts as the store there needs this: give the product's plan this Plant (sendPlanToProduction(itemId, plant.id)) and
 * the run opens on it.
 */
export async function createDayStoreLogin() {
  const login = await createUser(["STORE"]);
  loginCounter += 1;
  const dayStore = await prisma.dayStore.create({ data: { name: `Test DS ${Date.now()}-${loginCounter}`, createdById: login.user.id } });
  const plant = await prisma.plant.create({ data: { name: `Test DS Plant ${Date.now()}-${loginCounter}`, createdById: login.user.id, dayStoreId: dayStore.id } });
  await prisma.dayStoreAssignment.create({ data: { userId: login.user.id, dayStoreId: dayStore.id } });
  return { ...login, dayStore, plant };
}

/**
 * Stock that is really in the Warehouse: a Received entry that R&D's inward QC has approved. A Received entry alone waits for QC and does
 * not count as stock (there is no Opening Stock shortcut). Returns the Received entry's own response, like a plain POST would.
 */
export async function receiveAcceptedStock(storeToken: string, body: Record<string, unknown>) {
  const { createApp } = await import("../../src/app");
  const request = (await import("supertest")).default;
  const app = createApp();
  const { isOpeningStock: _ignored, ...entry } = body;
  const res = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ ...entry, type: "RECEIVED" });
  if (res.status === 201 && (entry.type === undefined || entry.type === "RECEIVED")) {
    const rnd = await createUser(["RND"]);
    await request(app).patch(`/api/inventory/transactions/${res.body.id}/qc`).set(authHeader(rnd.token)).send({ action: "APPROVE", samplingDate: new Date().toISOString().slice(0, 10) });
  }
  return res;
}

/** A fresh ADMIN's token: admin steps over the department and Day Store checks, so a test that is not about those can move a run along with it. */
export async function adminToken() {
  return (await createUser(["ADMIN"])).token;
}

/**
 * Moves a run (one not in the per-batch flow) on from Material Received through Indent Issue to Dispensing, as ADMIN. The run-level stages are
 * Material Received, Indent Issue, Dispensing and Sample QC Approval; each belongs to a department (and the first and third to the run's own Day
 * Store), which pre-production.integration.test.ts covers.
 */
export async function advanceRunToDispensing(runId: string) {
  const { createApp } = await import("../../src/app");
  const request = (await import("supertest")).default;
  const app = createApp();
  const token = await adminToken();
  for (let i = 0; i < 2; i++) await request(app).patch(`/api/pre-productions/${runId}/stage`).set(authHeader(token)).send({ action: "FORWARD" });
}

/** What the Day Store / Warehouse issued to a Plant is on its way until Production confirms it; this confirms it, so the Plant holds the stock. */
export async function confirmPlantReceipts() {
  await prisma.inventoryTransaction.updateMany({ where: { type: "ISSUED_PRODUCTION", deliveredAt: null, deletedAt: null }, data: { deliveredAt: new Date() } });
}

let dayStoreCounter = 0;
/**
 * Issues an approved Material Request to its Plant the way the app now requires: the Warehouse does not issue to a Plant, so the material goes
 * Warehouse -> a Day Store first and the request is then issued from that Day Store; the Plant then confirms it has received it.
 * Returns the issue response, like the plain call it replaces. `fund` sets how much the Warehouse sends to the Day Store first (default: the quantity).
 */
export async function issueToPlant(storeToken: string, requestId: string, body: { date: string; unit: string; quantity: number }, options: { fund?: number } = {}) {
  const { createApp } = await import("../../src/app");
  const request = (await import("supertest")).default;
  const app = createApp();
  const mr = await prisma.inventoryRequest.findUniqueOrThrow({ where: { id: requestId } });
  // Only a request for a Plant goes through a Day Store; one for a Day Store is issued by the Warehouse as it always was
  if (mr.purpose !== "ISSUED_PRODUCTION") return request(app).post(`/api/inventory/requests/${requestId}/issue`).set(authHeader(storeToken)).send({ ...body, dayStoreId: null });
  const creator = await prisma.user.findFirstOrThrow({ select: { id: true } });
  // The Day Store must be the request's own Plant's: a Plant without one gets a new one
  // A request made without a Plant gets one (with its own Day Store) first
  let plantId = mr.plantId;
  if (!plantId) {
    plantCounter += 1;
    plantId = (await prisma.plant.create({ data: { name: `Test Plant ${Date.now()}-${plantCounter}`, createdById: creator.id } })).id;
    await prisma.inventoryRequest.update({ where: { id: requestId }, data: { plantId } });
  }
  const plant = await prisma.plant.findUniqueOrThrow({ where: { id: plantId } });
  dayStoreCounter += 1;
  const dayStore = plant.dayStoreId
    ? await prisma.dayStore.findUniqueOrThrow({ where: { id: plant.dayStoreId } })
    : await prisma.dayStore.create({ data: { name: `Test Store ${Date.now()}-${dayStoreCounter}`, createdById: creator.id } });
  if (!plant.dayStoreId) await prisma.plant.update({ where: { id: plant.id }, data: { dayStoreId: dayStore.id } });
  // The Warehouse sends the Day Store what it does not hold already (an earlier call may have sent it all)
  const { getOnHandByDayStoreAndItem } = await import("../../src/modules/inventory/stock");
  const held = (await getOnHandByDayStoreAndItem(dayStore.id, [mr.itemId])).get(mr.itemId)?.onHand ?? 0;
  const toSend = (options.fund ?? body.quantity) - held;
  if (toSend > 1e-9) {
    const toStore = await request(app).post("/api/inventory/transactions").set(authHeader(storeToken)).send({ itemId: mr.itemId, type: "ISSUED_DAY_STORE", date: body.date, unit: body.unit, quantity: toSend, dayStoreId: dayStore.id });
    if (toStore.status !== 201) return toStore;
  }
  const res = await request(app).post(`/api/inventory/requests/${requestId}/issue`).set(authHeader(storeToken)).send({ ...body, dayStoreId: dayStore.id });
  await confirmPlantReceipts();
  return res;
}

/** Approves every Received entry still waiting for inward QC (for a bulk import, which has no single entry to approve), so they count as stock. */
export async function acceptPendingReceipts() {
  const rnd = await createUser(["RND"]);
  await prisma.inventoryTransaction.updateMany({ where: { type: "RECEIVED", receiptStatus: "PENDING_QC", deletedAt: null }, data: { receiptStatus: "ACCEPTED", acceptedById: rnd.user.id, acceptedAt: new Date() } });
}

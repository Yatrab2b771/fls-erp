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

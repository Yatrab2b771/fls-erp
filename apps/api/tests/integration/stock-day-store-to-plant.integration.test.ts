import { describe, expect, it } from "vitest";
import { createUser } from "./helpers";
import { prisma } from "../../src/common/lib/prisma";
import { getOnHandByDayStoreAndItem, getOnHandByItemId, getOnHandByPlantAndItem, getTotalAvailableByItemId } from "../../src/modules/inventory/stock";

/**
 * Warehouse can't issue to a Plant - only a Day Store can, to its own Plant. That entry is an
 * ISSUED_PRODUCTION row tagged with BOTH dayStoreId (where it came out of) and plantId (where it
 * went). It must leave the Day Store's balance, land in the Plant's, and leave the Warehouse alone.
 *
 *   100 received -> 40 to the Day Store -> 5 of those on to its Plant
 *   Warehouse 60, Day Store 35, Plant 5, nothing lost: 100 in total.
 */
describe("Day Store -> Plant issue keeps the Warehouse, Day Store and Plant balances apart", () => {
  it("does not take the Day Store's issue to its Plant out of the Warehouse a second time", async () => {
    const { user } = await createUser(["STORE"]);
    const item = await prisma.inventoryItem.create({ data: { category: "RM", name: "DSP Cocoa", unit: "Kg" } });
    const dayStore = await prisma.dayStore.create({ data: { name: "DSP Day Store", createdById: user.id } });
    const plant = await prisma.plant.create({ data: { name: "DSP Day Store", createdById: user.id, dayStoreId: dayStore.id } });
    const base = { itemId: item.id, createdById: user.id, date: new Date(), unit: "Kg" };

    await prisma.inventoryTransaction.create({ data: { ...base, type: "RECEIVED", quantity: 100, vendorName: "V", receiptStatus: "ACCEPTED", acceptedById: user.id, acceptedAt: new Date() } });
    await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_DAY_STORE", quantity: 40, dayStoreId: dayStore.id, deliveredAt: new Date() } });
    await prisma.inventoryTransaction.create({ data: { ...base, type: "ISSUED_PRODUCTION", quantity: 5, dayStoreId: dayStore.id, plantId: plant.id, deliveredAt: new Date() } });

    const warehouse = (await getOnHandByItemId([item.id])).get(item.id);
    const dayStoreBalance = (await getOnHandByDayStoreAndItem(dayStore.id, [item.id])).get(item.id)?.onHand;
    const plantBalance = (await getOnHandByPlantAndItem(plant.id, [item.id])).get(item.id);
    const total = (await getTotalAvailableByItemId([item.id])).get(item.id);

    expect({ warehouse, dayStore: dayStoreBalance, plant: plantBalance }).toEqual({ warehouse: 60, dayStore: 35, plant: 5 });
    expect(total).toBe(100);
  });
});

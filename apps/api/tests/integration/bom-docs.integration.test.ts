import { describe, expect, it } from "vitest";
import request from "supertest";
import ExcelJS from "exceljs";
import { createApp } from "../../src/app";
import { authHeader, createUser } from "./helpers";

const app = createApp();

const binary = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on("data", (c: Buffer) => chunks.push(c));
  res.on("end", () => done(null, Buffer.concat(chunks)));
};

describe("Downloading a BOM as Excel or PDF", () => {
  it("gives the product's BOM in the sheet layout (active or an older version), a PDF, and a customer-wide workbook", async () => {
    const { token: rnd } = await createUser(["RND"]);
    const { token: ppic } = await createUser(["PPIC"]);
    const { token: bd } = await createUser(["BD"]);
    const customer = await request(app).post("/api/customers").set(authHeader(rnd)).send({ companyName: `DOC Brand ${Date.now()}` });
    const name = `DOC BCAA ${Date.now()}`;
    const sku = await request(app).post("/api/catalog/skus").set(authHeader(rnd)).send({ customerId: customer.body.id, productName: name });
    const put = (components: unknown[], extra: Record<string, unknown> = {}) => request(app).put(`/api/catalog/skus/${sku.body.id}/packaging-components`).set(authHeader(rnd)).send({ components, ...extra });
    await put([{ type: "Jar", quantity: 1, unit: "Nos", overagePct: 0 }, { type: "Corrugated Box", quantity: 64, unit: "Nos", overagePct: 0 }], { header: { packSize: "120 g", packingConfig: "1*64 Jars", batchPacks: 1000 } });
    await put([{ type: "Jar", quantity: 1, unit: "Nos", overagePct: 0 }, { type: "Cap sticker", quantity: 1, unit: "Nos", overagePct: 0.02 }], { header: { packSize: "120 g", packingConfig: "1*64 Jars", batchPacks: 1000 } });

    const get = (token: string, path: string) => request(app).get(path).set(authHeader(token)).buffer(true).parse(binary);
    const cells = async (buf: Buffer) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      const out: string[] = [];
      wb.worksheets[0]!.eachRow((row) => out.push(row.values instanceof Array ? row.values.slice(1).join("|") : ""));
      return out.join("\n");
    };

    // Active (v2): jar + cap sticker; the box is gone
    const active = await get(ppic, `/api/bom-docs/pm/${sku.body.id}/export.xlsx`);
    expect(active.status).toBe(200);
    expect(active.headers["content-type"]).toContain("spreadsheetml");
    const text = await cells(active.body as Buffer);
    expect(text).toContain("Pack Size: 120 g");
    expect(text).toContain("Packing Configuration: 1*64 Jars");
    expect(text).toContain("Cap sticker");
    expect(text).not.toContain("Corrugated Box");
    expect(text).toContain("0.02");
    expect(text).toContain("Nil");

    // Old version (v1): the box is there, written as a fraction of a pack, like the paper sheet (1/64 = 0.0156)
    const old = await get(rnd, `/api/bom-docs/pm/${sku.body.id}/export.xlsx?version=1`);
    const oldText = await cells(old.body as Buffer);
    expect(oldText).toContain("Corrugated Box");
    expect(oldText).toContain("0.0156");
    expect(oldText).toContain("v1");

    const pdf = await get(rnd, `/api/bom-docs/pm/${sku.body.id}/export.pdf`);
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 4).toString()).toBe("%PDF");

    // RM recipe + the customer-wide workbook
    await request(app).post("/api/rm-costing/recipes/import").set(authHeader(rnd)).send({ recipes: [{ name, customerId: customer.body.id, batchSize: 100, ingredients: [{ name: "Whey", brand: "X", gPerServing: 0.8, proteinPct: 0 }, { name: "Cocoa", brand: "X", gPerServing: 0.2, proteinPct: 0 }] }] });
    const recipe = (await request(app).get("/api/rm-costing/recipes?pageSize=200").set(authHeader(rnd))).body.find((r: { name: string; customerId: string | null }) => r.name === name && r.customerId === customer.body.id);
    const rm = await get(ppic, `/api/bom-docs/rm/${recipe.id}/export.xlsx?customer=DOC`);
    expect(rm.status).toBe(200);
    const rmText = await cells(rm.body as Buffer);
    expect(rmText).toContain("Batch Size:|100|Kg");
    expect(rmText).toContain("Whey");
    expect(rmText).toContain("80"); // 0.8 x 100 Kg
    expect((await get(ppic, `/api/bom-docs/rm/${recipe.id}/export.pdf`)).status).toBe(200);

    const all = await get(ppic, `/api/bom-docs/customer/${customer.body.id}/export.xlsx?kind=all`);
    expect(all.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(all.body as unknown as ArrayBuffer);
    expect(wb.worksheets).toHaveLength(2); // the packaging sheet and the recipe sheet of this one product

    // Only R&D and PPIC; missing things are 404
    expect((await get(bd, `/api/bom-docs/pm/${sku.body.id}/export.xlsx`)).status).toBe(403);
    expect((await get(rnd, `/api/bom-docs/pm/${sku.body.id}/export.xlsx?version=9`)).status).toBe(404);
  });
});

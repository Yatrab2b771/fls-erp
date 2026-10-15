import { describe, expect, it } from "vitest";
import { parseCard, similarity, type OcrLine } from "./card-parser";

// Lines as an OCR engine would hand them over: top to bottom, with a confidence and a letter height (bigger lettering = bigger number).
function lines(...rows: (string | [string, number, number])[]): OcrLine[] {
  return rows.map((r, i) => {
    const [text, conf, height] = typeof r === "string" ? [r, 0.92, 40] : r;
    return { text, conf, height, top: i * 60 };
  });
}

describe("parseCard", () => {
  it("reads a normal pharma card", () => {
    const p = parseCard(
      lines(
        ["MEDIVITA", 0.9, 110],
        ["PHARMACEUTICALS PVT. LTD.", 0.9, 60],
        ["Dr. Neha Singh", 0.95, 70],
        "Product Manager",
        "M: +91 98215 67890",
        "E: neha.singh@medivita.com",
        "W: www.medivita.com",
        "A-12, BioTech Park, Knowledge City, Greater Noida, Uttar Pradesh - 201310, India",
      ),
    );
    expect(p.name).toBe("Dr. Neha Singh");
    expect(p.designation).toBe("Product Manager");
    expect(p.company).toBe("MEDIVITA PHARMACEUTICALS PVT. LTD.");
    expect(p.phones).toEqual(["+91 98215 67890"]);
    expect(p.email).toBe("neha.singh@medivita.com");
    expect(p.website).toBe("www.medivita.com");
    expect(p.address).toContain("Greater Noida");
    expect(p.address).toContain("201310");
    expect(p.confidence.email).toBeGreaterThan(0.9);
  });

  it("fixes the usual OCR slips in an email and a website", () => {
    const p = parseCard(lines("Amit Kumar", "Business Development Manager", "amit.kumar © wellifepharma.corn", "vvvw.wellifepharma.com", "Wellife Pharma Pvt. Ltd."));
    expect(p.email).toBe("amit.kumar@wellifepharma.com");
    expect(p.website).toBe("www.wellifepharma.com");
    expect(p.company).toBe("Wellife Pharma Pvt. Ltd.");
    expect(p.name).toBe("Amit Kumar");
  });

  it("takes several phone numbers, in any layout, once each, and leaves the landline alone", () => {
    const p = parseCard(lines("Rohit Verma", "Director", "Mob: 98765-43210 | 9876543210", "Tel: 011-4567 8901", "Fax: 011 4567 8999", "+91-99887 76655"));
    expect(p.phones).toEqual(["+91 98765 43210", "01145678901", "+91 99887 76655"]);
  });

  it("finds the GST number even with spaces and a label", () => {
    const p = parseCard(lines("GSTIN: 09 AABCM 1234 F1Z5", "Sunil Gupta", "Purchase Head"));
    expect(p.gstNo).toBe("09AABCM1234F1Z5");
    expect(p.designation).toBe("Purchase Head");
  });

  it("uses the email to choose the name when two lines look like names", () => {
    const p = parseCard(lines(["Innovative Health Solutions", 0.9, 50], ["Kavita Rao", 0.9, 45], "Senior Executive", "kavita.rao@healthco.in"));
    expect(p.name).toBe("Kavita Rao");
  });

  it("spells the company the way we already know it", () => {
    const p = parseCard(lines(["Nutra Fuell Labs", 0.7, 90], "Priya Jain", "General Manager", "priya@nutrafuel.in"), ["NutraFuel Labs Pvt Ltd", "Other Co"]);
    expect(p.company).toBe("NutraFuel Labs Pvt Ltd");
    expect(p.confidence.company).toBeGreaterThan(0.85);
  });

  it("makes an ALL CAPS name readable", () => {
    const p = parseCard(lines("VIKRAM SINGH RATHORE", "Managing Director", "9812345678"));
    expect(p.name).toBe("Vikram Singh Rathore");
    expect(p.phones).toEqual(["+91 98123 45678"]);
  });

  it("never invents what is not on the card", () => {
    const p = parseCard(lines("@@", "..."));
    expect(p).toMatchObject({ name: "", company: "", designation: "", email: "", website: "", address: "", gstNo: "", phones: [] });
    expect(Object.values(p.confidence).every((c) => c === 0)).toBe(true);
  });

  it("guesses a company from the website only as a last resort and marks it unsure", () => {
    const p = parseCard(lines("Anil Mehta", "Sales Manager", "anil@zenithherbs.com"));
    expect(p.company).toBe("Zenithherbs");
    expect(p.confidence.company).toBeLessThan(0.5);
  });

  it("does not take a tagline or a pincode for a phone or a company", () => {
    const p = parseCard(lines(["ZENITH HERBS PVT LTD", 0.9, 90], "Innovative Nutrition for a Healthy Future Every Single Day", "Plot 45, Sector 62, Noida 201309", "Sneha Roy", "Marketing Head"));
    expect(p.company).toBe("ZENITH HERBS PVT LTD");
    expect(p.phones).toEqual([]);
    expect(p.name).toBe("Sneha Roy");
  });
});

describe("similarity", () => {
  it("is 1 for the same text, high for a typo, low for different text", () => {
    expect(similarity("Medivita Pharma", "medivita  pharma")).toBe(1);
    expect(similarity("Medivita Pharma", "Medivlta Pharma")).toBeGreaterThan(0.9);
    expect(similarity("Medivita", "Zenith")).toBeLessThan(0.4);
  });
});

describe("parseCard: repairs", () => {
  it("repairs a GST number the OCR misread (2 for Z), but flags it as unsure", () => {
    const p = parseCard(lines("GSTIN: 09AABCZ1234F 125", "Sneha Roy"));
    expect(p.gstNo).toBe("09AABCZ1234F1Z5");
    expect(p.confidence.gstNo).toBeLessThanOrEqual(0.6);
  });

  it("reads 'www medivita.com' (a space for the dot) as a website", () => {
    expect(parseCard(lines("W: www medivita.com")).website).toBe("www.medivita.com");
  });

  it("trusts the website's spelling when the company name was cut short, and flags it", () => {
    const p = parseCard(lines(["ZENITH HE", 0.8, 80], "PRIVATE LIMITED", "Sneha Roy", "sneha.roy@zenithherbs.com"));
    expect(p.company).toBe("Zenithherbs PRIVATE LIMITED");
    expect(p.confidence.company).toBeLessThanOrEqual(0.6);
  });
});

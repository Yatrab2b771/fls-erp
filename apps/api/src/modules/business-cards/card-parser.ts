// Sorts the text read off a visiting card into fields. Pure functions (no OCR, no database), so every rule is easy to test.
//
// Some things are recognisable by their shape alone and are nearly always right: email, website, GST number, phone numbers.
// The rest is judged by what the line looks like and where it sits: designation (a job-title word), company (Pvt Ltd, Pharma, Labs... or a name
// we already know), address (road, sector, pincode, city), and the name (a short, person-like line that is none of the above, which matches the
// email's first part, or starts with Dr./Mr./Ms.).

export type OcrLine = { text: string; conf: number; height: number; top: number; left?: number; right?: number };

export const FIELDS = ["name", "designation", "company", "phone", "email", "website", "address", "gstNo"] as const;
export type Field = (typeof FIELDS)[number];

export type ParsedCard = {
  name: string;
  designation: string;
  company: string;
  phones: string[];
  email: string;
  website: string;
  address: string;
  gstNo: string;
  /** 0..1 per field: how sure we are. Empty field = 0. Under about 0.75 the screen asks the person to check it. */
  confidence: Record<Field, number>;
};

// ---------------------------------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------------------------------

const alnum = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** 1 = same, 0 = nothing alike (letters and digits only, case ignored). */
export function similarity(a: string, b: string): number {
  const x = alnum(a);
  const y = alnum(b);
  if (!x || !y) return 0;
  return 1 - levenshtein(x, y) / Math.max(x.length, y.length);
}

// "Medivita Pharma Pvt. Ltd." and "Medivita Pharma" are the same company: compare without the legal ending too.
const coreName = (s: string) => alnum(s.replace(/\b(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|co\.?)(?=\s|$)/gi, " "));
const companySimilarity = (a: string, b: string) => Math.max(similarity(a, b), similarity(coreName(a), coreName(b)));

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const titleCase = (s: string) => s.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase());

// ---------------------------------------------------------------------------------------------------------------------
// patterns
// ---------------------------------------------------------------------------------------------------------------------

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const WEBSITE_RE = /(?:https?:\/\/)?(?:www\.)[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/\S*)?|\b[A-Za-z0-9-]{2,}\.(?:com|in|co\.in|net|org|biz|info|io|co)\b(?:\/\S*)?/i;
const GST_RE = /\b\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]\b/;
const PIN_RE = /\b[1-9]\d{5}\b|\b[1-9]\d{2}\s\d{3}\b/;
const PHONE_RUN_RE = /\+?\(?\d[\d\s().-]{7,}\d/g;

// A label in front of a value ("Mob:", "E-mail -"). One-letter labels (M: E: W:) need a colon, so "A-12, Sector 5" keeps its "A-12".
const LABEL_RE = /^\s*(?:(?:e-?mail(?:\s*id)?|mail|mob(?:ile)?(?:\s*no)?|ph(?:one)?(?:\s*no)?|tel(?:ephone)?|cell|contact|whatsapp|web(?:site)?|url|fax|add(?:ress)?|regd\.?\s*office|reg\.?\s*office|office|works|factory|gst(?:in)?(?:\s*no)?)\s*[:.\-–—|]+|[etmwfap]\s*[:|]+)\s*/i;

const TITLE_PREFIX_RE = /^(?:dr|mr|mrs|ms|miss|shri|smt|prof|er|ca|cs|adv|capt|col)\.?\s+/i;

const DESIGNATION_RE =
  /\b(?:founder|co-?founder|chairman|chairperson|managing\s+director|director|ceo|cfo|coo|cto|cmo|md|president|vice\s+president|vp|avp|general\s+manager|gm|manager|executive|officer|head|lead|proprietor|partner|owner|consultant|sales|marketing|purchase|procurement|business\s+development|bd|r\s?&\s?d|quality|regulatory|production|supply\s+chain|engineer|analyst|scientist|specialist|associate|coordinator|supervisor|in-?charge|advisor|representative|trainee|intern)\b/i;
const STRONG_DESIGNATION_RE = /\b(?:founder|co-?founder|chairman|chairperson|managing\s+director|director|ceo|cfo|coo|cto|cmo|md|president|vice\s+president|vp|general\s+manager|manager|executive|officer|head|proprietor|partner|owner|consultant|engineer|scientist)\b/i;

const COMPANY_STRONG_RE = /\b(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|corp(?:oration)?|co\.|company)\b/i;
const COMPANY_WEAK_RE =
  /\b(?:pharma(?:ceuticals?)?|labs?|laborator(?:y|ies)|industries|industry|nutra(?:ceuticals?)?|healthcare|health\s?care|bio(?:tech|sciences?)?|enterprises?|exports?|imports?|foods?|ayurved(?:a|ic)|sciences?|life(?:sciences?|care)?|products|trading|traders|solutions|group|overseas|international|global|organics?|herbals?|wellness|nutrition|formulations?|drugs?|chemicals?|packaging|packers|remedies|care)\b/i;
const SUFFIX_ONLY_RE = /^(?:(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|corp(?:oration)?|co\.|company|pharma(?:ceuticals?)?|labs?|industries|healthcare|biotech|enterprises?|exports?|foods?|sciences?|products|trading|solutions|group|care|and|&)\s*)+$/i;

const ADDRESS_WORD_RE =
  /\b(?:plot|sector|sec|road|rd|street|st|floor|nagar|colony|near|opp|opposite|building|bldg|park|industrial|estate|area|phase|block|lane|marg|chowk|city|village|vill|dist|district|tehsil|state|india|h\.?\s?no|house|tower|complex|plaza|market|ganj|bazaar|knowledge|gali|mohalla|extn|extension|po|ward|survey|unit|gate|highway|nh)\b/i;
const PLACE_RE =
  /\b(?:uttar\s+pradesh|delhi|new\s+delhi|maharashtra|gujarat|haryana|punjab|rajasthan|karnataka|tamil\s+nadu|telangana|kerala|west\s+bengal|madhya\s+pradesh|uttarakhand|himachal(?:\s+pradesh)?|bihar|odisha|jharkhand|chhattisgarh|assam|goa|noida|greater\s+noida|gurgaon|gurugram|mumbai|pune|bangalore|bengaluru|hyderabad|chennai|kolkata|ahmedabad|baddi|haridwar|roorkee|indore|jaipur|lucknow|ghaziabad|faridabad|chandigarh|surat|vadodara|thane|nashik|nagpur|bhopal|kanpur|ludhiana|mohali|panchkula|solan|sonipat|panipat|rudrapur|dehradun|vapi|ankleshwar|daman|halol|navi\s+mumbai)\b/i;

const NOT_NAME_WORDS_RE = /\b(?:scan|visit|welcome|since|est|established|iso|gmp|certified|the|and|for|your|our|with|solutions?|pvt|ltd|limited|www|email|mobile|phone|tel|fax)\b/i;

// ---------------------------------------------------------------------------------------------------------------------
// the parser
// ---------------------------------------------------------------------------------------------------------------------

type Seg = { text: string; conf: number; height: number; top: number; idx: number; used: boolean };

function normaliseSegment(s: string): string {
  return s
    .replace(/^[^\p{L}\p{N}+(@]+/u, "") // icons / bullets the OCR read as symbols
    .replace(/[^\p{L}\p{N})./@%&]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function fixEmail(raw: string): string {
  let e = raw.toLowerCase().replace(/[,;]+$/, "");
  e = e.replace(/\.(con|corn|cam|comm|cpm|ccm)$/, ".com").replace(/\.(ln|il)$/, ".in");
  return e.replace(/\.+$/, "");
}

/** A GST number the OCR got slightly wrong (O for 0, 2 for Z...): fix each position by what it must be, then see if it fits the format. */
function repairGst(candidate: string): string | null {
  if (candidate.length !== 15) return null;
  const toDigit: Record<string, string> = { O: "0", Q: "0", D: "0", I: "1", L: "1", S: "5", B: "8", Z: "2", G: "6" };
  const toLetter: Record<string, string> = { "0": "O", "1": "I", "5": "S", "8": "B", "2": "Z", "6": "G" };
  const fixed = [...candidate]
    .map((c, i) => {
      if (i < 2 || (i >= 7 && i < 11)) return /\d/.test(c) ? c : (toDigit[c] ?? c);
      if ((i >= 2 && i < 7) || i === 11) return /[A-Z]/.test(c) ? c : (toLetter[c] ?? c);
      if (i === 13) return "Z";
      return c;
    })
    .join("");
  return GST_RE.test(fixed) ? fixed : null;
}

function formatPhone(raw: string): string | null {
  const plus = raw.trim().startsWith("+");
  let d = raw.replace(/\D/g, "");
  if (d.length < 10 || d.length > 13) return null;
  if (d.length === 13 && d.startsWith("091")) d = d.slice(1);
  if (d.length === 12 && d.startsWith("91") && /[6-9]/.test(d[2]!)) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  if (d.length === 11 && d.startsWith("0") && /[6-9]/.test(d[1]!)) return `+91 ${d.slice(1, 6)} ${d.slice(6)}`;
  if (d.length === 10 && /[6-9]/.test(d[0]!)) return `+91 ${d.slice(0, 5)} ${d.slice(5)}`;
  if (plus) return `+${d}`;
  return d.length >= 10 ? d : null; // landline with its area code, kept as digits
}

export function parseCard(lines: OcrLine[], knownCompanies: string[] = []): ParsedCard {
  const confidence = Object.fromEntries(FIELDS.map((f) => [f, 0])) as Record<Field, number>;
  const out: ParsedCard = { name: "", designation: "", company: "", phones: [], email: "", website: "", address: "", gstNo: "", confidence };

  // 1. One segment per piece: a line like "Mob: 98.. | neha@x.com" becomes two.
  const segs: Seg[] = [];
  lines.forEach((l, i) => {
    if ((l.text.match(/[A-Za-z0-9]/g) ?? []).length < 2) return; // Hindi-only or symbol-only lines never become a field here
    for (const part of l.text.split(/\s+[|•·●■▪]\s+|[|•·●■▪]|;/)) {
      const text = normaliseSegment(part);
      if (text.replace(/[^\p{L}\p{N}]/gu, "").length >= 2) segs.push({ text, conf: l.conf, height: l.height, top: l.top, idx: i, used: false });
    }
  });

  // 2. Shape-based fields: email, GST, website, phones. Each match is cut out of its segment so what remains can still be sorted.
  const phoneConfs: number[] = [];
  for (const s of segs) {
    let t = s.text.replace(LABEL_RE, "");

    // email (the OCR often reads @ as © or puts spaces round it)
    const spaced = t.replace(/\s*(?:@|©|\(at\)|\[at\])\s*/gi, "@").replace(/(\w)\s*\.\s*(?=[a-z]{2,}\b)/gi, "$1.");
    const em = EMAIL_RE.exec(spaced);
    if (em && !out.email) {
      out.email = fixEmail(em[0]);
      confidence.email = clamp01(0.6 + 0.4 * s.conf);
      t = spaced.replace(em[0], " ");
      s.used = true;
    } else if (em) {
      t = spaced.replace(em[0], " ");
    }

    // GST
    const compact = t.toUpperCase().replace(/[\s-]+/g, "");
    const gst = GST_RE.exec(compact);
    if (gst && !out.gstNo) {
      out.gstNo = gst[0];
      confidence.gstNo = clamp01(0.7 + 0.3 * s.conf);
      s.used = true;
      t = "";
    } else if (!out.gstNo && /gst/i.test(s.text)) {
      // labelled GST but not a perfect number: try repairing a 15-character run, and flag it
      const run = /[A-Z0-9]{15}/.exec(compact.replace(/^.*?GST(?:IN)?(?:NO)?[:.]?/, ""));
      const fixed = run ? repairGst(run[0]) : null;
      if (fixed) {
        out.gstNo = fixed;
        confidence.gstNo = Math.min(0.6, clamp01(0.4 + 0.3 * s.conf));
        s.used = true;
        t = "";
      }
    }

    // website (not the part of an email)
    if (t.trim()) {
      const fixedWww = t.replace(/\b[vw]{3,4}\s*[.\s](?=[a-z0-9-]+\.[a-z])/i, "www.");
      const web = WEBSITE_RE.exec(fixedWww);
      if (web && !out.website && !/@/.test(fixedWww)) {
        out.website = web[0].replace(/^https?:\/\//i, "").replace(/[/.,]+$/, "").toLowerCase();
        confidence.website = clamp01(0.55 + 0.45 * s.conf);
        s.used = true;
        t = fixedWww.replace(web[0], " ");
      }
    }

    // phones
    if (t.trim() && !/\bfax\b/i.test(s.text)) {
      for (const run of t.match(PHONE_RUN_RE) ?? []) {
        const p = formatPhone(run);
        if (p && !out.phones.some((x) => x.replace(/\D/g, "").slice(-10) === p.replace(/\D/g, "").slice(-10))) {
          out.phones.push(p);
          phoneConfs.push(clamp01(0.55 + 0.45 * s.conf));
          s.used = true;
        }
      }
    }
  }
  if (out.phones.length) confidence.phone = Math.min(...phoneConfs);

  const free = segs.filter((s) => !s.used);

  // 3. Company: a name we already know, else a line with Pvt Ltd / Pharma / Labs...
  const knownNorm = knownCompanies.map((k) => k.trim()).filter((k) => k.length > 2);
  let companySeg: Seg | null = null;
  let bestScore = 0;
  for (const s of free) {
    if (s.text.split(" ").length > 7) continue; // a tagline, not a company name
    let sc = 0;
    let canonical: string | null = null;
    for (const k of knownNorm) {
      const sim = companySimilarity(s.text, k);
      const contains = alnum(s.text).includes(alnum(k)) && alnum(k).length >= 5;
      if (sim >= 0.82 || contains) {
        sc = Math.max(sc, 4 + sim);
        canonical = k;
      }
    }
    if (COMPANY_STRONG_RE.test(s.text)) sc = Math.max(sc, 3);
    else if (COMPANY_WEAK_RE.test(s.text) && !STRONG_DESIGNATION_RE.test(s.text)) sc = Math.max(sc, 1);
    if (/^[\d\s()+.-]+$/.test(s.text)) sc = 0;
    if (sc === 0) continue;
    if (STRONG_DESIGNATION_RE.test(s.text) && !COMPANY_STRONG_RE.test(s.text) && !canonical) continue;
    sc += Math.min(1, s.height / 120) * 0.8 - s.idx * 0.01; // bigger lettering and nearer the top win ties
    if (sc > bestScore) {
      bestScore = sc;
      companySeg = s;
      (s as Seg & { canonical?: string | null }).canonical = canonical;
    }
  }
  if (companySeg) {
    const cs: Seg & { canonical?: string | null } = companySeg;
    let text = cs.text;
    // "PHARMACEUTICALS PVT. LTD." printed under the real name: join them.
    if (SUFFIX_ONLY_RE.test(text) || text.split(" ").length <= 2) {
      const above = free.filter((s) => s.idx < cs.idx && !s.used).sort((a, b) => b.idx - a.idx)[0];
      if (above && SUFFIX_ONLY_RE.test(text) && above.idx === cs.idx - 1 && above.text.split(" ").length <= 4 && above.conf >= 0.6 && /\p{L}{4,}/u.test(above.text) && !DESIGNATION_RE.test(above.text)) {
        text = `${above.text} ${text}`;
        above.used = true;
      }
    }
    const canonical = cs.canonical;
    out.company = canonical && companySimilarity(text, canonical) >= 0.82 ? canonical : text.replace(/\s+/g, " ").trim();
    confidence.company = canonical ? clamp01(0.85 + 0.15 * cs.conf) : clamp01(cs.conf * (COMPANY_STRONG_RE.test(text) ? 1 : 0.85));
    cs.used = true;
    // The name was misread ("ZENITH HE" for "ZENITH HERBS"): if what we read is the start of the website's name, trust the website's spelling.
    const siteHost = (out.website || out.email.split("@")[1] || "").replace(/^www\./, "").split(".")[0] ?? "";
    const legalEnd = /\b(?:pvt\.?|private|ltd\.?|limited|llp|inc\.?|co\.?)(?=\s|$)/gi;
    const core = alnum(out.company.replace(legalEnd, " "));
    // Nothing but junk before the ending ("j eee PHARMACEUTICALS PVT. LTD."): use the website's name instead.
    const namePart = out.company.replace(legalEnd, " ").split(/\s+/).filter((w) => w && !SUFFIX_ONLY_RE.test(w)).join("");
    if (!canonical && siteHost && alnum(namePart).length < 4) {
      out.company = `${titleCase(siteHost)} ${out.company.split(/\s+/).filter((w) => SUFFIX_ONLY_RE.test(w)).join(" ")}`.trim();
      confidence.company = Math.min(confidence.company, 0.5);
    }
    if (!canonical && siteHost.length > core.length && core.length >= 4 && alnum(siteHost).startsWith(core)) {
      const ending = (out.company.match(legalEnd) ?? []).join(" ");
      out.company = `${titleCase(siteHost)} ${ending}`.trim();
      confidence.company = Math.min(confidence.company, 0.6);
    }
    // Only the ending was read ("PHARMACEUTICALS PVT. LTD."): the name part was probably big logo lettering. Offer the website's name, flagged.
    if (!canonical && SUFFIX_ONLY_RE.test(out.company)) {
      const host = (out.website || out.email.split("@")[1] || "").replace(/^www\./, "").split(".")[0] ?? "";
      if (host && !/^(gmail|yahoo|outlook|hotmail|rediffmail|icloud|protonmail)$/.test(host)) {
        out.company = `${titleCase(host)} ${out.company}`;
        confidence.company = Math.min(confidence.company, 0.5);
      } else confidence.company = Math.min(confidence.company, 0.5);
    }
  }

  // 4. Designation: a job-title word on a line that is not the company.
  const desig = free.filter((s) => !s.used && DESIGNATION_RE.test(s.text) && s.text.split(" ").length <= 7 && !PIN_RE.test(s.text) && !ADDRESS_WORD_RE.test(s.text));
  if (desig.length) {
    desig.sort((a, b) => (STRONG_DESIGNATION_RE.test(b.text) ? 1 : 0) - (STRONG_DESIGNATION_RE.test(a.text) ? 1 : 0) || a.idx - b.idx);
    const first = desig[0]!;
    const parts = [first];
    const next = desig.find((s) => s !== first && Math.abs(s.idx - first.idx) === 1 && s.text.split(" ").length <= 5);
    if (next) parts.push(next);
    parts.sort((a, b) => a.idx - b.idx);
    out.designation = parts.map((p) => p.text).join(", ");
    confidence.designation = clamp01(Math.min(...parts.map((p) => p.conf)) * (STRONG_DESIGNATION_RE.test(first.text) ? 1 : 0.8));
    for (const p of parts) p.used = true;
  }

  // 5. Address: lines with a road/sector word, a city/state or a pincode, plus the line that finishes it.
  const pinOnly = (t: string) => /^\s*-?\s*[1-9]\d{2}\s?\d{3}\s*$/.test(t); // a pincode the OCR put on a line of its own
  const addrSegs = free.filter((s) => !s.used && (s.conf >= 0.4 || PIN_RE.test(s.text)) && (PIN_RE.test(s.text) || ADDRESS_WORD_RE.test(s.text) || PLACE_RE.test(s.text)) && s.text.length >= 4 && (!/^[\d\s()+.-]+$/.test(s.text) || pinOnly(s.text)));
  if (addrSegs.length) {
    addrSegs.sort((a, b) => a.idx - b.idx);
    const joined = addrSegs.reduce((acc, s, i) => {
      const t = s.text.replace(LABEL_RE, "").replace(/[,\s]+$/, "");
      return i === 0 ? t : pinOnly(t) ? `${acc} - ${t.replace(/[-\s]/g, "").replace(/^(\d{3})(\d{3})$/, "$1$2")}` : `${acc}, ${t}`;
    }, "");
    out.address = joined.replace(/\s+,/g, ",").replace(/,{2,}/g, ",");
    confidence.address = clamp01((addrSegs.reduce((a, s) => a + s.conf, 0) / addrSegs.length) * (PIN_RE.test(joined) ? 1 : 0.85));
    for (const s of addrSegs) s.used = true;
  }

  // 6. Name: a short, person-like line left over.
  const localTokens = out.email
    ? out.email
        .split("@")[0]!
        .split(/[._\-\d]+/)
        .filter((t) => t.length >= 3)
    : [];
  type Cand = { seg: Seg; score: number };
  const cands: Cand[] = [];
  for (const s of free) {
    if (s.used) continue;
    const text = s.text.replace(/[|_~=]/g, " ").replace(/\s+/g, " ").trim();
    const title = TITLE_PREFIX_RE.test(text);
    const body = text.replace(TITLE_PREFIX_RE, "");
    const words = body.split(" ").filter(Boolean);
    if (words.length < (title ? 1 : 2) || words.length > 4) continue;
    if (!words.every((w) => /^[\p{L}][\p{L}.'-]*$/u.test(w))) continue;
    if (text.length > 40 || NOT_NAME_WORDS_RE.test(body)) continue;
    if (COMPANY_STRONG_RE.test(text) || (COMPANY_WEAK_RE.test(text) && !title)) continue;
    let score = 1;
    if (title) score += 3;
    const lower = text.toLowerCase();
    if (localTokens.some((t) => lower.includes(t) || words.some((w) => similarity(w, t) >= 0.8))) score += 3;
    if (words.every((w) => /^[A-Z][a-z.'-]*$/.test(w) || /^[A-Z.]+$/.test(w))) score += 1;
    score += Math.min(1, s.height / 120) - s.idx * 0.05;
    cands.push({ seg: s, score });
  }
  if (cands.length) {
    cands.sort((a, b) => b.score - a.score);
    const best = cands[0]!;
    out.name = best.seg.text.replace(/[|_~=]/g, " ").replace(/\s+/g, " ").trim();
    if (out.name === out.name.toUpperCase()) out.name = titleCase(out.name);
    confidence.name = clamp01(best.seg.conf * (best.score >= 4 ? 1 : best.score >= 2 ? 0.85 : 0.65));
    best.seg.used = true;
  } else if (localTokens.length >= 2) {
    out.name = titleCase(localTokens.join(" ")); // last resort: from the email, flagged as unsure
    confidence.name = 0.3;
  }

  // 6b. No company line found: the largest lettering left over is usually the logo name. Offered, flagged as unsure.
  if (!out.company) {
    const logo = free
      .filter((s) => !s.used && s.conf >= 0.6 && alnum(s.text).length >= 4 && s.text.split(" ").length <= 4 && /^[\p{L}\p{N} .&'-]+$/u.test(s.text))
      .sort((a, b) => b.height - a.height)[0];
    if (logo) {
      out.company = logo.text;
      confidence.company = Math.min(0.45, logo.conf);
      logo.used = true;
    }
  }

  // 7. Company fallback: the website / email domain, flagged as unsure.
  if (!out.company) {
    const host = (out.website || out.email.split("@")[1] || "").replace(/^www\./, "").split(".")[0] ?? "";
    if (host && !/^(gmail|yahoo|outlook|hotmail|rediffmail|icloud|protonmail)$/.test(host)) {
      out.company = titleCase(host);
      confidence.company = 0.3;
    }
  }

  return out;
}

/** One number for "how good does this reading look": the more of the main fields found with good confidence, the higher. */
export function scoreParsed(p: ParsedCard, _lines: OcrLine[]): number {
  const w: Record<Field, number> = { name: 0.25, company: 0.2, email: 0.15, phone: 0.2, designation: 0.08, address: 0.07, website: 0.03, gstNo: 0.02 };
  let total = 0;
  for (const f of FIELDS) total += w[f] * p.confidence[f];
  return total;
}

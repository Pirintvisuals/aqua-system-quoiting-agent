// ============================================================================
//  AQUA SYSTEM SERVICE KFT. — Árajánló asszisztens (gas boiler quoting agent)
//  - The conversation is TEMPLATE-DRIVEN: when the customer clicks an answer
//    button (or types something we can map), the backend records it and writes
//    the next question itself — no model call, so every click is instant.
//  - The AI model (OpenAI / Gemini) is only called when the customer types
//    something free-form: a side question, or an answer we can't map.
//  - Pricing is computed DETERMINISTICALLY from the PRICES table below. The AI
//    never does arithmetic, so the total can never be miscalculated.
//  - The price is shown as a FLOOR ("induló ár ... Ft-tól") with every
//    unknown spelled out as a named surcharge, never as a range.
// ============================================================================

// ---------------------------------------------------------------------------
//  PRICE TABLE (HUF) — single source of truth. Edit numbers here only.
//  Source: the company's price sheet (milan.xlsx).
// ---------------------------------------------------------------------------
const PRICES = {
    // Mit kell LESZERELNI? Egy hagyományos (nyílt égésterű / turbós) készülék
    // kéménye NEM alkalmas kondenzációs kazánhoz, ott saválló bélelés kell
    // (lásd `chimney_conversion`). "nem_tudom" => legolcsóbb feltételezés.
    old_boiler: {
        kondenzacios: { huf: 0,     label: "Leszerelendő készülék: kondenzációs" },
        hagyomanyos:  { huf: 60000, label: "Leszerelendő készülék: hagyományos (nyílt égésterű vagy turbós)" },
        nem_tudom:    { huf: 0,     label: "Leszerelendő készülék: a felmérésnél pontosítjuk" },
    },
    // CSAK akkor kerül a tételek közé, ha a régi készülék HAGYOMÁNYOS volt.
    // ÁRAT ELLENŐRIZNI: irányár, írd át az Aqua System saját árára.
    chimney_conversion: { huf: 260000, label: "Kéményátalakítás kondenzációs kazánhoz (saválló béléscső)" },

    // Új kazán — KIZÁRÓLAG kondenzációs. "nem_tudom" => a legolcsóbb (kombi).
    new_boiler: {
        kombi_24:   { huf: 450000, label: "Kondenzációs kombi gázkészülék, 24 kW" },
        tarolos_46: { huf: 900000, label: "Kondenzációs tárolós gázkészülék, beépített 46 literes tárolóval, 24 kW" },
        kulso_125:  { huf: 900000, label: "Kondenzációs fűtőkazán, 24 kW + külső 125 literes tároló" },
        nem_tudom:  { huf: 450000, label: "Kondenzációs kombi gázkészülék, 24 kW (alap — a felmérésnél pontosítjuk)" },
    },
    // Kémény / égéstermék-elvezetés. "nem_tudom" => a legolcsóbb (tetőn át).
    flue: {
        teto:         { huf: 380000, label: "Kéménykivezetés a tetőn keresztül (kazántól indulva)" },
        tegla_kemeny: { huf: 600000, label: "Bekötés épített tégla kéménybe" },
        gyujtokemeny: { huf: 600000, label: "Társasházi gyűjtőkémény bekötés" },
        nem_tudom:    { huf: 380000, label: "Kéménykivezetés a tetőn keresztül (alap — a felmérésnél pontosítjuk)" },
    },
    // Életvédelmi (Fi) relé. A laikus ügyfél ezt nem tudja megválaszolni, ezért
    // NEM kérdezzük: az induló ár a "van" esettel számol, a különbözet a
    // "nincs benne" listán szerepel.
    rcd: {
        van:   { huf: 50000,  label: "Életvédelmi (Fi) relé ellenőrzése és bekötése" },
        nincs: { huf: 100000, label: "Életvédelmi (Fi) relé kiépítése" },
    },
    // Garancia — nem kérdés, hanem választható a kész ajánlaton.
    // ÁRAT ELLENŐRIZNI: irányárak, írd át az Aqua System saját áraira.
    warranty: {
        w_2:  { huf: 0,      label: "Garancia: 2 év (gyári alapgarancia)" },
        w_5:  { huf: 60000,  label: "Kiterjesztett garancia: 5 év" },
        w_10: { huf: 150000, label: "Kiterjesztett garancia: 10 év" },
    },
    // Mindig felszámolt standard tételek
    standard: {
        wet_system:    { huf: 300000, label: "Vizes rendszerre kötés mágneses iszapleválasztóval (anyag + munkadíj)" },
        commissioning: { huf: 50000,  label: "Gázkazán gyári üzembe helyezése" },
    },
    demolition: { huf: 90000, label: "Régi kazán és kémény bontása" },
};

// Offer to e-mail the quote to the CUSTOMER. Requires a VERIFIED sending domain
// in Resend — until that exists, keep this OFF (EMAIL_OFFER=on in .env).
const EMAIL_OFFER_ENABLED =
    (process.env.EMAIL_OFFER || "").toLowerCase() === "on";

const PHONE = "+36 20 399 0093";
const COMPANY_EMAIL = "keszulekcsere@aqua-system.hu";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
//  Service area. Budapest (1xxx) plus the agglomeration towns below. This is a
//  SOFT check: a postal code outside the list never blocks the quote, it only
//  adds a note for the customer and a flag on the owner's e-mail. Add codes
//  here if Aqua System covers more towns.
// ---------------------------------------------------------------------------
const AGGLO_POSTAL_CODES = new Set([
    "2000", "2011", "2013", "2021", "2030", "2038", "2040", "2045", "2049",
    "2051", "2053", "2071", "2072", "2083", "2084", "2085", "2089", "2090",
    "2092", "2093", "2094", "2096", "2097", "2100", "2111", "2112", "2119",
    "2120", "2131", "2132", "2141", "2142", "2143", "2144", "2146", "2151",
    "2162", "2220", "2225", "2230", "2233", "2234", "2310", "2314", "2315",
    "2316", "2330", "2335", "2336", "2351", "2360", "2364", "2440", "2461",
]);

function classifyArea(postal) {
    const p = String(postal || "").trim();
    if (!/^\d{4}$/.test(p)) return "unknown";
    if (p[0] === "1") return "budapest";
    if (AGGLO_POSTAL_CODES.has(p)) return "agglo";
    return "outside";
}

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function formatHuf(n) {
    // 450000 -> "450 000 Ft"
    return n.toLocaleString("hu-HU").replace(/\s/g, " ") + " Ft";
}

function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
}

const filled = (s, k) => s && s[k] != null && String(s[k]).trim() !== "";

// Which block of the breakdown a line belongs to, in the order they are shown.
const SECTIONS = [
    ["keszulek", "A készülék"],
    ["kemeny", "Kémény és égéstermék-elvezetés"],
    ["bontas", "Bontás és elszállítás"],
    ["szereles", "Szerelés és üzembe helyezés"],
    ["garancia", "Garancia"],
];

function buildQuote(sel) {
    const items = [];
    const add = (entry, sec) => { if (entry) items.push({ label: entry.label, huf: entry.huf, sec }); };

    add(PRICES.old_boiler[sel.old_boiler] || PRICES.old_boiler.nem_tudom, "bontas");
    add(PRICES.new_boiler[sel.new_boiler] || PRICES.new_boiler.nem_tudom, "keszulek");
    add(PRICES.flue[sel.flue] || PRICES.flue.nem_tudom, "kemeny");
    if (sel.old_boiler === "hagyomanyos") add(PRICES.chimney_conversion, "kemeny");
    add(PRICES.rcd.van, "szereles");
    add(PRICES.warranty[sel.warranty] || PRICES.warranty.w_2, "garancia");

    add(PRICES.standard.wet_system, "szereles");
    add(PRICES.standard.commissioning, "szereles");
    add(PRICES.demolition, "bontas");

    const total = items.reduce((s, i) => s + i.huf, 0);
    return { items, total };
}

// Everything the floor price does NOT include, with the exact surcharge where
// we know it. "Nem tudom" answers add the difference to the dearer variant, so
// the customer sees up front what the survey could add — and never hears
// "de a kalkulátor mást mondott".
function surchargeLines(sel) {
    const out = [];
    if (sel.old_boiler === "nem_tudom") {
        const d = PRICES.old_boiler.hagyomanyos.huf + PRICES.chimney_conversion.huf;
        out.push(`Ha a régi készülék hagyományos: kéményátalakítással együtt **+${formatHuf(d)}**`);
    }
    if (sel.new_boiler === "nem_tudom") {
        const d = PRICES.new_boiler.tarolos_46.huf - PRICES.new_boiler.kombi_24.huf;
        out.push(`Ha tárolós készülék kell a kombi helyett: **+${formatHuf(d)}**`);
    }
    if (sel.flue === "nem_tudom") {
        const d = PRICES.flue.tegla_kemeny.huf - PRICES.flue.teto.huf;
        out.push(`Ha kéménybe kell kötni a tetőn át helyett: **+${formatHuf(d)}**`);
    }
    out.push(`Ha nincs életvédelmi (Fi) relé, a kiépítése: **+${formatHuf(PRICES.rcd.nincs.huf - PRICES.rcd.van.huf)}**`);
    return out;
}

// Backend decides when the quote is complete — independent of the AI model.
// E-mail is optional: the owner calls, so the phone number is what matters.
const REQUIRED = ["old_boiler", "occupants", "new_boiler", "flue", "photos", "timeline",
    "name", "phone", "postal_code"];
function isQuoteReady(s) {
    if (!s || typeof s !== "object") return false;
    return REQUIRED.every((k) => filled(s, k));
}

// Quick-reply buttons for each choice question.
const CHIP_MAP = {
    old_boiler: ["Kondenzációs", "Hagyományos", "Nem tudom"],
    occupants: ["1–2 fő", "3–4 fő", "5 vagy több", "Nem tudom"],
    new_boiler: ["Kombi (24 kW)", "Tárolós (46 l)", "Külső tároló (125 l)", "Nem tudom"],
    flue: ["Tetőn keresztül", "Tégla kéménybe", "Társasházi gyűjtőkémény", "Nem tudom"],
    timeline: ["Amint lehet", "Egy hónapon belül", "Fél éven belül", "Még idén", "Még nem tudom"],
};

// Order the questions are asked in. "photos" is an optional step (upload or
// skip); the contact details come last, as one form.
const FIELD_ORDER = ["old_boiler", "occupants", "new_boiler", "flue", "photos", "timeline",
    "name", "phone", "postal_code"];

// The steps that count toward the progress bar.
const PROGRESS_FIELDS = ["old_boiler", "occupants", "new_boiler", "flue", "photos", "timeline"];

// Clicked chip label -> canonical value, per field (lower-cased keys).
const CHIP_VALUES = {
    old_boiler: { "kondenzációs": "kondenzacios", "hagyományos": "hagyomanyos", "nem tudom": "nem_tudom" },
    occupants: { "1–2 fő": "o_1_2", "3–4 fő": "o_3_4", "5 vagy több": "o_5plus", "nem tudom": "nem_tudom" },
    new_boiler: { "kombi (24 kw)": "kombi_24", "tárolós (46 l)": "tarolos_46", "külső tároló (125 l)": "kulso_125", "nem tudom": "nem_tudom" },
    flue: { "tetőn keresztül": "teto", "tégla kéménybe": "tegla_kemeny", "társasházi gyűjtőkémény": "gyujtokemeny", "nem tudom": "nem_tudom" },
    timeline: {
        "amint lehet": "t_asap",
        "egy hónapon belül": "t_month",
        "fél éven belül": "t_halfyear",
        "még idén": "t_thisyear",
        "még nem tudom": "t_unsure",
    },
};

// Short typed answers we can map without the model ("kombi", "3", "társasház").
// Only applied to SHORT replies with no question mark, so "mi a különbség a
// kombi és a tárolós között?" still goes to the model as a question.
const SYNONYMS = {
    old_boiler: [
        [/kondenz/, "kondenzacios"],
        [/hagyom|nyílt|nyilt|turb|régi|regi|kéményes|kemenyes/, "hagyomanyos"],
    ],
    occupants: [
        [/^(1|2|egy|kett|ketten|egyedül|egyedul)\b/, "o_1_2"],
        [/^(3|4|három|harom|négy|negy|hárman|harman|négyen|negyen)\b/, "o_3_4"],
        [/^([5-9]|1\d|öt|ot|hat|hét|het|nyolc|öten|oten|hatan|sokan)\b/, "o_5plus"],
    ],
    new_boiler: [
        [/kombi/, "kombi_24"],
        [/125|külső|kulso/, "kulso_125"],
        [/tárol|tarol|46/, "tarolos_46"],
    ],
    flue: [
        [/tető|teto|tetőn|teton/, "teto"],
        [/gyűjtő|gyujto|társash|tarsash|közös|kozos/, "gyujtokemeny"],
        [/tégla|tegla|kémény|kemeny/, "tegla_kemeny"],
    ],
    timeline: [
        [/azonnal|sürgős|surgos|minél|minel|asap|amint/, "t_asap"],
        [/hónap|honap|hét|het\b/, "t_month"],
        [/fél év|fel ev|tavasz|nyár|nyar/, "t_halfyear"],
        [/idén|iden|ősz|osz|tél|tel\b/, "t_thisyear"],
    ],
};
const UNSURE_RE = /^(nem tudom|nemtudom|fogalmam sincs|nem tudom pontosan|nem vagyok biztos|passz)\.?$/;

function pendingField(sel) {
    for (const f of FIELD_ORDER) {
        if (!filled(sel, f)) return f;
    }
    return null;
}

// Given the field the customer is answering + their message, return the
// canonical value, or null when it needs the model to interpret.
function mapAnswer(field, answer) {
    if (typeof answer !== "string" || !answer.trim()) return null;
    const a = answer.trim();
    const low = a.toLowerCase();

    if (field === "photos") {
        const m = low.match(/^(\d)\s*fot/);
        if (m) return m[1];
        if (/^(kihagyom|kihagy|most nem|nincs|nem)\b/.test(low)) return "0";
        return null;
    }
    if (CHIP_VALUES[field]) {
        if (CHIP_VALUES[field][low]) return CHIP_VALUES[field][low];
        const short = low.split(/\s+/).length <= 4 && !low.includes("?");
        if (!short) return null;
        if (UNSURE_RE.test(low)) return field === "timeline" ? "t_unsure" : "nem_tudom";
        for (const [re, v] of SYNONYMS[field] || []) if (re.test(low)) return v;
        return null;
    }
    // Typed contact details (only when the customer ignores the form): accept
    // them only when they look like the thing asked, so a question typed at
    // this point is not stored as somebody's name.
    if (field === "name") return a.split(/\s+/).length <= 4 && !/[?\d@]/.test(a) ? a : null;
    if (field === "phone") return a.replace(/\D/g, "").length >= 7 && !/[a-z]{3,}/i.test(a) ? a : null;
    if (field === "postal_code") { const m = a.match(/\b(\d{4})\b/); return m ? m[1] : null; }
    if (field === "email") return EMAIL_RE.test(a) ? a : null;
    return null;
}

// Parse the hidden running-state block out of any assistant message.
function extractData(text) {
    if (typeof text !== "string") return null;
    const m = text.match(/<!--DATA:(.*?)-->/s);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
}

// Merge several state objects, keeping the last NON-EMPTY value per field.
function mergeState(...states) {
    const out = {};
    for (const s of states) {
        if (!s || typeof s !== "object") continue;
        for (const k of Object.keys(s)) {
            const v = s[k];
            if (v != null && typeof v !== "object" && String(v).trim() !== "") out[k] = String(v);
        }
    }
    return out;
}

// Human-readable labels for the recap.
const LABELS = {
    old_boiler: { kondenzacios: "Kondenzációs", hagyomanyos: "Hagyományos (nem kondenzációs)", nem_tudom: "Nem tudja (felmérésnél pontosítjuk)" },
    occupants: { o_1_2: "1–2 fő", o_3_4: "3–4 fő", o_5plus: "5 vagy több", nem_tudom: "Nem tudja" },
    new_boiler: { kombi_24: "Kondenzációs kombi (24 kW)", tarolos_46: "Kondenzációs tárolós, 46 l (24 kW)", kulso_125: "Kondenzációs + külső tároló, 125 l (24 kW)", nem_tudom: "Nem tudja (alap: kombi)" },
    flue: { teto: "Tetőn keresztül", tegla_kemeny: "Tégla kéménybe", gyujtokemeny: "Társasházi gyűjtőkémény", nem_tudom: "Nem tudja (alap: tetőn át)" },
    warranty: { w_2: "2 év (gyári alap)", w_5: "5 év", w_10: "10 év" },
    timeline: {
        t_asap: "Amint lehet",
        t_month: "Egy hónapon belül",
        t_halfyear: "Fél éven belül",
        t_thisyear: "Még idén",
        t_unsure: "Még nem tudja",
    },
};
const lbl = (group, key) => (LABELS[group] && LABELS[group][key]) || key || "—";

// Drop any choice-field value the model invents that isn't a known value.
function sanitizeChoices(s) {
    if (!s || typeof s !== "object") return s;
    for (const field of Object.keys(LABELS)) {
        const v = s[field];
        if (v != null && String(v).trim() !== "" && !(String(v) in LABELS[field])) delete s[field];
    }
    if (s.photos != null && !/^\d$/.test(String(s.photos))) delete s.photos;
    return s;
}

const photosLabel = (sel) => {
    const n = Number(sel.photos || 0);
    return n > 0 ? `${n} db csatolva` : "Nem küldött";
};

// ---------------------------------------------------------------------------
//  Question templates — what the bot says when it asks each field. They follow
//  the same scannable format the model is told to use: short acknowledgement,
//  the question in bold on its own line, then at most three bullets.
// ---------------------------------------------------------------------------
const ACKS = ["Rendben.", "Értem.", "Köszönöm!", "Szuper.", "Rendben."];

const RECOMMEND = {
    o_1_2: "1–2 főhöz általában a **kombi** is bőven elég.",
    o_3_4: "3–4 főhöz a **tárolós (46 l)** a kényelmes választás.",
    o_5plus: "5 vagy több főhöz a **külső 125 literes** tárolót ajánljuk.",
};
const RECOMMEND_CHIP = { o_1_2: "Kombi (24 kW)", o_3_4: "Tárolós (46 l)", o_5plus: "Külső tároló (125 l)" };

function questionText(field, sel) {
    switch (field) {
        case "old_boiler":
            return [
                "**Milyen készüléket kell leszerelni?**",
                "• **Kondenzációs** – modern, műanyag füstcsővel",
                "• **Hagyományos** – régi, nyílt égésterű vagy turbós",
                "• Ha nem biztos, nyomja a **Nem tudom** gombot",
            ].join("\n");
        case "occupants":
            return [
                "**Hányan laknak a lakásban?**",
                "• Ebből tudjuk, mennyi **melegvíz** kell",
                "• Ez alapján ajánljuk a **készülék típusát**",
            ].join("\n");
        case "new_boiler": {
            const lines = ["**Milyen új készüléket szeretne?**", "Mindegyik **kondenzációs**."];
            if (RECOMMEND[sel.occupants]) lines.push(RECOMMEND[sel.occupants]);
            lines.push(
                "• **Kombi (24 kW)** – azonnal melegít, kis helyigény",
                "• **Tárolós 46 l** – több melegvíz egyszerre",
                "• **Külső 125 l** – nagy családnak",
            );
            return lines.join("\n");
        }
        case "flue":
            return [
                "**Hova vezet most a kazán füstcsöve?**",
                "• **Tetőn keresztül** – a csövet a tetőn vezették ki",
                "• **Tégla kéménybe** – családi ház, épített kémény",
                "• **Gyűjtőkémény** – társasházi, közös kémény",
            ].join("\n");
        case "photos":
            return [
                "**Lefotózná a mostani kazánt?**",
                "• **Elölről** – ha látszik, a típustáblával együtt",
                "• **A füstcsövet** – hová megy ki",
                "• Nem kötelező, de így a kolléga **előre felkészül**",
            ].join("\n");
        case "timeline":
            return "**Mikorra szeretné a cserét?**";
        case "name":
            return [
                "Köszönöm, minden megvan a kalkulációhoz!",
                "",
                "**Már csak az elérhetőségei kellenek.**",
                "• Ezen a számon egyeztetjük az **ingyenes felmérést**",
                "• Utána **azonnal látja** az induló árat",
            ].join("\n");
        default:
            return null;
    }
}

// The response the widget needs to ask `field` next.
function askPayload(field, sel) {
    const progress = PROGRESS_FIELDS.filter((f) => filled(sel, f)).length;
    return {
        chips: CHIP_MAP[field] || [],
        recommendedChip: field === "new_boiler" ? (RECOMMEND_CHIP[sel.occupants] || null) : null,
        photoStep: field === "photos",
        contactForm: field === "name",
        state: sel,
        progress,
        progressTotal: PROGRESS_FIELDS.length,
    };
}

// ---------------------------------------------------------------------------
//  Customer-facing quote. Bubbles split by [[SPLIT]].
// ---------------------------------------------------------------------------
function renderPriceBubble(quote, sel) {
    const lines = [`Köszönöm, ${sel.name || ""}! Íme az előzetes ajánlata.`, ``];
    for (const [key, title] of SECTIONS) {
        const rows = quote.items.filter(i => i.sec === key);
        if (!rows.length) continue;
        lines.push(`## ${title}`);
        rows.forEach(i => lines.push(`• ${i.label} — **${formatHuf(i.huf)}**`));
        lines.push(``);
    }
    lines.push(`>> Induló ár: ${formatHuf(quote.total)}-tól`);
    lines.push(`Bruttó ár, ÁFÁ-val — a készülékkel és a teljes beépítéssel együtt.`);
    return lines.join("\n");
}

function renderCustomerQuote(quote, sel, area) {
    const priceBubble = renderPriceBubble(quote, sel);

    const included = [
        `A kondenzációs gázkészülék ára`,
        `A teljes beszerelés és a gyári üzembe helyezés`,
        `A régi készülék bontása és elszállítása`,
        `Vizes rendszerre kötés mágneses iszapleválasztóval`,
    ];
    if (sel.old_boiler === "hagyomanyos") included.push(`Kéményátalakítás saválló béléscsővel`);
    included.push(`${lbl("warranty", sel.warranty)} garancia a készülékre`);
    included.push(`Ügyintézés és a dokumentált beüzemelés`);

    const excluded = [
        ...surchargeLines(sel),
        `Gázvezeték áthelyezése vagy cseréje`,
        `Radiátorcsere és a fűtési rendszer állapotától függő pótmunka`,
        `Bontás utáni faljavítás, burkolás, festés`,
        `Társasházi engedélyeztetés külön díja, ha a ház ilyet kér`,
    ];

    const noteBubble = [
        `## Az árban benne van`,
        ...included.map(x => `• ${x}`),
        ``,
        `## Ami ezen felül jöhet`,
        ...excluded.map(x => `• ${x}`),
        ``,
        `Ez az **induló ár**: ennél kevesebb nem lesz. A felmérésen derül ki, kell-e bármi a fenti listából — a végleges, **fix árat** előre megmondjuk, utólagos ráfizetés nélkül.`,
    ].join("\n");

    const recap = [
        `## A munka`,
        `• Leszerelendő készülék: **${lbl("old_boiler", sel.old_boiler)}**`,
        `• Lakók száma: **${lbl("occupants", sel.occupants)}**`,
        `• Új kazán: **${lbl("new_boiler", sel.new_boiler)}**`,
        `• Kémény: **${lbl("flue", sel.flue)}**`,
        `• Fotók: **${photosLabel(sel)}**`,
        `• Tervezett csere: **${lbl("timeline", sel.timeline)}**`,
        ``,
        `## Az Ön adatai`,
        `• Név: **${sel.name || "—"}**`,
        `• Telefon: **${sel.phone || "—"}**`,
    ];
    if (sel.email) recap.push(`• E-mail: **${sel.email}**`);
    recap.push(`• Irányítószám: **${sel.postal_code || "—"}**`);
    if (area === "outside") {
        recap.push(``, `Az irányítószáma **kívül eshet** a szokásos területünkön (Budapest és agglomeráció). Kollégánk telefonon egyeztet, hogy vállalható-e.`);
    }
    recap.push(
        ``,
        `## Mi történik ezután`,
        `• **Válasszon időpontot** lent az ingyenes felméréshez`,
        `• Kollégánk **visszaigazolja** telefonon`,
        `• A felmérés után **fix árat** kap, és jöhet az **egynapos csere**`,
        ``,
        `Ha addig kérdése van, hívjon: **${PHONE}**`,
    );

    return [priceBubble, noteBubble, recap.join("\n")].join("\n[[SPLIT]]\n");
}

// What the widget needs for the controls under the quote.
function postQuotePayload(sel) {
    return {
        warranty: sel.warranty || "w_2",
        warrantyOptions: Object.entries(PRICES.warranty).map(([value, p]) => ({
            value,
            label: value.replace("w_", "") + " év",
            extra: p.huf ? `+${formatHuf(p.huf)}` : "ingyenes",
        })),
        emailOffer: EMAIL_OFFER_ENABLED && !!sel.email,
    };
}

// ---------------------------------------------------------------------------
//  System prompt (Hungarian) — only used for free-typed messages
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `SZEMÉLYISÉG
Te az "Aqua System" digitális árajánló asszisztense vagy. Egynapos gázkészülék- és kazáncserével foglalkozó épületgépész csapat nevében beszélsz. Kizárólag MAGYARUL válaszolj. Soha ne használj emojit.

HANGNEM
- Udvarias, közvetlen, szakértő és tömör. Lehetőleg 45 szó alatt válaszolj.
- Egyszerre EGY kérdést tegyél fel.
- Sose találgass árat és sose számolj — az árat a rendszer számolja ki a végén.

TUDÁSBÁZIS — A CÉGRŐL (ha az ügyfél KÖZBEN kérdez valamit, válaszolj röviden, majd UGYANABBAN a válaszban térj vissza a soron következő kérdéshez)
- Cég: Aqua System Service Kft. — egynapos gázkészülék- és kazáncsere, teljes körű épületgépészeti kivitelezéssel.
- Elérhetőségek: telefon ${PHONE}, e-mail ${COMPANY_EMAIL}.
- Szolgáltatási terület: Budapest és az agglomeráció — pl. Érd, Diósd, Tárnok, Halásztelek. Ha bizonytalan a cím, mondd: telefonon gyorsan tisztázzák.
- Tapasztalat: közel 50 év épületgépészeti tapasztalat, 500+ sikeres készülékcsere.
- EGYNAPOS CSERE: a legtöbb cserét EGYETLEN munkanap alatt elvégezzük — leszereléstől a beüzemelésig. A pontos időt a felmérés után erősítjük meg.
- KIZÁRÓLAG kondenzációs gázkészüléket építünk be (kb. 15–30%-kal kevesebbet fogyaszt egy régi típusnál). Hagyományos, nyílt égésterű vagy turbós készüléket NEM szerelünk be — ezt kedvesen magyarázd el, ha kérik.
- Ügyintézés: a teljes folyamatot mi visszük — készülék kiválasztása, engedélyeztetés, papírmunka, dokumentált beüzemelés.
- Árazás elve: a végén az ügyfél INDULÓ árat lát, és mellette pontosan felsorolva, mi jöhet még hozzá. A felmérés után FIX, előre megmondott árat adunk — utólagos ráfizetés nincs.
- Garancia: 2 év gyári alapgarancia; az ajánlat végén 5 vagy 10 évre bővíthető felárral.
- Mikor kell cserélni: 12 évnél idősebb készüléket érdemes felülvizsgáltatni, 18 évnél idősebbnél már ajánlott a csere.
- Gázszag esetén MINDIG mondd: azonnal zárja el a gázt, szellőztessen, és hívja a gázszolgáltató hibabejelentőjét — ne kísérletezzen. Távolról ne diagnosztizálj hibát.
- Márkák: SOHA ne nevezz meg konkrét márkát vagy típust. A pontos márkát és típust a felmérésen választjuk ki közösen, az otthonhoz és a kerethez igazítva.
- SOHA ne állíts olyat a cégről, ami nincs ebben a tudásbázisban.
- Ha olyat kérdeznek, ami nincs itt, ne találgass: irányítsd telefonra (${PHONE}) vagy mondd, hogy a felmérésnél pontosítják.

KÖZÉRTHETŐSÉG
Az ügyfél laikus. Egyszerűen, hétköznapi nyelven fogalmazz, a szakszavakat magyarázd el. Ha nem tudja a választ, fogadd el a "nem_tudom" értéket és lépj tovább — a rendszer a legkedvezőbb változattal számol, és a különbözetet külön kiírja.

FORMÁZÁS — KÖTELEZŐ MINDEN KÉRDÉSNÉL
1) Ha nyugtázol, az EGY rövid szó legyen a saját sorában. Utána üres sor.
2) MAGA A KÉRDÉS **félkövérrel**, a saját sorában.
3) Legfeljebb 3 rövid pont, "• " jellel, a kulcsszó **félkövérrel**.
Soha ne írj hosszú, zárójeles bekezdést.

KÉRDÉSEK SORRENDJE (egyesével):
1. old_boiler — **Milyen készüléket kell leszerelni?** Értékek: "kondenzacios", "hagyomanyos", "nem_tudom". (A hagyományos régi kémény nem jó kondenzációs kazánhoz — a rendszer beleszámolja, ne kérdezd külön.)
2. occupants — **Hányan laknak a lakásban?** Értékek: "o_1_2", "o_3_4", "o_5plus", "nem_tudom".
3. new_boiler — **Milyen új készüléket szeretne?** Mindegyik kondenzációs. 1–2 főnél kombit, 3–4 főnél tárolósat, 5+ főnél külső tárolósat ajánlj. Értékek: "kombi_24", "tarolos_46", "kulso_125", "nem_tudom".
4. flue — **Hova vezet most a kazán füstcsöve?** Értékek: "teto", "tegla_kemeny", "gyujtokemeny", "nem_tudom".
5. photos — **Lefotózná a mostani kazánt?** Nem kötelező; a fotót a gombbal lehet csatolni a beszélgetés alatt. Ha az ügyfél nem akar fotót küldeni, az érték "0".
6. timeline — **Mikorra szeretné a cserét?** Értékek: "t_asap", "t_month", "t_halfyear", "t_thisyear", "t_unsure".
UTÁNA az elérhetőségeket (név, telefon, irányítószám, opcionálisan e-mail) a RENDSZER kéri be EGY ŰRLAPON. Csak egy rövid átvezető mondatot írj. Ha az ügyfél mégis szabad szöveggel adja meg őket, kérd egyesével a hiányzót (name, phone, postal_code).

NE kérdezd: életvédelmi relét, garanciát, költségkeretet — ezek az ajánlatnál jelennek meg.

REJTETT ÁLLAPOT (KÖTELEZŐ MINDEN VÁLASZ VÉGÉN, az ügyfél NEM látja). Csak azt töltsd ki, amit az ügyfél ténylegesen megválaszolt, a többi "":
<!--DATA:{"old_boiler":"","occupants":"","new_boiler":"","flue":"","photos":"","timeline":"","name":"","email":"","phone":"","postal_code":""}-->
Az árat NE te írd ki; a rendszer számolja. A választógombokat a rendszer jeleníti meg.`;

// ---------------------------------------------------------------------------
//  AI providers — each takes normalized messages and returns { ok, text, error }
// ---------------------------------------------------------------------------
async function callOpenAI(messages) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing OPENAI_API_KEY" };
    try {
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
            body: JSON.stringify({
                model: process.env.OPENAI_MODEL || "gpt-5.4-mini",
                messages,
                temperature: 0.4,
                max_tokens: 500,
            }),
        });
        const data = await res.json();
        const text = data.choices?.[0]?.message?.content;
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

async function callGemini(messages) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return { ok: false, error: "Missing GEMINI_API_KEY" };
    const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
    const systemMsg = messages.find(m => m.role === "system");
    const contents = messages
        .filter(m => m.role !== "system")
        .map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
    try {
        const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`,
            {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    system_instruction: systemMsg ? { parts: [{ text: systemMsg.content }] } : undefined,
                    contents,
                    generationConfig: {
                        temperature: 0.4,
                        maxOutputTokens: 1000,
                        // Thinking tokens count against maxOutputTokens and were
                        // truncating answers; this bot follows a fixed script.
                        thinkingConfig: { thinkingBudget: 0 },
                    },
                }),
            }
        );
        const data = await res.json();
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).map(p => p?.text || "").join("");
        if (cand?.finishReason === "MAX_TOKENS") console.warn("Gemini hit MAX_TOKENS — answer may be truncated.");
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// ---------------------------------------------------------------------------
//  Photos: the widget shrinks them to JPEG in the browser and sends them only
//  with the final (contact form) request. They are attached to the owner's
//  e-mail — no storage needed. Anything that isn't a small image is dropped.
// ---------------------------------------------------------------------------
const MAX_PHOTOS = 3;
const MAX_PHOTO_BYTES = 1_500_000;

function cleanPhotos(photos) {
    if (!Array.isArray(photos)) return [];
    const out = [];
    for (const p of photos.slice(0, MAX_PHOTOS)) {
        const m = typeof p === "string" && p.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
        if (!m) continue;
        if (m[2].length * 0.75 > MAX_PHOTO_BYTES) continue;
        out.push({ filename: `kazan-foto-${out.length + 1}.${m[1] === "jpeg" ? "jpg" : m[1]}`, content: m[2] });
    }
    return out;
}

// Price, notify and render the finished quote.
async function finishWithQuote(sel, response, photos) {
    sel.warranty = sel.warranty || "w_2";
    const quote = buildQuote(sel);
    const area = classifyArea(sel.postal_code);
    const attachments = cleanPhotos(photos);

    console.log("\n========================================");
    console.log("ÚJ ÁRAJÁNLAT / LEAD");
    console.log(`Ügyfél: ${sel.name} | ${sel.phone} | ${sel.email || "-"}`);
    console.log(`Irsz.: ${sel.postal_code} (${area}) | Kivitelezés: ${sel.timeline} | Fotók: ${attachments.length}`);
    console.log(`Induló ár: ${formatHuf(quote.total)}`);
    console.log("========================================\n");

    await Promise.all([
        sendOwnerEmail(sel, quote, { area, attachments }),
        sendLeadToSheet(sel, quote, area),
    ]);

    return response.status(200).json({
        answer: renderCustomerQuote(quote, sel, area),
        chips: [],
        postQuote: postQuotePayload(sel),
        lead: { sel, quote },
        state: sel,
        progress: PROGRESS_FIELDS.length,
        progressTotal: PROGRESS_FIELDS.length,
    });
}

// The lead object comes back from the browser on post-quote actions. Keep only
// known string fields, and always re-price from the answers — never trust a
// total sent by the client.
function cleanLeadSel(lead) {
    const raw = lead && lead.sel && typeof lead.sel === "object" ? lead.sel : null;
    if (!raw) return null;
    const keys = ["old_boiler", "occupants", "new_boiler", "flue", "photos", "timeline",
        "warranty", "name", "email", "phone", "postal_code"];
    const sel = {};
    for (const k of keys) {
        if (raw[k] != null && typeof raw[k] !== "object") sel[k] = String(raw[k]).slice(0, 120);
    }
    sanitizeChoices(sel);
    return isQuoteReady(sel) ? sel : null;
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------
export default async function handler(request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (request.method === "OPTIONS") return response.status(200).end();

    try {
        const { question, history, action, lead, state, photos } = request.body || {};

        // --- ACTION: first question, straight from the template ---------------
        if (action === "start") {
            const sel = {};
            return response.status(200).json({ answer: questionText("old_boiler", sel), ...askPayload("old_boiler", sel) });
        }

        // --- ACTION: customer changed the warranty on the finished quote -------
        if (action === "set_warranty") {
            const sel = cleanLeadSel(lead);
            const w = request.body.warranty;
            if (!sel || !PRICES.warranty[w]) return response.status(400).json({ error: "bad request" });
            sel.warranty = w;
            const quote = buildQuote(sel);
            return response.status(200).json({ answer: renderPriceBubble(quote, sel), lead: { sel, quote } });
        }

        // --- ACTION: customer picked a survey slot ------------------------------
        if (action === "book_survey") {
            const sel = cleanLeadSel(lead);
            const b = request.body.booking || {};
            const okDate = typeof b.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.date);
            const okWindow = ["delelott", "delutan", "barmikor"].includes(b.window);
            if (!sel || !okDate || !okWindow) return response.status(400).json({ error: "bad request" });
            const booking = { date: b.date, dayLabel: String(b.dayLabel || b.date).slice(0, 40), window: b.window };
            const quote = buildQuote(sel);
            await sendBookingEmail(sel, quote, booking);
            return response.status(200).json({
                answer: [
                    `**Köszönjük, rögzítettük a kérését.**`,
                    `• Felmérés: **${booking.dayLabel}, ${WINDOW_LABELS[booking.window].toLowerCase()}**`,
                    `• Kollégánk ezen a számon **visszaigazolja**: ${sel.phone}`,
                    ``,
                    `Ha közben változik valami, hívjon: **${PHONE}**`,
                ].join("\n"),
            });
        }

        // --- ACTION: customer asked us to e-mail them the quote ----------------
        if (action === "email_customer") {
            const sel = cleanLeadSel(lead);
            if (!EMAIL_OFFER_ENABLED || !sel || !EMAIL_RE.test(sel.email || "")) {
                return response.status(400).json({ error: "bad request" });
            }
            const ok = await sendCustomerEmail(sel, buildQuote(sel));
            return response.status(200).json({
                answer: ok
                    ? `Elküldtük az ajánlatot a megadott címre (**${sel.email}**). Ha nem találja, nézze meg a Spam mappát is.`
                    : `Sajnos most nem sikerült e-mailt küldeni, de kollégánk hamarosan keresi. Telefon: **${PHONE}**`,
            });
        }

        // --- STATE, assembled BEFORE the model is called -----------------------
        const priorSel = Array.isArray(history)
            ? history
                .filter((m) => m && (m.role === "assistant" || m.role === "model"))
                .map((m) => sanitizeChoices(extractData(m.content)))
            : [];
        const baseSel = sanitizeChoices(mergeState(...priorSel, state));

        // Record the answer the customer just gave into the field they were asked.
        const determined = {};
        const pending = pendingField(baseSel);
        if (pending) {
            const v = mapAnswer(pending, question);
            if (v) determined[pending] = v;
        }
        const earlySel = mergeState(baseSel, determined);

        // FAST PATH 1: everything is known (the contact form completed it).
        if (isQuoteReady(earlySel)) return await finishWithQuote(earlySel, response, photos);

        // FAST PATH 2: we understood the answer — ask the next question from
        // the template. No model call: the reply is instant and costs nothing.
        if (pending && determined[pending]) {
            const next = pendingField(earlySel);
            const ack = ACKS[PROGRESS_FIELDS.filter((f) => filled(earlySel, f)).length % ACKS.length];
            const body = questionText(next, earlySel);
            if (body) {
                const answer = next === "name" ? body : `${ack}\n\n${body}`;
                return response.status(200).json({ answer, ...askPayload(next, earlySel) });
            }
        }

        // SLOW PATH: free-typed text we can't map — let the model handle it.
        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (Array.isArray(history) && history.length > 0) {
            for (const m of history.slice(-30)) {
                if (m && m.role && typeof m.content === "string") {
                    messages.push({ role: m.role === "model" ? "assistant" : (m.role === "assistant" ? "assistant" : "user"), content: m.content.slice(0, 4000) });
                }
            }
        } else if (question) {
            messages.push({ role: "user", content: String(question).slice(0, 4000) });
        }
        // Tell the model where we are, so it re-asks the right question.
        if (pending) {
            messages.push({ role: "system", content: `A soron következő mező: ${pending}. Az eddig ismert adatok: ${JSON.stringify(baseSel)}` });
        }

        const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();
        const result = provider === "gemini" ? await callGemini(messages) : await callOpenAI(messages);

        if (!result.ok) {
            console.error(`[${provider}] API Error:`, result.error);
            // Don't strand the customer: repeat the current question with its buttons.
            const body = pending && questionText(pending, baseSel);
            if (body) {
                return response.status(200).json({
                    answer: `Elnézést, ezt most nem tudtam feldolgozni. Kérem, válasszon az alábbiak közül, vagy hívjon: **${PHONE}**\n\n${body}`,
                    ...askPayload(pending, baseSel),
                });
            }
            return response.status(200).json({ answer: `Elnézést, most nem érem el az asszisztenst. Kérem, próbálja újra, vagy hívjon: **${PHONE}**` });
        }

        let aiAnswer = result.text || "";
        let currentSel = null;
        const dataMatch = aiAnswer.match(/<!--DATA:(.*?)-->/s);
        if (dataMatch) {
            try { currentSel = sanitizeChoices(JSON.parse(dataMatch[1])); }
            catch (e) { console.error("DATA parse fail:", e.message); }
        }
        aiAnswer = aiAnswer.replace(/<!--DATA:.*?-->/gs, "").replace(/<!--CHIPS:.*?-->/gs, "").trim();

        // The model is least trusted; the carried state and this turn's mapped
        // answer win. Photos can only be set by the photo step, never the model.
        if (currentSel) {
            delete currentSel.photos;
            if (pending === "photos" && /kihagy|nem kér|nem kell|nincs fot/i.test(String(question))) currentSel.photos = "0";
        }
        const sel = mergeState(currentSel, baseSel, determined);

        if (isQuoteReady(sel)) return await finishWithQuote(sel, response, photos);

        const next = pendingField(sel);
        return response.status(200).json({ answer: aiAnswer, ...askPayload(next, sel) });

    } catch (error) {
        console.error("Function Crash:", error.message);
        return response.status(500).json({ answer: `Elnézést, a szerver épp akadozik. Kérem, próbálja újra, vagy hívjon: ${PHONE}` });
    }
}

// ---------------------------------------------------------------------------
//  E-mail (Resend)
// ---------------------------------------------------------------------------
const WINDOW_LABELS = { delelott: "Délelőtt (8–12)", delutan: "Délután (12–17)", barmikor: "Bármikor" };
const AREA_LABELS = { budapest: "Budapest", agglo: "Agglomeráció", outside: "Területen kívül lehet", unknown: "Ismeretlen" };

async function sendEmail({ to, subject, html, text, replyTo, attachments }) {
    const resendKey = process.env.RESEND_API_KEY;
    const fromEmail = process.env.LEAD_EMAIL_FROM || "Aqua System <onboarding@resend.dev>";
    if (!resendKey) {
        console.log("Nincs RESEND_API_KEY — az e-mail kimarad. A lead a fenti logban szerepel.");
        return false;
    }
    try {
        const res = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resendKey}` },
            body: JSON.stringify({
                from: fromEmail, to: [to], subject, html, text,
                ...(replyTo ? { reply_to: replyTo } : {}),
                ...(attachments && attachments.length ? { attachments } : {}),
            }),
        });
        const result = await res.json();
        if (res.ok) { console.log("E-mail elküldve:", subject, result.id); return true; }
        console.error("Resend hiba:", JSON.stringify(result));
        return false;
    } catch (err) {
        console.error("Nem sikerült elküldeni az e-mailt:", err.message);
        return false;
    }
}

const ownerTo = () => process.env.LEAD_EMAIL_TO || "pirint.milan@gmail.com";
const telHref = (phone) => "tel:" + String(phone || "").replace(/[^\d+]/g, "");

function quoteTableHtml(quote) {
    const rows = quote.items
        .map(i => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${esc(i.label)}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${formatHuf(i.huf)}</td></tr>`)
        .join("");
    return `<table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
      <tr><td style="padding:10px 12px;font-weight:bold">Induló ár</td><td style="padding:10px 12px;text-align:right;font-weight:bold;color:#0f2a5e">${formatHuf(quote.total)}-tól</td></tr>
    </table>`;
}

function surchargesHtml(sel) {
    return `<ul style="margin:6px 0 0;padding-left:18px;font-size:13px;color:#374151">${surchargeLines(sel)
        .map(l => `<li>${esc(l.replace(/\*\*/g, ""))}</li>`).join("")}</ul>`;
}

function leadDetailsHtml(sel, area) {
    const row = (k, v) => `<tr><td style="padding:3px 12px 3px 0;color:#6b7280">${k}</td><td style="padding:3px 0"><b>${esc(v)}</b></td></tr>`;
    return `<table style="font-size:14px;border-collapse:collapse">
      ${row("Név", sel.name || "-")}
      ${row("Telefon", sel.phone || "-")}
      ${row("E-mail", sel.email || "nem adta meg")}
      ${row("Irányítószám", `${sel.postal_code || "-"} (${AREA_LABELS[area] || area})`)}
      ${row("Tervezett csere", lbl("timeline", sel.timeline))}
      ${row("Leszerelendő", lbl("old_boiler", sel.old_boiler))}
      ${row("Lakók", lbl("occupants", sel.occupants))}
      ${row("Új kazán", lbl("new_boiler", sel.new_boiler))}
      ${row("Kémény", lbl("flue", sel.flue))}
      ${row("Garancia", lbl("warranty", sel.warranty))}
      ${row("Fotók", photosLabel(sel))}
    </table>`;
}

// Owner notification. The callback button and the urgency/area flags sit at
// the very top, because the owner reads this on a phone between jobs.
async function sendOwnerEmail(sel, quote, { area, attachments }) {
    const urgent = sel.timeline === "t_asap";
    const flags = [];
    if (urgent) flags.push(`<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:8px 12px;border-radius:6px;margin-bottom:8px"><b>Sürgős:</b> amint lehet szeretné a cserét.</div>`);
    if (area === "outside") flags.push(`<div style="background:#fee2e2;border:1px solid #ef4444;color:#991b1b;padding:8px 12px;border-radius:6px;margin-bottom:8px"><b>Terület:</b> a(z) ${esc(sel.postal_code)} irányítószám nincs a Budapest + agglomeráció listán.</div>`);

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 12px;font-size:18px">Új árajánlat-kérés: ${esc(sel.name || "")}</h2>
      ${flags.join("")}
      <p style="margin:0 0 16px"><a href="${esc(telHref(sel.phone))}" style="display:inline-block;background:#2b5fd0;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Hívás: ${esc(sel.phone || "")}</a></p>
      <div style="border:1px solid #e5e7eb;padding:20px;border-radius:8px">
        ${leadDetailsHtml(sel, area)}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        <h3 style="margin:0 0 8px">Amit az ügyfél látott</h3>
        ${quoteTableHtml(quote)}
        <p style="margin:12px 0 0;font-size:13px"><b>Felárak, amiket előre jeleztünk:</b></p>
        ${surchargesHtml(sel)}
        ${attachments.length ? `<p style="margin:16px 0 0;font-size:13px">${attachments.length} fotó csatolva ehhez a levélhez.</p>` : ""}
        <p style="margin:16px 0 0;font-size:12px;color:#6b7280">Ha az ügyfél a chatben felmérési időpontot is választ, arról külön levél érkezik.</p>
      </div>
    </div>`;

    const text = [
        urgent ? "SÜRGŐS: amint lehet szeretné a cserét." : "",
        area === "outside" ? `TERÜLET: ${sel.postal_code} nincs a Budapest + agglomeráció listán.` : "",
        `Név: ${sel.name || "-"}`,
        `Telefon: ${sel.phone || "-"}`,
        `E-mail: ${sel.email || "nem adta meg"}`,
        `Irányítószám: ${sel.postal_code || "-"} (${AREA_LABELS[area] || area})`,
        `Tervezett csere: ${lbl("timeline", sel.timeline)}`,
        `Leszerelendő: ${lbl("old_boiler", sel.old_boiler)}`,
        `Lakók: ${lbl("occupants", sel.occupants)}`,
        `Új kazán: ${lbl("new_boiler", sel.new_boiler)}`,
        `Kémény: ${lbl("flue", sel.flue)}`,
        `Fotók: ${photosLabel(sel)}`,
        "",
        ...quote.items.map(i => `- ${i.label}: ${formatHuf(i.huf)}`),
        "",
        `Induló ár: ${formatHuf(quote.total)}-tól`,
    ].filter((l, i) => l !== "" || i > 1).join("\n");

    // No brackets / ALL-CAPS in the subject — those push transactional mail
    // into Gmail's Promotions tab.
    const subject = `${urgent ? "Sürgős: " : ""}Új árajánlat — ${sel.name || ""} (${sel.postal_code || ""}) — ${formatHuf(quote.total)}-tól`;

    return sendEmail({
        to: ownerTo(), subject, html, text, attachments,
        replyTo: EMAIL_RE.test(sel.email || "") ? sel.email : undefined,
    });
}

async function sendBookingEmail(sel, quote, booking) {
    const area = classifyArea(sel.postal_code);
    const when = `${booking.dayLabel}, ${WINDOW_LABELS[booking.window]}`;
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 12px;font-size:18px">Felmérési időpont kérés: ${esc(sel.name || "")}</h2>
      <div style="background:#eaf3ff;border:1px solid #2b5fd0;padding:12px 16px;border-radius:8px;margin-bottom:12px;font-size:16px">
        <b>${esc(when)}</b><br><span style="font-size:13px;color:#374151">Az ügyfél azt várja, hogy telefonon visszaigazolják.</span>
      </div>
      <p style="margin:0 0 16px"><a href="${esc(telHref(sel.phone))}" style="display:inline-block;background:#2b5fd0;color:#ffffff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Hívás: ${esc(sel.phone || "")}</a></p>
      <div style="border:1px solid #e5e7eb;padding:20px;border-radius:8px">
        ${leadDetailsHtml(sel, area)}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        ${quoteTableHtml(quote)}
      </div>
    </div>`;
    const text = [
        `Felmérési időpont kérés: ${when}`,
        `Név: ${sel.name}`,
        `Telefon: ${sel.phone}`,
        `Irányítószám: ${sel.postal_code}`,
        `Garancia: ${lbl("warranty", sel.warranty)}`,
        `Induló ár: ${formatHuf(quote.total)}-tól`,
    ].join("\n");
    return sendEmail({
        to: ownerTo(),
        subject: `Felmérés kérés — ${sel.name || ""} — ${when}`,
        html, text,
        replyTo: EMAIL_RE.test(sel.email || "") ? sel.email : undefined,
    });
}

async function sendCustomerEmail(sel, quote) {
    const html = `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <div style="background:#2b5fd0;color:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="margin:0">Az Ön ajánlata — Aqua System</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        <p style="margin:0 0 12px">Kedves ${esc(sel.name || "Ügyfelünk")}! Köszönjük érdeklődését. Íme az előzetes ajánlata:</p>
        ${quoteTableHtml(quote)}
        <p style="margin:14px 0 0;font-size:13px"><b>Ami ezen felül jöhet:</b></p>
        ${surchargesHtml(sel)}
        <p style="margin:16px 0 0;font-size:12px;color:#6b7280">Bruttó (ÁFÁ-val), a kazánnal és a teljes beépítéssel. A végleges, fix árat a helyszíni felmérés után adjuk meg. Telefon: ${PHONE}</p>
      </div>
    </div>`;
    const text = [
        `Kedves ${sel.name || "Ügyfelünk"}!`,
        "",
        "Köszönjük érdeklődését. Íme az előzetes ajánlata:",
        "",
        ...quote.items.map(i => `- ${i.label}: ${formatHuf(i.huf)}`),
        "",
        `Induló ár: ${formatHuf(quote.total)}-tól`,
        "",
        "Ami ezen felül jöhet:",
        ...surchargeLines(sel).map(l => "- " + l.replace(/\*\*/g, "")),
        "",
        `A végleges, fix árat a helyszíni felmérés után adjuk meg. Telefon: ${PHONE}`,
    ].join("\n");
    return sendEmail({
        to: sel.email,
        subject: `Az Ön ajánlata — Aqua System — ${formatHuf(quote.total)}-tól`,
        html, text, replyTo: COMPANY_EMAIL,
    });
}

// ---------------------------------------------------------------------------
//  Google Sheet logging (optional, SHEETS_WEBHOOK_URL). The first 14 columns
//  keep their original order so an existing sheet does not shift; questions
//  that are no longer asked are written as "nem kérdezett", and the new data
//  is appended at the end.
// ---------------------------------------------------------------------------
async function sendLeadToSheet(sel, quote, area) {
    const url = process.env.SHEETS_WEBHOOK_URL;
    if (!url) {
        console.log("Nincs SHEETS_WEBHOOK_URL — a lead nem kerül Google Sheetbe (csak e-mail).");
        return false;
    }
    const row = [
        new Date().toISOString(),               // Időbélyeg
        sel.name || "",                         // Név
        sel.phone || "",                        // Telefon
        sel.email || "",                        // E-mail
        sel.postal_code || "",                  // Irányítószám
        "nem kérdezett",                        // Tervezett keret
        lbl("timeline", sel.timeline),          // Tervezett kivitelezés
        lbl("old_boiler", sel.old_boiler),      // Leszerelendő készülék
        lbl("occupants", sel.occupants),        // Lakók száma
        lbl("new_boiler", sel.new_boiler),      // Új kazán
        lbl("flue", sel.flue),                  // Kémény
        "nem kérdezett",                        // Életvédelmi relé
        lbl("warranty", sel.warranty),          // Garancia (az ajánlat pillanatában)
        quote.total,                            // Induló ár (Ft)
        Number(sel.photos || 0),                // Fotók száma
        AREA_LABELS[area] || area,              // Terület
    ];
    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ row }),
        });
        if (res.ok) { console.log("Lead beírva a Google Sheetbe."); return true; }
        console.error("Google Sheet hiba:", res.status, await res.text());
        return false;
    } catch (err) {
        console.error("Nem sikerült a Google Sheetbe írni:", err.message);
        return false;
    }
}

// Exposed for the local test script.
export const _test = { buildQuote, mapAnswer, classifyArea, surchargeLines, pendingField, isQuoteReady, cleanPhotos };

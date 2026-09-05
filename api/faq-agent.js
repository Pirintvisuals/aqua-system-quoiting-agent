// ============================================================================
//  AQUA SYSTEM SERVICE KFT. — Árajánló asszisztens (gas boiler quoting agent)
//  - AI provider: OpenAI (gpt-4o-mini) — drives the Hungarian conversation only.
//  - Pricing is computed DETERMINISTICALLY in this backend from the PRICES table
//    below. The AI never does arithmetic, so the total can never be miscalculated.
//  - When all answers are collected the AI emits a hidden JSON block
//    (<!--QUOTE_JSON:{...}-->). We parse it, price it, e-mail the owner, and
//    return the itemised estimate to show the customer.
// ============================================================================

// ---------------------------------------------------------------------------
//  PRICE TABLE (HUF) — single source of truth. Edit numbers here only.
//  Source: the company's price sheet (milan.xlsx). Prices shown "as-is".
// ---------------------------------------------------------------------------
const PRICES = {
    // Mit kell LESZERELNI? Ez dönti el, hogy a meglévő égéstermék-elvezetés
    // használható-e: egy hagyományos (nyílt égésterű / turbós) készülék kéménye
    // NEM alkalmas kondenzációs kazánhoz, ott saválló bélelés / átalakítás kell
    // (lásd `chimney_conversion` lentebb). "nem_tudom" => legolcsóbb feltételezés.
    old_boiler: {
        kondenzacios: { huf: 0,     label: "Leszerelendő készülék: kondenzációs" },
        hagyomanyos:  { huf: 60000, label: "Leszerelendő készülék: hagyományos (nyílt égésterű vagy turbós)" },
        nem_tudom:    { huf: 0,     label: "Leszerelendő készülék: a felmérésnél pontosítjuk" },
    },
    // CSAK akkor kerül a tételek közé, ha a régi készülék HAGYOMÁNYOS volt.
    // ÁRAT ELLENŐRIZNI: irányár, írd át az Aqua System saját árára.
    chimney_conversion: { huf: 260000, label: "Kéményátalakítás kondenzációs kazánhoz (saválló béléscső)" },

    // Új kazán. Az Aqua System KIZÁRÓLAG kondenzációs készüléket épít be, ezért
    // itt minden opció kondenzációs. "nem_tudom" => a legolcsóbb (kombi).
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
    // Életvédelmi (Fi) relé. "nem_tudom" => a legolcsóbb (van, 50 000).
    rcd: {
        van:       { huf: 50000,  label: "Életvédelmi (Fi) relé: van" },
        nincs:     { huf: 100000, label: "Életvédelmi (Fi) relé: nincs — kiépítés szükséges" },
        nem_tudom: { huf: 50000,  label: "Életvédelmi (Fi) relé (alap — a felmérésnél pontosítjuk)" },
    },
    // Hány év garanciát kér az ügyfél. A 2 év a gyári alap (ingyenes), a hosszabb
    // garancia felára itt állítható.
    // ÁRAT ELLENŐRIZNI: irányárak, írd át az Aqua System saját áraira.
    warranty: {
        w_2:       { huf: 0,      label: "Garancia: 2 év (gyári alapgarancia)" },
        w_5:       { huf: 60000,  label: "Kiterjesztett garancia: 5 év" },
        w_10:      { huf: 150000, label: "Kiterjesztett garancia: 10 év" },
        nem_tudom: { huf: 0,      label: "Garancia: 2 év (alap — a felmérésnél pontosítjuk)" },
    },
    // Mindig felszámolt standard tételek
    standard: {
        wet_system:    { huf: 300000, label: "Vizes rendszerre kötés mágneses iszapleválasztóval (anyag + munkadíj)" },
        commissioning: { huf: 50000,  label: "Gázkazán gyári üzembe helyezése" },
    },
    // Csak csere esetén
    demolition: { huf: 90000, label: "Régi kazán és kémény bontása" },
};

// Company confirmed: the boiler-type prices include the appliance, and all
// prices are GROSS (ÁFA included) — what the customer actually pays.
const APPLIANCE_INCLUDED = true;

// Offer to e-mail the quote to the CUSTOMER. Requires a real Resend key + a
// VERIFIED sending domain — until that exists, sending fails and the customer
// would see an error, so keep this OFF. The owner still gets notified
// internally. Flip to true (or set EMAIL_OFFER=on in .env) once the domain is
// live. The owner-quote recap closes cleanly without this offer.
const EMAIL_OFFER_ENABLED =
    (process.env.EMAIL_OFFER || "").toLowerCase() === "on";

// ---------------------------------------------------------------------------
//  Helpers
// ---------------------------------------------------------------------------
function formatHuf(n) {
    // 450000 -> "450 000 Ft"
    return n.toLocaleString("hu-HU").replace(/ /g, " ") + " Ft";
}

// Build the itemised quote deterministically from the AI's structured answers.
// Which block of the breakdown a line belongs to, in the order they are shown.
// Grouping the items turns a flat wall of nine bullets into something the
// customer can actually scan.
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

    // The new-vs-replacement question was removed; we always quote the full
    // job (current boiler handling + demolition included). "nem_tudom" answers
    // fall back to the cheapest variant of each field.
    const isReplacement = true;

    add(PRICES.old_boiler[sel.old_boiler] || PRICES.old_boiler.nem_tudom, "bontas");
    add(PRICES.new_boiler[sel.new_boiler] || PRICES.new_boiler.nem_tudom, "keszulek");
    add(PRICES.flue[sel.flue] || PRICES.flue.nem_tudom, "kemeny");
    // A hagyományos készülék kéménye nem alkalmas kondenzációs kazánhoz — ilyenkor
    // saválló bélelés / kéményátalakítás is kell. Kondenzációs cserénél nem.
    if (sel.old_boiler === "hagyomanyos") add(PRICES.chimney_conversion, "kemeny");
    add(PRICES.rcd[sel.rcd] || PRICES.rcd.nem_tudom, "szereles");
    add(PRICES.warranty[sel.warranty] || PRICES.warranty.nem_tudom, "garancia");

    // Standard costs — always included (not asked).
    add(PRICES.standard.wet_system, "szereles");
    add(PRICES.standard.commissioning, "szereles");
    add(PRICES.demolition, "bontas");

    const total = items.reduce((s, i) => s + i.huf, 0);
    return { items, total, isReplacement };
}

// Backend decides when the quote is complete — independent of the AI model.
function isQuoteReady(s) {
    if (!s || typeof s !== "object") return false;
    const filled = (k) => s[k] != null && String(s[k]).trim() !== "";
    const required = [
        "old_boiler", "occupants", "new_boiler", "flue", "rcd", "warranty",
        "name", "email", "phone", "postal_code", "budget", "timeline",
    ];
    return required.every(filled);
}

// Quick-reply buttons for each choice question — decided by the BACKEND from the
// current state, so the right buttons always appear (not reliant on the model).
const CHIP_MAP = {
    old_boiler: ["Kondenzációs", "Hagyományos", "Nem tudom"],
    occupants: ["1–2 fő", "3–4 fő", "5 vagy több", "Nem tudom"],
    new_boiler: ["Kombi (24 kW)", "Tárolós (46 l)", "Külső tároló (125 l)", "Nem tudom"],
    flue: ["Tetőn keresztül", "Tégla kéménybe", "Társasházi gyűjtőkémény", "Nem tudom"],
    rcd: ["Van", "Nincs", "Nem tudom"],
    warranty: ["2 év (alap)", "5 év", "10 év", "Nem tudom"],
    budget: ["1 millió Ft alatt", "1–1,5 millió Ft", "1,5–2 millió Ft", "2 millió Ft felett", "Még nem tudom"],
    timeline: ["Amint lehet", "Egy hónapon belül", "Fél éven belül", "Még idén", "Még nem tudom"],
};

// Order the questions are asked in: the project questions first, then the
// contact details at the very end (only asked once the project is fully
// described, i.e. the progress bar has reached 100%).
const FIELD_ORDER = ["old_boiler", "occupants", "new_boiler", "flue", "rcd", "warranty",
    "budget", "timeline", "name", "email", "phone", "postal_code"];

// Only the project questions count toward the progress bar (the contact
// details are not counted — the bar hits 100% right before we ask them).
const PROGRESS_FIELDS = ["old_boiler", "occupants", "new_boiler", "flue", "rcd", "warranty",
    "budget", "timeline"];

// Maps a clicked chip label -> its canonical value, per field. Lets the BACKEND
// record an answer the instant it arrives, without waiting for the model's
// (one-step-behind) state block. Keys are the exact CHIP_MAP labels.
const CHIP_VALUES = {
    old_boiler: { "kondenzációs": "kondenzacios", "hagyományos": "hagyomanyos", "nem tudom": "nem_tudom" },
    occupants: { "1–2 fő": "o_1_2", "3–4 fő": "o_3_4", "5 vagy több": "o_5plus", "nem tudom": "nem_tudom" },
    new_boiler: { "kombi (24 kw)": "kombi_24", "tárolós (46 l)": "tarolos_46", "külső tároló (125 l)": "kulso_125", "nem tudom": "nem_tudom" },
    flue: { "tetőn keresztül": "teto", "tégla kéménybe": "tegla_kemeny", "társasházi gyűjtőkémény": "gyujtokemeny", "nem tudom": "nem_tudom" },
    rcd: { "van": "van", "nincs": "nincs", "nem tudom": "nem_tudom" },
    warranty: { "2 év (alap)": "w_2", "5 év": "w_5", "10 év": "w_10", "nem tudom": "nem_tudom" },
    budget: {
        "1 millió ft alatt": "b_1m",
        "1–1,5 millió ft": "b_1_1_5",
        "1,5–2 millió ft": "b_1_5_2",
        "2 millió ft felett": "b_2m",
        "még nem tudom": "b_unsure",
    },
    timeline: {
        "amint lehet": "t_asap",
        "egy hónapon belül": "t_month",
        "fél éven belül": "t_halfyear",
        "még idén": "t_thisyear",
        "még nem tudom": "t_unsure",
    },
};

// The first still-unanswered field given the current state (= the question the
// customer is being asked right now). Returns null when everything is filled.
function pendingField(sel) {
    const filled = (k) => sel && sel[k] != null && String(sel[k]).trim() !== "";
    for (const f of FIELD_ORDER) {
        if (!filled(f)) return f;
    }
    return null;
}

// Parse a free-typed Hungarian budget amount into Ft. Handles e.g.
// "1 500 000", "1500000", "1,5 millió", "1.5 m", "2 millió", "másfél millió",
// "900 ezer", "1500 e". Returns null if no plausible amount is found.
function parseBudgetAmount(text) {
    if (typeof text !== "string") return null;
    const t = text.toLowerCase().trim();

    // Word form: "másfél millió" = 1.5 M
    if (/másf[eé]l\s*milli/.test(t)) return 1_500_000;

    // <number> millió | m | mFt  (comma/dot = decimal separator here)
    const m = t.match(/(\d+(?:[.,]\d+)?)\s*(?:milli[óo]k?|m\b|mft)/);
    if (m) {
        const n = parseFloat(m[1].replace(",", "."));
        if (!isNaN(n)) return Math.round(n * 1_000_000);
    }

    // <number> ezer | e | k  = thousands
    const e = t.match(/(\d+(?:[.,]\d+)?)\s*(?:ezer|e\b|k\b)/);
    if (e) {
        const n = parseFloat(e[1].replace(",", "."));
        if (!isNaN(n)) return Math.round(n * 1000);
    }

    // Bare number with space/dot/comma thousand separators -> raw Ft.
    const digits = t.replace(/[^\d]/g, "");
    if (digits) {
        const n = parseInt(digits, 10);
        if (!isNaN(n)) return n;
    }
    return null;
}

// Put a Ft amount into the right budget band. Implausibly small inputs
// (e.g. "3", "90", "900") return null so they are rejected, not silently
// bucketed — a real Ft budget is at least five digits.
function bucketBudget(amount) {
    if (amount == null || amount < 10000) return null;
    if (amount < 1_000_000) return "b_1m";
    if (amount < 1_500_000) return "b_1_1_5";
    if (amount < 2_000_000) return "b_1_5_2";
    return "b_2m";
}

// Given the field the customer is answering + their message, return the canonical
// value. Choice fields match the clicked chip label (case-insensitive); contact
// fields take the text as-is. Budget also accepts a typed amount, bucketed into
// a band. Returns null if it can't be mapped (free-typed choice) so we fall back
// to the model's captured value.
function mapAnswer(field, answer) {
    if (typeof answer !== "string" || !answer.trim()) return null;
    const a = answer.trim();
    if (field === "budget") {
        // Exact chip label first, otherwise parse a typed amount into a band.
        return CHIP_VALUES.budget[a.toLowerCase()] || bucketBudget(parseBudgetAmount(a));
    }
    if (CHIP_VALUES[field]) {
        return CHIP_VALUES[field][a.toLowerCase()] || null;
    }
    // free-text contact fields (budget is handled above)
    if (["name", "email", "phone", "postal_code"].includes(field)) return a;
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
// This makes the state immune to the model blanking a field in a single turn:
// once "csere" is set, a later empty value can't erase it (a real change to a
// new non-empty value still overrides).
function mergeState(...states) {
    const out = {};
    for (const s of states) {
        if (!s || typeof s !== "object") continue;
        for (const k of Object.keys(s)) {
            const v = s[k];
            if (v != null && String(v).trim() !== "") out[k] = v;
        }
    }
    return out;
}

function nextChips(sel) {
    const f = pendingField(sel);
    return f ? (CHIP_MAP[f] || []) : [];
}

// Human-readable Hungarian labels for the recap of what the customer chose.
const LABELS = {
    old_boiler: { kondenzacios: "Kondenzációs", hagyomanyos: "Hagyományos (nem kondenzációs)", nem_tudom: "Nem tudja (felmérésnél pontosítjuk)" },
    occupants: { o_1_2: "1–2 fő", o_3_4: "3–4 fő", o_5plus: "5 vagy több", nem_tudom: "Nem tudja" },
    new_boiler: { kombi_24: "Kondenzációs kombi (24 kW)", tarolos_46: "Kondenzációs tárolós, 46 l (24 kW)", kulso_125: "Kondenzációs + külső tároló, 125 l (24 kW)", nem_tudom: "Nem tudja (alap: kombi)" },
    flue: { teto: "Tetőn keresztül", tegla_kemeny: "Tégla kéménybe", gyujtokemeny: "Társasházi gyűjtőkémény", nem_tudom: "Nem tudja (alap: tetőn át)" },
    rcd: { van: "Van", nincs: "Nincs", nem_tudom: "Nem tudja (felmérésnél pontosítjuk)" },
    warranty: { w_2: "2 év (gyári alap)", w_5: "5 év", w_10: "10 év", nem_tudom: "Nem tudja (alap: 2 év)" },
    budget: {
        b_1m: "1 millió Ft alatt",
        b_1_1_5: "1–1,5 millió Ft",
        b_1_5_2: "1,5–2 millió Ft",
        b_2m: "2 millió Ft felett",
        b_unsure: "Még nem tudom",
    },
    timeline: {
        t_asap: "Amint lehet",
        t_month: "Egy hónapon belül",
        t_halfyear: "Fél éven belül",
        t_thisyear: "Még idén",
        t_unsure: "Még nem tudja",
    },
};
const lbl = (group, key) => (LABELS[group] && LABELS[group][key]) || key || "—";

// Drop any choice-field value the model invents that isn't a known canonical
// value (e.g. it tries to record budget "90"). Free-text fields are untouched.
function sanitizeChoices(s) {
    if (!s || typeof s !== "object") return s;
    for (const field of Object.keys(LABELS)) {
        const v = s[field];
        if (v != null && String(v).trim() !== "" && !(String(v) in LABELS[field])) {
            delete s[field];
        }
    }
    return s;
}

// Customer-facing estimate. Returns sections split by [[SPLIT]] so the widget
// renders them as separate, easy-to-read chat bubbles. Numbers come from buildQuote.
function renderCustomerQuote(quote, sel) {
    // --- Bubble 1: the itemised price, grouped into scannable sections -------
    const priceLines = [`Köszönöm, ${sel.name || ""}! Íme az előzetes árajánlata.`, ``];
    for (const [key, title] of SECTIONS) {
        const rows = quote.items.filter(i => i.sec === key);
        if (!rows.length) continue;
        priceLines.push(`## ${title}`);
        rows.forEach(i => priceLines.push(`• ${i.label} — **${formatHuf(i.huf)}**`));
        priceLines.push(``);
    }
    priceLines.push(`>> Becsült végösszeg: ${formatHuf(quote.total)}`);
    priceLines.push(`Bruttó ár, ÁFÁ-val — a készülékkel és a teljes beépítéssel együtt.`);
    const priceBubble = priceLines.join("\n");

    // --- Bubble 2: what the price covers, and what it deliberately doesn't ---
    // The exclusions matter as much as the number: they are what stops the
    // survey turning into an argument about a figure the customer anchored on.
    const included = [
        `A kondenzációs gázkészülék ára`,
        `A teljes beszerelés és a gyári üzembe helyezés`,
        `A régi készülék bontása és elszállítása`,
        `Vizes rendszerre kötés mágneses iszapleválasztóval`,
    ];
    if (sel.old_boiler === "hagyomanyos") {
        included.push(`Kéményátalakítás saválló béléscsővel`);
    }
    included.push(`${lbl("warranty", sel.warranty)} garancia a készülékre`);
    included.push(`Ügyintézés és a dokumentált beüzemelés`);

    const excluded = [
        `Gázvezeték áthelyezése vagy cseréje`,
        `Radiátorcsere és a fűtési rendszer állapotától függő pótmunka`,
        `Bontás utáni faljavítás, burkolás, festés`,
        `Társasházi engedélyeztetés külön díja, ha a ház ilyet kér`,
        `Egyedi, nem szabványos kéménymegoldás`,
    ];

    const noteBubble = [
        `## Az árban benne van`,
        ...included.map(x => `• ${x}`),
        ``,
        `## Az árban nincs benne`,
        ...excluded.map(x => `• ${x}`),
        ``,
        `Ez **előzetes, tájékoztató becslés**. A végleges, fix árat a helyszíni felmérés után adjuk meg — utólagos ráfizetés nélkül.`,
    ].join("\n");

    // --- Bubble 3: recap of the answers + what happens next -----------------
    const recapLines = [
        `## A munka`,
        `• Leszerelendő készülék: **${lbl("old_boiler", sel.old_boiler)}**`,
        `• Lakók száma: **${lbl("occupants", sel.occupants)}**`,
        `• Új kazán: **${lbl("new_boiler", sel.new_boiler)}**`,
        `• Kémény: **${lbl("flue", sel.flue)}**`,
        `• Életvédelmi (Fi) relé: **${lbl("rcd", sel.rcd)}**`,
        `• Kért garancia: **${lbl("warranty", sel.warranty)}**`,
        ``,
        `## Ütemezés`,
        `• Tervezett keret: **${lbl("budget", sel.budget)}**`,
        `• Tervezett kivitelezés: **${lbl("timeline", sel.timeline)}**`,
        ``,
        `## Az Ön adatai`,
        `• Név: **${sel.name || "—"}**`,
        `• E-mail: **${sel.email || "—"}**`,
        `• Telefon: **${sel.phone || "—"}**`,
        `• Irányítószám: **${sel.postal_code || "—"}**`,
        ``,
        `## Mi történik ezután`,
        `• Kollégánk **hamarosan felhívja** a megadott számon.`,
        `• Egyeztetünk egy **ingyenes helyszíni felmérést**.`,
        `• A felmérés után **fix, végleges árat** kap, és jöhet az **egynapos csere**.`,
        ``,
        `Ha addig kérdése van, hívjon: **+36 20 399 0093**`,
    ];
    if (EMAIL_OFFER_ENABLED) {
        recapLines.push(``);
        recapLines.push(`Szeretné, hogy e-mailben is elküldjük az ajánlatot?`);
    }

    return [priceBubble, noteBubble, recapLines.join("\n")].join("\n[[SPLIT]]\n");
}

// ---------------------------------------------------------------------------
//  System prompt (Hungarian) — conversation + structured output contract
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `SZEMÉLYISÉG
Te az "Aqua System" digitális árajánló asszisztense vagy. Egynapos gázkészülék- és kazáncserével foglalkozó épületgépész csapat nevében beszélsz. Kizárólag MAGYARUL válaszolj.

HANGNEM
- Udvarias, közvetlen, szakértő és tömör. Lehetőleg 45 szó alatt válaszolj.
- Egyszerre EGY kérdést tegyél fel. Sose kérdezz több dolgot egyszerre.
- Sose találgass árat és sose számolj — az árat a rendszer számolja ki a végén.

TUDÁSBÁZIS — A CÉGRŐL (csak akkor használd, ha az ügyfél KÖZBEN kérdez valamit — utána MINDIG térj vissza a soron következő kérdéshez, ugyanabban a válaszban)
- Cég: Aqua System Service Kft. — egynapos gázkészülék- és kazáncsere, teljes körű épületgépészeti kivitelezéssel.
- Elérhetőségek: telefon +36 20 399 0093, e-mail keszulekcsere@aqua-system.hu.
- Szolgáltatási terület: Budapest és az agglomeráció — pl. Érd, Diósd, Tárnok, Halásztelek. Ha bizonytalan a cím, mondd: telefonon gyorsan tisztázzák.
- Tapasztalat: közel 50 év épületgépészeti tapasztalat, 500+ sikeres készülékcsere.
- EGYNAPOS CSERE: a legtöbb készülékcserét EGYETLEN munkanap alatt elvégezzük — a régi leszerelésétől az új beszerelésén át a beüzemelésig. A pontos időt a helyszíni felmérés után erősítjük meg.
- FONTOS: az Aqua System KIZÁRÓLAG kondenzációs gázkészüléket épít be (modern, hatékony, kb. 15–30%-kal kevesebbet fogyaszt egy régi típusnál). Hagyományos, nyílt égésterű vagy turbós készüléket NEM szerelünk be. Ha az ügyfél ilyet kérne, magyarázd el kedvesen, hogy ma már a kondenzációs a szabvány, és ezt építjük be.
- Ügyintézés: a teljes folyamatot mi visszük — készülék kiválasztása, engedélyeztetés, papírmunka, dokumentált beüzemelés.
- Árazás elve: a felmérés után FIX, előre megmondott árat adunk — utólagos ráfizetés és rejtett költség nincs. Az ár tartalmazza a szerelést, a beüzemelést és az ügyintézést is.
- Garancia: minden kivitelezésre és a beszerelt új gázkészülékre is hivatalos garanciát adunk. A munka után is elérhetőek maradunk.
- Mikor kell cserélni: 12 évnél idősebb készüléket érdemes felülvizsgáltatni, 18 évnél idősebbnél már ajánlott a csere (többet fogyaszt, gyakrabban hibásodik, kevésbé biztonságos).
- Gázszag esetén MINDIG mondd: azonnal zárja el a gázt, szellőztessen, és hívjon telefonon — ne kísérletezzen. Távolról ne diagnosztizálj komolyabb hibát.
- Ha olyat kérdeznek, ami nincs itt (pl. pontos ár egy konkrét munkára, aznapi időpont), ne találgass: irányítsd telefonra (+36 20 399 0093) vagy mondd, hogy a felmérésnél a kollégák pontosítják.

CÉL
Végigvezeted az ügyfelet az alábbi kérdéseken, majd elkéred az elérhetőségeit. A kérdéseket természetesen, sorban tedd fel. FONTOS: a rendszer már köszöntötte az ügyfelet — NE köszönj újra, rögtön az 1. kérdéssel kezdj.

KÖZÉRTHETŐSÉG (nagyon fontos!)
Az ügyfél laikus, nem szakember. Minden kérdést EGYSZERŰEN, hétköznapi nyelven tegyél fel, és a szakszavakat MINDIG magyarázd el. Ha az ügyfél nem ért valamit vagy azt írja "nem tudom" / "ez mit jelent", magyarázd el türelmesen, hétköznapi példával, és kérd, hogy a legjobb tudása szerint válaszoljon.

FORMÁZÁS — KÖTELEZŐ MINDEN KÉRDÉSNÉL
Az ügyfél PÁSZTÁZZA a szöveget, nem olvassa. Ezért a válaszod SOHA ne legyen egyetlen hosszú, zárójeles mondat. Minden kérdésed pontosan így épüljön fel:
1) Ha nyugtázod az előző választ, az EGY rövid szó legyen a saját sorában (pl. "Rendben." / "Köszönöm!"). Utána üres sor.
2) MAGA A KÉRDÉS **félkövérrel**, a saját sorában, rövid mondatként. Például: **Hányan laknak a lakásban?**
3) Ha magyarázat kell, utána LEGFELJEBB 3 rövid felsorolási pont, mindegyik "• " jellel kezdve. A pont ELEJÉN álljon a kulcsszó **félkövérrel**, utána gondolatjel és legfeljebb 6-8 szó.
SZABÁLYOK: soha ne írj hosszú, zárójeles magyarázó bekezdést. Soha ne szedj félkövérrel egész mondatot — csak a kérdést és a kulcsszavakat. Ha a gombok magukért beszélnek (keret, határidő), elég a félkövér kérdés, felsorolás nélkül.

PÉLDA a helyes formára:
Rendben.

**Milyen készüléket kell leszerelni?**
• **Kondenzációs** – modern, műanyag füstcsővel
• **Hagyományos** – régi, nyílt égésterű vagy turbós
• Hagyományosnál a **kéményt is át kell alakítani**

FONTOS — "NEM TUDOM": minden választós kérdésnél van "Nem tudom" lehetőség is. Ha az ügyfél nem tudja vagy bizonytalan, fogadd el a "nem_tudom" értéket és lépj tovább — a rendszer ilyenkor a legkedvezőbb (legolcsóbb) feltételezéssel számol, a felmérés pedig pontosít. NE erőltesd a választ.

KÉRDÉSEK SORRENDJE (egyesével, mindig csak EGY kérdés!). ELŐSZÖR a projekttel kapcsolatos 1–8. kérdést tedd fel, és CSAK utána, a végén kérd el az elérhetőségeket (9–12.):
1. old_boiler — kérdés: **Milyen készüléket kell leszerelni?** Pontok: • **Kondenzációs** – modern, műanyag füstcsővel • **Hagyományos** – régi, nyílt égésterű vagy turbós • Hagyományosnál a **kéményt is át kell alakítani**. (Háttér neked: a régi kémény nem alkalmas kondenzációs kazánhoz, saválló béléscső kell — ezt a rendszer beleszámolja, ne kérdezd külön.) Értékek: "kondenzacios", "hagyomanyos", "nem_tudom".
2. occupants — kérdés: **Hányan laknak a lakásban?** Pontok: • Ebből tudjuk, mennyi **melegvíz** kell • Ez alapján méretezzük a **készülék méretét**. Értékek: "o_1_2" (1–2 fő), "o_3_4" (3–4 fő), "o_5plus" (5 vagy több), "nem_tudom".
3. new_boiler — kérdés: **Milyen új készüléket szeretne?** A kérdés alatt egy rövid sor: "Mindegyik **kondenzációs**." Pontok: • **Kombi (24 kW)** – azonnal melegít, kis helyigény • **Tárolós 46 l** – több melegvíz egyszerre • **Külső 125 l** – nagy családnak. Vedd figyelembe a lakók számát: 1–2 főnél a kombit, 3–4 főnél a tárolósat, 5+ főnél a külső tárolósat ajánld egy fél mondatban. Értékek: "kombi_24", "tarolos_46", "kulso_125", "nem_tudom".
4. flue — kérdés: **Hogyan távozik a kazán füstgáza?** Pontok: • **Tetőn keresztül** – a tetőn kivezetve • **Tégla kéménybe** – meglévő, épített kémény • **Gyűjtőkémény** – társasházi, közös kémény. Értékek: "teto", "tegla_kemeny", "gyujtokemeny", "nem_tudom".
5. rcd — kérdés: **Van a lakásban életvédelmi (Fi-)relé?** Pontok: • Biztonsági kapcsoló a **biztosítékszekrényben** • Általában **„TESZT" gomb** van rajta • **Áramütés ellen** véd. Értékek: "van", "nincs", "nem_tudom".
6. warranty — kérdés: **Hány év garanciát szeretne a készülékre?** Pontok: • **2 év** – gyári alapgarancia, ingyenes • **5 vagy 10 év** – felárral kiterjeszthető. Értékek: "w_2", "w_5", "w_10", "nem_tudom".
7. budget — kérdés: **Nagyjából milyen összeget szánna a beruházásra?** Felsorolás NEM kell, a gombok magukért beszélnek. NE sorold fel a sávokat szövegben — a választógombokat a rendszer megjeleníti alattuk. A sávok (csak a te tudásodra): 1 millió Ft alatt → b_1m; 1–1,5 millió Ft → b_1_1_5; 1,5–2 millió Ft → b_1_5_2; 2 millió Ft felett → b_2m; "Még nem tudom" → b_unsure. Ha az ügyfél konkrét számot mond, sorold be a megfelelő sávba.
8. timeline — kérdés: **Mikorra szeretné a kivitelezést?** Felsorolás NEM kell, a gombok magukért beszélnek. Lehetőségek (csak a te tudásodra): Amint lehet → t_asap; Egy hónapon belül → t_month; Fél éven belül → t_halfyear; Még idén → t_thisyear; "Még nem tudom" → t_unsure. Az ügyfél szabad szöveggel is válaszolhat — sorold be a legközelebbi lehetőségre.

ELÉRHETŐSÉGEK — a 8. kérdés UTÁN. FONTOS: a négy elérhetőségi adatot a RENDSZER kéri be EGYETLEN ŰRLAPON, közvetlenül a te válaszod alatt. Ezért a 8. kérdés után CSAK EGY rövid átvezető mondatot írj, és NE tedd fel egyesével a 9–12. kérdést, NE kérdezd külön a nevet. Ez is a FORMÁZÁS szabályai szerint nézzen ki. Példa a teljes válaszodra:
"Köszönöm, minden megvan a kalkulációhoz!

**Már csak az elérhetőségei kellenek.**
• Erre küldjük a **személyre szabott árajánlatot**
• Ezen egyeztetjük az **ingyenes felmérést**"
A mezők, amiket az űrlap bekér (csak a te tudásodra): 9. name, 10. email, 11. phone, 12. postal_code.
KIVÉTEL: ha az ügyfél mégis egyesével, szabad szöveggel válaszol (mert nem az űrlapot használja), akkor kérdezd a soron következő hiányzó adatot egyesével, röviden megindokolva, miért kéred.

MEGJEGYZÉS: A vizes rendszerre kötést, a gyári üzembe helyezést és a régi kazán/kémény bontását NE kérdezd meg — ezek minden ajánlatban benne vannak, a rendszer automatikusan hozzáadja. A kéményátalakítást se kérdezd külön: ha az 1. kérdésre "hagyományos" a válasz, a rendszer magától hozzáadja.

SZABÁLYOK
- Az ügyfél írhat szabad szöveggel is — értelmezd a válaszát és rendeld hozzá a megfelelő értéket.
- Ha egy válasz nem egyértelmű, EGYSZER kérdezz vissza, utána lépj tovább.
- Ne ígérj fix időpontot. Árat ne mondj a folyamat közben.

REJTETT ÁLLAPOT (KÖTELEZŐ MINDEN VÁLASZBAN)
MINDEN egyes válaszod legvégére tedd ki az eddig ismert adatokat ebben a rejtett blokkban (az ügyfél NEM látja). A még meg nem kérdezett mezők értéke üres string (""). SOSE találgass — csak azt töltsd ki, amit az ügyfél ténylegesen megválaszolt:
<!--DATA:{"old_boiler":"","occupants":"","new_boiler":"","flue":"","rcd":"","warranty":"","name":"","email":"","phone":"","postal_code":"","budget":"","timeline":""}-->
A blokkban MINDEN kulcs mindig szerepeljen, csak az értékeket töltsd. Engedélyezett értékek: old_boiler: kondenzacios|hagyomanyos|nem_tudom; occupants: o_1_2|o_3_4|o_5plus|nem_tudom; new_boiler: kombi_24|tarolos_46|kulso_125|nem_tudom; flue: teto|tegla_kemeny|gyujtokemeny|nem_tudom; rcd: van|nincs|nem_tudom; warranty: w_2|w_5|w_10|nem_tudom; budget: b_1m|b_1_1_5|b_1_5_2|b_2m|b_unsure; timeline: t_asap|t_month|t_halfyear|t_thisyear|t_unsure. A többi (name, email, phone, postal_code) szabad szöveg.
Amikor minden szükséges mező megvan, írj egy RÖVID lezáró mondatot (pl. "Köszönöm, összeállítom az árajánlatot!") — és továbbra is tedd ki a teljes, kitöltött DATA blokkot. Az árat NE te írd ki; a rendszer számolja és mutatja.
A választógombokat a rendszer automatikusan megjeleníti — neked nem kell gombokat kiírnod.`;

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
                        // gemini-2.5-flash is a "thinking" model: its internal
                        // reasoning tokens count against maxOutputTokens and were
                        // starving the visible answer (messages cut off mid-word).
                        // This bot follows a fixed script — no reasoning needed —
                        // so disable thinking. Faster, cheaper, and no truncation.
                        thinkingConfig: { thinkingBudget: 0 },
                    },
                }),
            }
        );
        const data = await res.json();
        const cand = data.candidates?.[0];
        // Join every text part (defensive — normally there is just one).
        const text = (cand?.content?.parts || [])
            .map(p => p?.text || "")
            .join("");
        if (cand?.finishReason === "MAX_TOKENS") {
            console.warn("Gemini hit MAX_TOKENS — answer may be truncated.");
        }
        if (text) return { ok: true, text };
        return { ok: false, error: data.error?.message || JSON.stringify(data) };
    } catch (e) {
        return { ok: false, error: e.message };
    }
}

// Price, log, notify and render the finished quote. Shared by the fast path
// (contact form completed the state) and the normal end-of-conversation turn.
async function finishWithQuote(sel, response, progressTotal) {
    const quote = buildQuote(sel);

    console.log("\n========================================");
    console.log("ÚJ ÁRAJÁNLAT / LEAD");
    console.log(`Ügyfél: ${sel.name} | ${sel.phone} | ${sel.email}`);
    console.log(`Irsz.: ${sel.postal_code} | Keret: ${sel.budget}`);
    console.log(`Becsült végösszeg: ${formatHuf(quote.total)}`);
    console.log("========================================\n");

    // Always notify the owner + log the lead into the Google Sheet.
    // Run both in parallel; neither blocks the other or the response.
    await Promise.all([
        sendQuoteEmail(sel, quote, { to: process.env.LEAD_EMAIL_TO || "pirint.milan@gmail.com", toCustomer: false }),
        sendLeadToSheet(sel, quote),
    ]);

    return response.status(200).json({
        answer: renderCustomerQuote(quote, sel),
        chips: [],
        emailOffer: EMAIL_OFFER_ENABLED,
        lead: { sel, quote },
        state: sel,
        progress: progressTotal,
        progressTotal,
    });
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------
export default async function handler(request, response) {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

    if (request.method === "OPTIONS") {
        return response.status(200).end();
    }

    try {
        const { question, history, action, lead, state } = request.body || {};

        // --- ACTION: customer asked us to e-mail them the quote ---
        if (action === "email_customer" && lead?.sel && lead?.quote) {
            const ok = await sendQuoteEmail(lead.sel, lead.quote, {
                to: lead.sel.email,
                toCustomer: true,
            });
            return response.status(200).json({
                answer: ok
                    ? `Elküldtük az árajánlatot a megadott e-mail címre (${lead.sel.email}). 📧 Ha nem találja, nézze meg a Spam mappát is.`
                    : `Sajnos most nem sikerült e-mailt küldeni, de kollégánk hamarosan keresi Önt. 📞 +36 20 399 0093`,
                chips: [],
            });
        }

        const progressTotal = PROGRESS_FIELDS.length;

        // --- STATE, assembled BEFORE the model is called -------------------
        // The widget carries the accumulated state back to us each turn, so we
        // can work out what the customer just answered without the model's
        // help. (history DATA blocks are merged as a harmless fallback.)
        const priorSel = Array.isArray(history)
            ? history
                .filter((m) => m && (m.role === "assistant" || m.role === "model"))
                .map((m) => extractData(m.content))
            : [];
        const baseSel = mergeState(state, ...priorSel);

        // Deterministically record the answer the customer just gave into the
        // field they were being asked — so the chips advance immediately and
        // don't lag a step behind the model's (one-turn-late) state block.
        const determined = {};
        const pending = pendingField(baseSel);
        if (pending) {
            const v = mapAnswer(pending, question);
            if (v) determined[pending] = v;
        }

        // FAST PATH: everything needed is already known (the contact form fills
        // the last four fields in one go). There is nothing left for the model
        // to ask, so skip the API call entirely — it saves a round-trip the
        // customer would otherwise wait through, and a request we'd pay for.
        const earlySel = mergeState(baseSel, determined);
        if (isQuoteReady(earlySel)) {
            return await finishWithQuote(earlySel, response, progressTotal);
        }

        // Normalized message list: [{ role: "system"|"user"|"assistant", content }]
        // The widget sends history as [{ role: "user"|"assistant", content }].
        const messages = [{ role: "system", content: SYSTEM_PROMPT }];
        if (Array.isArray(history) && history.length > 0) {
            for (const m of history) {
                if (m && m.role && typeof m.content === "string") {
                    messages.push({ role: m.role === "model" ? "assistant" : m.role, content: m.content });
                }
            }
        } else if (question) {
            messages.push({ role: "user", content: question });
        }

        // Provider is switchable via .env (AI_PROVIDER=openai | gemini).
        // Gemini has a free tier — handy for testing without billing.
        const provider = (process.env.AI_PROVIDER || "openai").toLowerCase();
        const result = provider === "gemini"
            ? await callGemini(messages)
            : await callOpenAI(messages);

        if (!result.ok) {
            console.error(`[${provider}] API Error:`, result.error);
            return response.status(200).json({ answer: "Elnézést, most nem érem el az asszisztenst. Kérlek próbáld újra." });
        }

        let aiAnswer = result.text;
        if (!aiAnswer) {
            return response.status(200).json({ answer: "Értem, de ezt nem sikerült feldolgoznom. Megfogalmaznád másképp?" });
        }

        // --- STATE: extract the running DATA block from THIS message ... ---
        let currentSel = null;
        const dataMatch = aiAnswer.match(/<!--DATA:(.*?)-->/s);
        if (dataMatch) {
            try { currentSel = sanitizeChoices(JSON.parse(dataMatch[1])); }
            catch (e) { console.error("DATA parse fail:", e.message); }
            aiAnswer = aiAnswer.replace(/<!--DATA:.*?-->/s, "").trim();
        }

        // Final state, by ascending trust: the model's own block (currentSel)
        // is LEAST trusted — it can hallucinate or drop fields — so it only
        // fills genuine gaps. The accumulated state (baseSel) overrides it, and
        // this turn's deterministically-mapped answer (determined) wins outright.
        // This stops a bad model turn from rewriting answers the customer
        // actually gave.
        const sel = mergeState(currentSel, baseSel, determined);

        // Progress for the widget's progress bar: how many of the PROJECT
        // questions are answered (contact details are not counted, so the bar
        // reaches 100% just before we ask for them).
        const progress = PROGRESS_FIELDS.filter(
            (f) => sel[f] != null && String(sel[f]).trim() !== ""
        ).length;

        // --- COMPLETION CHECK (backend-decided, model-independent) ---
        if (isQuoteReady(sel)) {
            return await finishWithQuote(sel, response, progressTotal);
        }

        // Strip any chips marker the model may still emit (we compute chips ourselves).
        aiAnswer = aiAnswer.replace(/<!--CHIPS:.*?-->/s, "").trim();

        // --- QUICK-REPLY CHIPS (backend-decided, reliable) ---
        const chips = nextChips(sel);

        // The project questions are done and the contact details are next. Tell
        // the widget to render all four as a single form rather than making the
        // customer answer four separate questions.
        const contactForm = pendingField(sel) === "name";

        return response.status(200).json({ answer: aiAnswer, chips, contactForm, state: sel, progress, progressTotal });

    } catch (error) {
        console.error("Function Crash:", error.message);
        return response.status(500).json({ answer: "Elnézést, a szerver épp akadozik. Kérlek próbáld újra kicsit később." });
    }
}

// ---------------------------------------------------------------------------
//  E-mail (Resend). opts = { to, toCustomer }. Returns true on success.
//  - owner mail: full client details + quote
//  - customer mail: friendly "your quote" version
// ---------------------------------------------------------------------------
async function sendQuoteEmail(sel, quote, opts = {}) {
    const resendKey = process.env.RESEND_API_KEY;
    const toEmail = opts.to || process.env.LEAD_EMAIL_TO || "pirint.milan@gmail.com";
    const fromEmail = process.env.LEAD_EMAIL_FROM || "Aqua System <onboarding@resend.dev>";
    const toCustomer = !!opts.toCustomer;

    if (!resendKey) {
        console.log("⚠️  Nincs RESEND_API_KEY — az e-mail kimarad. A lead a fenti logban szerepel.");
        return false;
    }
    if (!toEmail) {
        console.log("⚠️  Nincs címzett e-mail cím — kihagyva.");
        return false;
    }

    const itemRows = quote.items
        .map(i => `<tr><td style="padding:6px 12px;border-bottom:1px solid #eee">${i.label}</td><td style="padding:6px 12px;border-bottom:1px solid #eee;text-align:right;white-space:nowrap">${formatHuf(i.huf)}</td></tr>`)
        .join("");

    const installTypeLabel = quote.isReplacement ? "Meglévő kazán cseréje" : "Új rendszer kiépítése";

    // Client-details block is only included in the owner's copy.
    const clientBlock = toCustomer ? "" : `
        <h3 style="margin:0 0 8px">Ügyfél adatai</h3>
        <p style="margin:4px 0"><b>Név:</b> ${sel.name || "-"}</p>
        <p style="margin:4px 0"><b>Telefon:</b> ${sel.phone || "-"}</p>
        <p style="margin:4px 0"><b>E-mail:</b> ${sel.email || "-"}</p>
        <p style="margin:4px 0"><b>Irányítószám:</b> ${sel.postal_code || "-"}</p>
        <p style="margin:4px 0"><b>Lakók száma:</b> ${lbl("occupants", sel.occupants)}</p>
        <p style="margin:4px 0"><b>Kért garancia:</b> ${lbl("warranty", sel.warranty)}</p>
        <p style="margin:4px 0"><b>Tervezett keret:</b> ${lbl("budget", sel.budget)}</p>
        <p style="margin:4px 0"><b>Tervezett kivitelezés:</b> ${lbl("timeline", sel.timeline)}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">`;

    const heading = toCustomer ? "Az Ön árajánlata — Aqua System" : "Új árajánlat — Aqua System";
    const intro = toCustomer
        ? `<p style="margin:0 0 12px">Kedves ${sel.name || "Ügyfelünk"}! Köszönjük érdeklődését. Íme az előzetes árajánlata:</p>`
        : "";

    // Owner notifications stay plain/transactional-looking (no colored banner) —
    // a marketing-style template with a bold color header is what commonly gets
    // Gmail's Promotions-tab classifier to flag it, dropping it out of the inbox.
    const html = toCustomer ? `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <div style="background:#2b5fd0;color:#ffffff;padding:20px 24px;border-radius:12px 12px 0 0">
        <h2 style="margin:0">${heading}</h2>
      </div>
      <div style="border:1px solid #e5e7eb;border-top:none;padding:24px;border-radius:0 0 12px 12px">
        ${intro}${clientBlock}
        <h3 style="margin:0 0 8px">Munka jellege</h3>
        <p style="margin:4px 0"><b>Típus:</b> ${installTypeLabel}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        <h3 style="margin:0 0 8px">Kalkulált árajánlat</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${itemRows}
          <tr><td style="padding:10px 12px;font-weight:bold">Becsült végösszeg</td><td style="padding:10px 12px;text-align:right;font-weight:bold;color:#0f2a5e">${formatHuf(quote.total)}</td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#6b7280">Előzetes, tájékoztató jellegű kalkuláció, bruttó (ÁFÁ-val). Az ár tartalmazza a kazánt és a teljes beépítést; a pontos márka/típus a helyszíni felmérés után véglegesül. 📞 +36 20 399 0093</p>
      </div>
    </div>` : `
    <div style="font-family:Arial,sans-serif;max-width:640px;margin:0 auto;color:#111827">
      <h2 style="margin:0 0 16px;font-size:18px">${heading}</h2>
      <div style="border:1px solid #e5e7eb;padding:24px;border-radius:8px">
        ${intro}${clientBlock}
        <h3 style="margin:0 0 8px">Munka jellege</h3>
        <p style="margin:4px 0"><b>Típus:</b> ${installTypeLabel}</p>
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0">
        <h3 style="margin:0 0 8px">Kalkulált árajánlat</h3>
        <table style="width:100%;border-collapse:collapse;font-size:14px">${itemRows}
          <tr><td style="padding:10px 12px;font-weight:bold">Becsült végösszeg</td><td style="padding:10px 12px;text-align:right;font-weight:bold;color:#0f2a5e">${formatHuf(quote.total)}</td></tr>
        </table>
        <p style="margin:16px 0 0;font-size:12px;color:#6b7280">Előzetes, tájékoztató jellegű kalkuláció, bruttó (ÁFÁ-val). Az ár tartalmazza a kazánt és a teljes beépítést; a pontos márka/típus a helyszíni felmérés után véglegesül.${toCustomer ? " 📞 +36 20 399 0093" : ""}</p>
      </div>
    </div>`;

    // No brackets/ALL-CAPS in the subject — that pattern is a common trigger for
    // Gmail's Promotions-tab / spam classifier on transactional owner mail.
    const subject = toCustomer
        ? `Az Ön árajánlata — Aqua System — ${formatHuf(quote.total)}`
        : `Új árajánlat — ${sel.name || ""} (${sel.postal_code || ""}) — ${formatHuf(quote.total)}`;

    // Plain-text fallback alongside the HTML — multipart mail is a deliverability
    // best practice and HTML-only messages are more likely to get flagged.
    const itemLines = quote.items.map(i => `- ${i.label}: ${formatHuf(i.huf)}`).join("\n");
    const text = toCustomer
        ? [
            `Kedves ${sel.name || "Ügyfelünk"}!`,
            "",
            "Köszönjük érdeklődését. Íme az előzetes árajánlata:",
            "",
            itemLines,
            "",
            `Becsült végösszeg: ${formatHuf(quote.total)}`,
            "",
            "Előzetes, tájékoztató jellegű kalkuláció, bruttó (ÁFÁ-val). Az ár tartalmazza a kazánt és a teljes beépítést; a pontos márka/típus a helyszíni felmérés után véglegesül.",
            "+36 20 399 0093",
        ].join("\n")
        : [
            "Új árajánlat érkezett.",
            "",
            `Név: ${sel.name || "-"}`,
            `Telefon: ${sel.phone || "-"}`,
            `E-mail: ${sel.email || "-"}`,
            `Irányítószám: ${sel.postal_code || "-"}`,
            `Lakók száma: ${lbl("occupants", sel.occupants)}`,
            `Kért garancia: ${lbl("warranty", sel.warranty)}`,
            `Tervezett keret: ${lbl("budget", sel.budget)}`,
            `Tervezett kivitelezés: ${lbl("timeline", sel.timeline)}`,
            "",
            itemLines,
            "",
            `Becsült végösszeg: ${formatHuf(quote.total)}`,
        ].join("\n");

    // Reply-To: the sending address itself has no real inbox behind it (send-only
    // domain), so a bare "Reply" would vanish. Point owner mail at the customer's
    // address (reply goes straight to the lead) and customer mail at the business's
    // real inbox — never left pointing at a dead end.
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const replyTo = toCustomer
        ? "keszulekcsere@aqua-system.hu"
        : (EMAIL_RE.test(sel.email || "") ? sel.email : undefined);

    try {
        const emailRes = await fetch("https://api.resend.com/emails", {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${resendKey}` },
            body: JSON.stringify({ from: fromEmail, to: [toEmail], subject, html, text, ...(replyTo ? { reply_to: replyTo } : {}) }),
        });

        const result = await emailRes.json();
        if (emailRes.ok) {
            console.log(`✅ Árajánlat e-mail elküldve (${toCustomer ? "ügyfél" : "tulajdonos"}):`, result.id);
            return true;
        }
        console.error("❌ Resend hiba:", JSON.stringify(result));
        return false;
    } catch (emailErr) {
        console.error("❌ Nem sikerült elküldeni az e-mailt:", emailErr.message);
        return false;
    }
}

// ---------------------------------------------------------------------------
//  Google Sheet logging. POSTs the lead to a Google Apps Script web app, which
//  appends one row to the spreadsheet. Set SHEETS_WEBHOOK_URL in .env to the
//  deployed Apps Script URL (see README). No-ops (returns false) if unset, so
//  the quote flow keeps working without it. The `row` array order MUST match
//  the header row in the Apps Script / sheet.
// ---------------------------------------------------------------------------
async function sendLeadToSheet(sel, quote) {
    const url = process.env.SHEETS_WEBHOOK_URL;
    if (!url) {
        console.log("ℹ️  Nincs SHEETS_WEBHOOK_URL — a lead nem kerül Google Sheetbe (csak e-mail).");
        return false;
    }

    // One row per lead. Keep this order in sync with the sheet's header row.
    const row = [
        new Date().toISOString(),               // Időbélyeg
        sel.name || "",                         // Név
        sel.phone || "",                        // Telefon
        sel.email || "",                        // E-mail
        sel.postal_code || "",                  // Irányítószám
        lbl("budget", sel.budget),              // Tervezett keret
        lbl("timeline", sel.timeline),          // Tervezett kivitelezés
        lbl("old_boiler", sel.old_boiler),      // Leszerelendő készülék
        lbl("occupants", sel.occupants),        // Lakók száma
        lbl("new_boiler", sel.new_boiler),      // Új kazán
        lbl("flue", sel.flue),                  // Kémény
        lbl("rcd", sel.rcd),                    // Életvédelmi relé
        lbl("warranty", sel.warranty),          // Kért garancia
        quote.total,                            // Becsült végösszeg (Ft)
    ];

    try {
        const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ row }),
        });
        if (res.ok) {
            console.log("✅ Lead beírva a Google Sheetbe.");
            return true;
        }
        console.error("❌ Google Sheet hiba:", res.status, await res.text());
        return false;
    } catch (err) {
        console.error("❌ Nem sikerült a Google Sheetbe írni:", err.message);
        return false;
    }
}

# Aqua System — Árajánló chat widget

A Hungarian gas‑boiler quoting chat widget for **Aqua System Service Kft.**
(egynapos gázkészülék csere, Budapest és agglomeráció). The customer answers a
short set of questions (clicking suggested options **or** typing freely), gives
their contact details, then immediately sees an itemised estimate. The company
owner receives the same quote + the customer's details by e‑mail.

Forked from the *Kazán Kecskemét* (gazszerelokecskemet) widget — same engine,
same flow. What differs is listed under **Aqua System changes** below.

---

## Aqua System changes vs. the Kecskemét version

1. **Only condensing boilers.** Every `new_boiler` option is condensing, and the
   assistant explains that Aqua System does not fit open‑flue or turbo units.
2. **"Mit kell leszerelni?"** replaces the old *"Milyen kazánja van most?"*
   question. Two answers: **kondenzációs** or **hagyományos**. If the old unit is
   **hagyományos**, the existing chimney is not suitable for a condensing boiler,
   so a `chimney_conversion` line (saválló béléscső) is added automatically —
   the customer is never asked about it.
3. **"Hányan laknak a lakásban?"** — a new question (`occupants`). It carries no
   price; it sizes the hot‑water demand, so the assistant can steer the customer
   toward combi vs. 46 L vs. 125 L storage, and the owner sees it on the lead.
4. **"Hány év garancia kell?"** — a new question (`warranty`). 2 years is the
   free factory baseline; 5 and 10 years carry a surcharge.
5. **One form instead of four questions.** Name / e-mail / phone / postal code
   used to be four separate round-trips to the model. The backend now sets
   `contactForm: true` on the turn they come due, the widget renders all four as
   one validated form, and submitting it completes the state — so the quote comes
   back **without calling the model at all** (~0.4s, versus four further model
   turns).
6. **The quote reads as a document, not a wall of bullets.** The breakdown is
   grouped into sections (készülék / kémény / bontás / szerelés / garancia), the
   total is a highlighted callout, and two new blocks spell out what the price
   **does** and **does not** cover, followed by a "mi történik ezután" step list.
   `## ` and `>> ` in a bot message render as a section heading and the total.
7. **Branding** — Aqua System logo (`public/logo.webp`), blue `#2b5fd0` / navy
   `#0f2a5e` palette, phone `+36 20 399 0093`, e‑mail
   `keszulekcsere@aqua-system.hu`, and a knowledge base rewritten around the
   one‑day replacement, ~50 years of experience, 500+ jobs, fixed price after
   survey, and full permit handling.

> **Prices to confirm.** Everything except two lines is carried over from the
> Kecskemét price sheet. The **chimney conversion (260 000 Ft)** and the
> **extended warranty (5 év +60 000 / 10 év +150 000)** are placeholders —
> replace them with Aqua System's own numbers in `PRICES`.

---

## How it works (architecture)

```
public/widget.js   ──POST──►  api/faq-agent.js  ──►  OpenAI (model via .env)  = conversation only
   (chat UI)                       │
                                   ├──►  PRICES table  = deterministic price calc
                                   └──►  Resend         = e-mail to owner
```

**The AI never does arithmetic.** It only runs the Hungarian conversation and,
once every answer is collected, emits a hidden JSON block of the customer's
*choices* (not prices). The backend looks each choice up in the fixed `PRICES`
table, sums it, and builds the quote. This is why the total can never be
miscalculated by the model.

---

## How the price is calculated

All prices are in **HUF**, gross (ÁFA included), and include the appliance plus
the full installation. The total is simply the sum of the applicable items
below. Edit them in **one place**: the `PRICES` object at the top of
[`api/faq-agent.js`](api/faq-agent.js).

| # | Question | Options → amount added |
|---|---|---|
| 1 | **Mit kell leszerelni?** | kondenzációs +0 · hagyományos +60 000 **and** +260 000 kéményátalakítás |
| 2 | **Hányan laknak a lakásban?** | 1–2 fő / 3–4 fő / 5+ — **no price**, sizing + lead info only |
| 3 | **Új (kondenzációs) kazán** | kombi 24 kW +450 000 · tárolós 46 L +900 000 · külső 125 L +900 000 |
| 4 | **Kémény / égéstermék‑elvezetés** | tetőn ki +380 000 · tégla kéménybe +600 000 · társasházi gyűjtőkémény +600 000 |
| 5 | **Életvédelmi (Fi) relé** | van +50 000 · nincs +100 000 |
| 6 | **Hány év garancia?** | 2 év +0 · 5 év +60 000 · 10 év +150 000 |
| 7 | **Tervezett keret** | no price — lead qualification |
| 8 | **Tervezett kivitelezés** | no price — lead qualification |
| — | **Always added (not asked)** | vizes rendszerre kötés +300 000 · gyári üzembe helyezés +50 000 · régi kazán/kémény bontása +90 000 |

**Total = sum of the selected rows + the always‑added standard costs.**

Every choice question also offers **"Nem tudom"**, which falls back to the
cheapest assumption and is corrected at the site survey.

### Decisions baked into the logic
- **Prices are GROSS and include the appliance + full installation**
  (`APPLIANCE_INCLUDED = true`).
- **Standard costs** (wet‑system, commissioning, demolition) are always added and
  never asked — the flow always quotes a replacement.
- **Chimney conversion** is derived, not asked: it is added only when
  `old_boiler === "hagyomanyos"`.
- **Only 24 kW** appliances; exact brand/model is decided at the site survey.
- **Contact details** are collected one field at a time at the very end
  (name → e‑mail → phone → postal code), after the progress bar hits 100%.

### Quote delivery
- The itemised estimate is **shown in the chat** as soon as all answers are in,
  split into easy‑to‑read bubbles (price → "just an estimate" note → a recap of
  everything the customer answered).
- The **owner always** receives it by e‑mail (with the client's details).
- The **customer is offered a button** to have the quote e‑mailed to *them* too
  (off until a verified Resend domain exists — see `EMAIL_OFFER_ENABLED`).
- Completion is decided by the **backend** (`isQuoteReady`) from a running hidden
  state block the model maintains — so the quote always appears even if the model
  phrasing varies. The model never computes the price.

---

## Setup & deploy

1. **Keys** — copy your secrets into `.env` (already git‑ignored):
   - `OPENAI_API_KEY` — from <https://platform.openai.com/api-keys>
   - `OPENAI_MODEL` — copy the exact model ID from your OpenAI dashboard. The
     task is tiny, so the cheapest tier is plenty (e.g. `gpt-5.4-nano`, or
     `gpt-5.4-mini`). The model never affects price accuracy — that's computed
     in the backend.
   - `RESEND_API_KEY` — free at <https://resend.com>
   - `LEAD_EMAIL_TO` — where quotes are sent
   - `LEAD_EMAIL_FROM` — leave as the `onboarding@resend.dev` test sender to start;
     later verify your own domain in Resend and change it.
2. **Run locally:** `node server.js` → <http://localhost:8888>
3. **Deploy (Vercel):** push the repo; set the same env vars in the Vercel
   dashboard. `api/faq-agent.js` is the serverless endpoint, `public/` is static.
4. **Embed on a site:**
   ```html
   <script>
     window.AQUA_CONFIG = {
       apiUrl: "https://YOUR-APP.vercel.app/api/faq-agent",
       assetsUrl: "https://YOUR-APP.vercel.app"
     };
   </script>
   <script src="https://YOUR-APP.vercel.app/widget.js"></script>
   ```

---

## Leads → Google Sheet

Every completed lead is also appended as a row to a Google Sheet. This is
**optional** — leave `SHEETS_WEBHOOK_URL` empty and the quote/e-mail flow still
works exactly as before.

Setup (one-time, ~3 minutes, no Google Cloud project needed):

1. Create a Google Sheet. In the first row, add these headers (this exact
   order — it matches the `row` array in `sendLeadToSheet`):

   `Időbélyeg | Név | Telefon | E-mail | Irányítószám | Tervezett keret | Tervezett kivitelezés | Leszerelendő készülék | Lakók száma | Új kazán | Kémény | Életvédelmi relé | Kért garancia | Becsült végösszeg (Ft)`

2. In that sheet: **Extensions → Apps Script**. Replace the contents with:

   ```javascript
   function doPost(e) {
     var sheet = SpreadsheetApp.getActiveSpreadsheet().getActiveSheet();
     var data = JSON.parse(e.postData.contents);
     sheet.appendRow(data.row);
     return ContentService
       .createTextOutput(JSON.stringify({ ok: true }))
       .setMimeType(ContentService.MimeType.JSON);
   }
   ```

3. **Deploy → New deployment → Web app.** Set *Execute as* = **Me**, and
   *Who has access* = **Anyone**. Deploy, authorise, and copy the **Web app URL**
   (ends in `/exec`).

4. Paste that URL into `SHEETS_WEBHOOK_URL` in `.env` (and into the same env var
   in the Vercel dashboard). Done — new leads now land in the sheet.

> The sheet only fills in once the customer completes the whole flow (same point
> the owner e-mail is sent). It runs in parallel with the e-mail, so neither
> blocks the other.

---

## Customising

- **Prices:** edit the `PRICES` object in `api/faq-agent.js`.
- **Questions / wording:** edit `SYSTEM_PROMPT` in `api/faq-agent.js`. If you add
  or remove a question, update `PRICES`, `CHIP_MAP`, `CHIP_VALUES`, `LABELS`,
  `FIELD_ORDER`, `PROGRESS_FIELDS`, `isQuoteReady`, the recap in
  `renderCustomerQuote`, and the `row` array in `sendLeadToSheet` to match.
- **Colours / branding:** `public/style.css` (brand blue `#2b5fd0`, navy
  `#0f2a5e`, cyan `#7fc4e8`, sky `#eaf3ff`). The logo is `public/logo.webp`.
- **Phone number / brand name:** `PHONE` and `BRAND` constants in
  `public/widget.js`.

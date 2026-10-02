# Aqua System — Árajánló chat widget

A Hungarian gas‑boiler quoting chat widget for **Aqua System Service Kft.**
(egynapos gázkészülék csere, Budapest és agglomeráció). The customer answers
five short questions (clicking buttons **or** typing freely), can attach photos
of the old boiler, gives a phone number, and immediately sees an itemised
**induló ár** (floor price) with everything that could be added on top spelled
out. Under the quote they can pick a warranty and request a survey slot. The
owner gets the lead by e‑mail with the photos attached, and a second e‑mail
when a survey slot is requested.

Forked from the *Kazán Kecskemét* (gazszerelokecskemet) widget.

> **Prices to confirm with the client.** The **chimney conversion
> (260 000 Ft)** and the **extended warranty (5 év +60 000 / 10 év +150 000)**
> are placeholders. Replace them with Aqua System's own numbers in `PRICES`.

---

## The flow (v2, 2026-10-02)

1. **Mit kell leszerelni?** kondenzációs / hagyományos / nem tudom
2. **Hányan laknak a lakásban?** sizes the hot-water demand
3. **Milyen új készüléket szeretne?** the button that fits the household is
   highlighted as *ajánlott* (1–2 fő: kombi, 3–4: tárolós 46 l, 5+: külső 125 l)
4. **Hova vezet most a kazán füstcsöve?** tető / tégla kémény / gyűjtőkémény
5. **Lefotózná a mostani kazánt?** optional, up to 3 photos, or *Kihagyom*
6. **Mikorra szeretné a cserét?**
7. One contact form: name, phone, postal code, e‑mail (**optional**)
8. The quote, then a panel with **warranty** (2 / 5 / 10 év, the price bubble
   updates in place), **survey booking** (next 8 working days × délelőtt /
   délután / bármikor) and, if enabled, **e‑mail me the quote**

What changed from v1, and why:

| Change | Why |
|---|---|
| Button clicks are answered from **templates in the backend**, no AI call | Every click used to wait 1–3 s for the model. Now it is instant and costs nothing. The model only runs when the customer types something we can't map. |
| Short typed answers are mapped too ("4", "kombi", "régi turbós", "minél hamarabb") | Same speed for people who type instead of clicking. Questions ("mi a különbség…?") still go to the model. |
| **Budget** question removed | The lowest band ("1 millió alatt") was below the cheapest possible quote, and it was asked before the customer had seen any price. |
| **Fi-relé** question removed | Laypeople can't answer it. The floor price assumes "van"; "nincs" is listed as a +50 000 Ft surcharge. |
| **Warranty** moved onto the quote | It is an upsell. It sells better next to the price than as question 6. |
| **Photo step** added | The owner sees the boiler and flue before calling, so many visits can be prepared or judged in advance. |
| **Floor price** ("Induló ár: X Ft-tól") + named surcharges | A single "becsült végösszeg" anchors the customer low; every "Nem tudom" now shows exactly what the dearer variant adds. |
| **E‑mail optional** | The owner calls; every extra required field loses people. |
| **Survey booking** under the quote | Turns a quote into an appointment. It is a *request*, confirmed by phone; there is no live calendar. |
| **Service area check** (postal code) | Outside Budapest + agglomeráció the customer gets a soft note and the owner e‑mail a red flag. Never blocks the quote. Edit `AGGLO_POSTAL_CODES`. |
| **Owner e‑mail**: call button, *Sürgős* flag (timeline = amint lehet), area flag, photos attached, surcharges the customer was told | Built to be read on a phone between jobs. |
| Chat **survives reloads** and navigation (sessionStorage) | A half-finished quote no longer disappears when the visitor clicks to another page. The teaser then says "Folytassa az árajánlatot". |
| **Deep link** `?ajanlat` / `#ajanlat` and `window.AquaWidget.open()` | For the Google Business Profile, ads, Facebook posts, QR codes. |
| **Auto-open** option (`autoOpenDelay`) | Opens once per visit, desktop only. The website uses it on /kazancsere only. |
| Post-quote actions **re-price on the server** and HTML-escape everything | The old `email_customer` action trusted a total and labels sent from the browser. |
| If the AI is down, the current question is repeated **with its buttons** | The customer is never stuck on an error message. |

---

## How it works (architecture)

```
public/widget.js   ──POST──►  api/faq-agent.js
   (chat UI)                       ├── button / mappable answer → template, no AI call
                                   ├── free text → OpenAI or Gemini (conversation only)
                                   ├── PRICES table → deterministic price calc
                                   └── Resend → owner e-mail (+ photos), Google Sheet
```

**The AI never does arithmetic** and never decides when the quote is done.
The backend keeps the state, decides which question is next (`FIELD_ORDER`),
and prices the answers from `PRICES`.

API actions (all `POST /api/faq-agent`):

| Body | Does |
|---|---|
| `{ action: "start" }` | First question |
| `{ question, history, state, photos? }` | One turn; `photos` only with the contact form |
| `{ action: "set_warranty", warranty, lead }` | Re-prices with the chosen warranty |
| `{ action: "book_survey", booking: { date, dayLabel, window }, lead }` | E‑mails the owner the requested slot |
| `{ action: "email_customer", lead }` | Customer copy (only when `EMAIL_OFFER=on` and an e‑mail was given) |

---

## How the price is calculated

All prices are **HUF, gross** (ÁFA included), appliance + full installation.
Edit them in **one place**: `PRICES` at the top of
[`api/faq-agent.js`](api/faq-agent.js).

| Line | Amount |
|---|---|
| Leszerelendő: kondenzációs / hagyományos | +0 / +60 000, and hagyományos adds **+260 000** kéményátalakítás |
| Új kazán: kombi 24 kW / tárolós 46 l / külső 125 l | +450 000 / +900 000 / +900 000 |
| Kémény: tetőn át / tégla kéménybe / gyűjtőkémény | +380 000 / +600 000 / +600 000 |
| Fi-relé ellenőrzése, bekötése (always) | +50 000 (if there is none: +50 000 more, shown as a surcharge) |
| Garancia: 2 / 5 / 10 év (picked on the quote) | +0 / +60 000 / +150 000 |
| Always: vizes rendszer, üzembe helyezés, bontás | +300 000, +50 000, +90 000 |

"Nem tudom" prices the cheapest variant **and** adds a surcharge line with the
exact difference to the dearer one.

---

## Setup & deploy

1. **Keys** in `.env` (git-ignored), see `.env.example`: `OPENAI_API_KEY`,
   `OPENAI_MODEL`, `RESEND_API_KEY`, `LEAD_EMAIL_TO`, `LEAD_EMAIL_FROM`,
   optionally `SHEETS_WEBHOOK_URL` and `EMAIL_OFFER`.
2. **Run locally:** `node server.js` → <http://localhost:8891>.
   **`node server.js --dry-run`** runs the whole flow without e‑mailing anyone
   or writing to the Sheet. Analytics are off on localhost.
3. **Deploy (Vercel):** push the repo; set the same env vars in the dashboard.
4. **Customer copy of the quote:** verify the sending domain (aqua-system.hu)
   in Resend, set `LEAD_EMAIL_FROM` to an address on it, then `EMAIL_OFFER=on`.
5. **Embed on a site:**
   ```html
   <script>
     window.AQUA_CONFIG = {
       apiUrl: "https://YOUR-APP.vercel.app/api/faq-agent",
       assetsUrl: "https://YOUR-APP.vercel.app",
       autoOpenDelay: 15000 // optional: open once per visit, desktop only
     };
   </script>
   <script src="https://YOUR-APP.vercel.app/widget.js"></script>
   ```
   Any button can call `window.AquaWidget.open()`. A link ending in
   `?ajanlat` or `#ajanlat` opens the chat straight away.

---

## Leads → Google Sheet (optional)

Header row, in this order (the first 14 columns are unchanged from v1, so an
existing sheet keeps working; v2 writes "nem kérdezett" into the two retired
columns and appends two):

`Időbélyeg | Név | Telefon | E-mail | Irányítószám | Tervezett keret | Tervezett kivitelezés | Leszerelendő készülék | Lakók száma | Új kazán | Kémény | Életvédelmi relé | Kért garancia | Induló ár (Ft) | Fotók száma | Terület`

Apps Script (Extensions → Apps Script), deployed as a web app (*Execute as: Me*,
*Who has access: Anyone*), URL into `SHEETS_WEBHOOK_URL`:

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

The warranty column records the choice at quote time; a later change arrives
with the survey-booking e‑mail.

---

## Customising

- **Prices:** `PRICES` in `api/faq-agent.js`.
- **Service area:** `AGGLO_POSTAL_CODES` in `api/faq-agent.js`.
- **Questions / wording:** the templates in `questionText()`; the model's copy
  in `SYSTEM_PROMPT`. Adding or removing a question means updating `CHIP_MAP`,
  `CHIP_VALUES`, `SYNONYMS`, `LABELS`, `FIELD_ORDER`, `PROGRESS_FIELDS`,
  `REQUIRED`, the recap in `renderCustomerQuote`, the sheet `row`, and the
  `aqua-system` field list in the quoting-dashboard repo.
- **Colours / branding:** `public/style.css`; logo `public/logo.webp`.
- **Phone / brand name:** `PHONE` and `BRAND` in `public/widget.js`, `PHONE`
  in `api/faq-agent.js`.
- **Tests:** there is no test runner in the repo; the flow was checked with a
  script that drives the handler end to end (all answers, quote, warranty,
  booking, bad input, AI down).

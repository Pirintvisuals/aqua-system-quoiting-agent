# Aqua System — Árajánló chat widget

A Hungarian gas‑boiler quoting chat widget for **Aqua System Service Kft.**
(egynapos gázkészülék csere, Budapest és agglomeráció). The customer answers
Ferenc's eight questions (clicking buttons **or** typing freely), fills in one
contact form, and immediately sees an itemised **induló ár** (floor price) with
everything that could be added on top spelled out. Under the quote they can
change the warranty and request a survey slot. The owner gets the lead by
e‑mail, and a second e‑mail when a survey slot is requested.

Forked from the *Kazán Kecskemét* (gazszerelokecskemet) widget.

> **Prices:** all from Aqua System. Ferenc confirmed the last two in November
> 2026: chimney conversion **~600 000 Ft**, 10-year-warranty appliance
> **~1 500 000 Ft** more than the 3-year one. Edit them in `PRICES`.

---

## The questions are Ferenc's

The eight questions, their order, wording and buttons were written by the
client (Ferenc). **Do not add, drop, reorder or reword them without his OK.**
They live word for word in `questionText()` and `CHIP_MAP` in
`api/faq-agent.js`.

Ferenc's corrections, November 2026: boiler types are described by **home type**
(kombi lakásba; beépített tárolós lakásba vagy kisebb családi házba, nagyobb
melegvíz-komfortért; külső tárolós családi házba), and warranty is set by law:
**3 év** for private customers (1 év for companies), or **10 év**, which means a
different appliance, not an extension. Nothing in between.

1. **Milyen készüléket kell leszerelni?** kondenzációs / hagyományos / nem tudom
2. **Hányan laknak a lakásban?**
3. **Milyen új készüléket szeretne?** kombi (lakásba) / tárolós 46 l (lakásba vagy kisebb családi házba) / külső 125 l (családi házba)
4. **Hogyan távozik a kazán füstgáza?** tető / tégla kémény / gyűjtőkémény
5. **Van a lakásban életvédelmi (Fi-)relé?** van / nincs / nem tudom
6. **Hány év garanciát szeretne a készülékre?** 3 év (törvényi) / 10 év (másik készülék)
7. **Nagyjából milyen összeget szánna a beruházásra?** budget bands
8. **Mikorra szeretné a kivitelezést?**

Then one form: név, e‑mail, telefon, irányítószám (all required). Then the
quote, with a panel to change the warranty, request a survey slot, and (if
enabled) get the quote by e‑mail.

An optional photo step ("fotózza le a kazánt") is built but **off**
(`PHOTO_STEP = false`), because it is not one of Ferenc's questions.

## What the 2026 rebuild added (around his questions)

| Change | Why |
|---|---|
| Button clicks are answered from **templates in the backend**, no AI call | Every click used to wait 1–3 s for the model. Now it is instant, costs nothing, and the quote works even when the AI account has no credit. |
| Short typed answers are mapped too ("4", "kombi", "régi turbós", "1,8 millió") | Same speed for people who type. Questions ("mi a különbség…?") still go to the model. |
| **Floor price** ("Induló ár: X Ft-tól") + named surcharges | Every "Nem tudom" shows exactly what the dearer variant adds. |
| **Survey booking** under the quote | Turns a quote into an appointment. A *request*, confirmed by phone; no live calendar. |
| **Service area check** (postal code) | Outside Budapest + agglomeráció: soft note to the customer, red flag in the owner e‑mail. Never blocks the quote. Edit `AGGLO_POSTAL_CODES`. |
| **Owner e‑mail**: call button, *Sürgős* flag, area flag | Built to be read on a phone between jobs. |
| Chat **survives reloads** and navigation | A half-finished quote no longer disappears. |
| **Deep link** `?ajanlat` / `#ajanlat`, `window.AquaWidget.open()`, `autoOpenDelay` | For the Google profile, ads, QR codes; the website auto-opens on /kazancsere only. |
| Post-quote actions **re-price on the server** and HTML-escape everything | The old `email_customer` action trusted data sent from the browser. |
| If the AI is down, the current question is repeated **with its buttons** | The customer is never stuck. |

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
| Leszerelendő: kondenzációs / hagyományos | +0 / +60 000, and hagyományos adds **+600 000** kéményátalakítás |
| Új kazán: kombi 24 kW / tárolós 46 l / külső 125 l | +450 000 / +900 000 / +900 000 |
| Kémény: tetőn át / tégla kéménybe / gyűjtőkémény | +380 000 / +600 000 / +600 000 |
| Fi-relé: van / nincs / nem tudom | +50 000 / +100 000 / +50 000 (nem tudom also lists the +50 000 surcharge) |
| Garancia: 3 év / 10 év (question 6, changeable on the quote) | +0 / +1 500 000 (10 év = a different appliance) |
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
existing sheet keeps working; two columns are appended):

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
- **Questions / wording:** Ferenc's, see above. The templates are in `questionText()`; the model's copy
  in `SYSTEM_PROMPT`. Adding or removing a question means updating `CHIP_MAP`,
  `CHIP_VALUES`, `SYNONYMS`, `LABELS`, `PROJECT_FIELDS`, the recap in `renderCustomerQuote`, the sheet `row`, and the
  `aqua-system` field list in the quoting-dashboard repo.
- **Colours / branding:** `public/style.css`; logo `public/logo.webp`.
- **Phone / brand name:** `PHONE` and `BRAND` in `public/widget.js`, `PHONE`
  in `api/faq-agent.js`.
- **Tests:** there is no test runner in the repo; the flow was checked with a
  script that drives the handler end to end (all answers, quote, warranty,
  booking, bad input, AI down).

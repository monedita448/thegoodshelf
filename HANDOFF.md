# Handoff notes — MiTienda by COLHQ (demo store: The Good Shelf)

This file is for whichever LLM/agent picks up work on this project next (a fresh Claude conversation, ChatGPT, OpenCode, whatever). It is **not** end-user documentation — that's `README.md`, which is customer/reseller-facing and describes what the product does. This file is developer/agent-facing and describes how to keep building it correctly, especially the parts that aren't obvious from the code alone.

Read this fully before making changes. It will save you from repeating mistakes that already happened once.

---

## 1. What this project is

**MiTienda by COLHQ** is a resellable ecommerce platform for Colombian online stores. **The Good Shelf is the demo store** this template ships with — a working example, not the product. The platform identity lives in `platform.json` (git-tracked: `platformName`, `companyName`, `displayName`, `showPlatformBrand`); each store's identity (name, branding, copy) lives in `settings.json` instead. Keep those two layers separate — never write platform values into store settings, and never let store settings drive the platform's name. The admin panel brands itself from `platform.json` (via `GET /api/platform`); the storefront brands itself from `settings.json` (via `GET /api/settings`). Three files, no framework, no build step:

- `index.html` — the public storefront (single file: HTML + CSS + vanilla JS in one `<script>` tag, ES5-ish style).
- `admin.html` — the password-protected admin panel (same single-file pattern).
- `server.js` — Node/Express backend: checkout via Wompi (PSE/Nequi/card), admin auth, product/order/trash APIs, receipt emailing.

Data lives in flat JSON files (`products.json`, `orders.json`, `customers.json`, `expenses.json`, `admin_audit.json`, `trash.json`, `notifications.json`) written directly by `server.js` — there is no database. `products.json` is the only one of these that's git-tracked (it's the actual catalog); the rest are git-ignored and auto-created at runtime (the load functions return `[]` when the file doesn't exist yet, and each has a serialized write queue). `notifications.json` (F2) follows the same pattern, capped at 500 entries.

Full product/feature documentation, setup steps, and deployment instructions are in `README.md` — read that too, it's kept accurate and up to date.

## 2. THE MOST IMPORTANT THING: how changes actually get to production

This is the part that trips up every fresh agent, so read carefully.

**The agent (you) cannot run `git push`.** This has been tested directly, not assumed:

- `git status`, `git log`, `git diff`, and even `git fetch origin` all work fine in the agent's sandbox — there's real network access to GitHub.
- `git push origin master` fails every time with `fatal: could not read Username for 'https://github.com': No such device or address`. There are no stored credentials and no way to prompt for them (no TTY). This is not fixable from inside the sandbox — don't waste time retrying it or trying to work around it with credential flags, tokens in the URL, etc.
- The sandbox also cannot delete files (`rm`, `git checkout -- <file>`, and even git's own internal lock-file cleanup all fail with "Operation not permitted"). If you need to reset a file's contents, overwrite it in place with the Write/Edit tool — don't try to delete-and-recreate it.

**What this means for your workflow:**

1. Make your code changes normally (Read/Edit/Write tools).
2. Verify them yourself before handing off — run the server locally in the sandbox (see §4, "How to test changes"), check syntax, smoke-test the actual API routes you touched.
3. Once you're confident the change is correct, give the user a copy-paste shell command block and ask them to run it in their own Terminal (or tell them to use OpenCode — see below). Something like:

   ```bash
   cd "$(find ~/Library/Application\ Support/Claude -type d -name thegoodshelf 2>/dev/null | head -1)"
   git add <files you changed>
   git commit -m "<clear, specific message>"
   git push
   ```

   The `find`-based `cd` exists because the user doesn't reliably know the exact filesystem path to the project folder on her Mac from one session to the next — this pattern locates it automatically. If the user says this returns nothing or multiple paths, ask her to `cd` into the project folder manually and confirm with `pwd` first.

4. Only stage/commit the files you actually changed. Don't blindly `git add .` — the working directory may contain test artifacts (see §4) that should never be committed.
5. After the user confirms the push succeeded (they'll usually paste the terminal output back to you), that's your signal the change is live. If they've deployed to Render (see §3), it auto-deploys on push to `master` — no separate deploy step needed.

**The user also uses a local tool called OpenCode** (a terminal-based coding CLI) which runs directly on her Mac and *can* execute real `git` commands itself, using the same Keychain-stored GitHub credentials as her Terminal. If she mentions OpenCode, she's not asking "what is OpenCode" — she already knows and uses it; just help her use it, don't explain what it is. If you're ever unsure whether a request is coming through this chat interface or being relayed from OpenCode, ask.

**Never ask the user to paste secrets (tokens, passwords) into chat.** If a GitHub PAT or similar needs to be entered somewhere, tell her to type it directly into the OS-level prompt/Terminal, not into the chat. This has happened before (she accidentally pasted a live token and her Mac password into chat) — both had to be flagged as compromised and rotated.

## 3. Deployment

- Live host: **Render**, connected to `https://github.com/monedita448/thegoodshelf.git`, branch `master`. Auto-deploys on every push to `master`.
- Render's free tier does **not** persist the filesystem across restarts/redeploys — this would silently wipe `products.json`, `orders.json`, uploaded images, everything. Confirm a persistent disk is attached before assuming data will survive a redeploy. This has been a recurring point of confusion.
- **Render has two separate places to put configuration, and it's easy to confuse them**: "Secret Files" (creates literal files on disk — wrong, don't use this) vs. "Environment Variables" (actual env vars the app reads via `process.env` — this is what you want). Every env var in `.env.example` needs to go into Render's **Environment Variables** tab, with **Save Changes** clicked afterward. A previous session burned significant time because all the env vars had been pasted into Secret Files instead, which looked like it should work but silently didn't.
- The live demo currently uses a **placeholder Wompi public key** (`pub_test_demo`), which means checkout will show a generic error page if actually tested end-to-end. This has been raised with the user twice and deferred both times ("do that later") — it is a known, intentional gap, not a bug you introduced. Real sandbox keys are free from comercios.wompi.co (see README §1) whenever she's ready to fix it.

## 4. How to test changes in the sandbox

There's no headless browser available (no network route to download Chromium, no root to apt-get it, no way around `sudo`'s "no new privileges" flag). So:

- **JS syntax**: extract the `<script>` contents from `admin.html`/`index.html` and run them through `new Function(...)` — catches syntax errors without needing a DOM.
- **Structural sanity**: grep-count opening/closing tags (`<div>`/`</div>`, `<table>`/`</table>`, etc.) to catch unbalanced markup from string-concatenated HTML edits.
- **Real backend testing**: boot `server.js` in the background with a throwaway `.env.test` (fake Wompi keys, a real `ADMIN_TOKEN`/`SESSION_SECRET`), then drive it with `curl` — log in, hit the actual API routes, inspect JSON responses. This has caught real bugs (e.g. the receipt feature, the order-trash restore logic, the 30-day expiry boundary) that static review alone wouldn't have.
- **Critical gotcha**: each `mcp__workspace__bash` call is a fresh, isolated shell — nothing persists between calls (no background processes, no `/tmp` files, no shell variables). Any test that needs a running server plus authenticated `curl` requests **must all happen inside one single bash call** (start server in background with `&`, `sleep` briefly, run every curl command, then `kill` the server — all in that one call). Splitting login and subsequent requests across separate calls will fail with lost cookies / "connection refused."
- **Critical gotcha**: files in the outputs/workspace folder cannot be deleted (`rm` fails with "Operation not permitted"). Test artifacts written to `products.json`, `orders.json`, `admin_audit.json`, `trash.json`, or a scratch `.env.test` can only be *overwritten*, not removed. In practice:
  - `orders.json`, `admin_audit.json`, `trash.json`, `.env.test` are all covered by `.gitignore` (see the `.env.*` + `!.env.example` pattern), so leftover test data in them is harmless — it'll never get committed.
  - `products.json` is **not** git-ignored (it's the real catalog). If a test creates throwaway products in it, you must clean them up afterward by overwriting the file back to its real content — check `git diff products.json` (or `git show HEAD:products.json`) before considering a task done, and restore it with Write/Edit if it's dirty. This has bitten a previous session (test products briefly ended up in the tracked file).
  - Watch for incidental formatting drift too: `server.js`'s `saveProducts()` writes with `JSON.stringify(data, null, 2)`, which expands `images` arrays onto multiple lines. The original committed `products.json` has them compact (`"images": ["url"]` on one line). If your testing causes the file to get rewritten by the server, `git diff` will show whitespace-only noise even when the actual product data is unchanged. Rewrite it back to match `git show HEAD:products.json` before finishing.

## 5. Established conventions — follow these, don't reinvent them

- **i18n pattern** (both `admin.html` and `index.html`, independently, each with its own `I18N` dictionary): static text uses `data-i18n="key"` (textContent), `data-i18n-html="key"` (innerHTML, for strings with `<br>`), `data-i18n-placeholder="key"`, or `data-i18n-aria="key"` attributes, resolved by `applyI18n()`. Dynamically-rendered JS strings use the inline `L(englishText, spanishText)` helper instead of dictionary keys. Language choice persists to `localStorage` (`tgsAdminLang` / `tgsStoreLang`) and both files have a flag-emoji toggle (🇺🇸/🇨🇴).
- **Escaping**: always wrap user-controlled or product-controlled string data in `esc()` before interpolating into `innerHTML`. Static/dictionary strings from `L()`/`t()` don't need it (they're not user input).
- **Mobile tables**: `admin.html`'s Products/Orders/Trash tables use a `.cardTable` class that CSS-transforms into stacked, labeled cards below 720px (via `data-label` attributes on `<td>`s plus `.cardPrimary`/`.cardThumb`/`.cardActions` classes) — there is no horizontal scrolling anywhere in the admin panel by design. If you add a new table, follow this same pattern rather than reaching for `overflow-x: auto`.
- **Recoverable deletes ("Recently Deleted" / trash system)**: products, product photos, and orders all soft-delete into `trash.json` (`type: 'product' | 'image' | 'order'`) rather than being hard-deleted. Each entry auto-expires **30 days** after its own `deletedAt` timestamp (checked hourly server-side, not on a fixed daily clock — see `purgeExpiredTrash()` in `server.js`). The Products bin lives at the bottom of the Products page in `admin.html`; the Orders bin lives at the bottom of the Orders page. They're independent — "Empty now" on one must never touch the other (see `purgeTrash(types)` — it takes an optional array of types to scope the purge). If you add a new deletable entity, follow this same soft-delete pattern rather than hard-deleting.
- **CSRF / admin API auth**: every `/api/admin/*` request from the frontend goes through the shared `api()` wrapper in each HTML file, which attaches an `X-Requested-With` header (checked server-side by `requireAjaxHeader`) alongside the signed session cookie. Any new admin route needs this same header sent from the frontend, or it'll be rejected.
- **Backend-requiring features are opt-in and degrade gracefully**: Wompi (checkout) and SMTP (email receipts) are the only two features that need real external accounts. Both fail with a clear, specific error message if unconfigured rather than crashing or silently no-oping (see the `SMTP_CONFIGURED` check and its warning in `server.js`). Keep this pattern for any future integration — the whole point of this template is that a reseller can hand it to a new client and 90% of it just works with zero setup.
- **Finance / expenses (E4)**: the "Finance" tab in the admin tracks expenses in `expenses.json` (fields: `id, date, category, description, amountCOP, paymentMethod, createdAt`; categories `delivery|advertising|packaging|rent|salaries|supplies|other`, payment methods `cash|bank|nequi|other`). Routes: `GET/POST /api/admin/expenses`, `PUT/DELETE /api/admin/expenses/:id`, `GET /api/admin/expenses/export` and `GET /api/admin/sales/export` (both CSV with UTF-8 BOM, export route registered before `/:id`). The dashboard adds `expensesToday/Week/MonthCOP`, `productCostsMonthCOP`, `netProfitCOP` and `profitMarginPercent`; net profit = this month's sales − product costs − expenses, and product costs are revenue − estimated profit per order, so it inherits the existing `profitEstimateComplete` estimation caveat. **Date gotcha**: expense `date` is a plain calendar `YYYY-MM-DD`, not a timestamp — never feed it through `new Date()` + local getters (it shifts a day in UTC-offset timezones). Use `dateKey()` in `server.js`, which treats a bare `YYYY-MM-DD` string literally.

## 6. Known, deliberate gaps (not bugs — don't "fix" without asking)

- Live demo checkout is broken (placeholder Wompi key) — deferred by the user, see §3.
- Single shared admin password, no multi-user/roles, no 2FA — documented in README as an intentional scope boundary, not an oversight.
- No hosted database — flat JSON files by design, documented persistent-disk caveat for hosting.

## 7. Quick orientation if you're starting cold

1. Read `README.md` top to bottom — it's accurate and describes the product from a user's perspective.
2. Skim `server.js` for the route list (`grep "app\.\(get\|post\|put\|patch\|delete\)" server.js`) to see the full API surface.
3. Check `git log --oneline -30` to see recent work and commit message style (specific, one-line, imperative).
4. If the user asks for a change, make it, test it yourself (§4), then hand off a git command block (§2) — don't stop halfway and just describe what you'd do.

## 8. Platform owner administration (Phase F1)

New in this phase: a **platform owner** dashboard, distinct from the store owner admin panel. This is the "MiTienda by COLHQ" layer — COLHQ staff managing every store on the platform. The current deployed app is still a single-store platform (The Good Shelf); F1 only added the platform management foundation, not multi-tenancy.

- **`platform-admin.html`** (`/platform-admin`) — the platform dashboard. Branded statically as "MiTienda by COLHQ"; it never reads `settings.json` or `/api/settings`, so a store's name/theme/logo can't leak into it. Spanish-first (default `es`), EN/ES toggle like the other files, but its language key is `tgsPlatformLang` (not `tgsAdminLang`). Mobile-first: the stores table uses the same `.cardTable` stacked-card pattern as `admin.html`.
- **`PLATFORM_ADMIN_TOKEN`** env var — separate from `ADMIN_TOKEN`. Platform auth is its own system: its own in-memory session map, its own signed cookie `tgs_platform_session`, its own CSRF header value `tgs-platform-admin` (checked by `requirePlatformAjaxHeader`), its own login rate limiter. `requirePlatformAdmin` only accepts platform sessions — a store-admin `tgs_admin_session` cookie is never accepted on `/api/platform/admin/*`, and platform sessions are never accepted on `/api/admin/*`. Do not "simplify" this by sharing sessions.
- **`platform_stores.json`** — git-ignored runtime file (added to `.gitignore`), same load/save + serialized write-queue pattern as the other flat files. One record per store with `id, storeName, ownerName, ownerEmail, whatsapp, businessType, plan, status, trialEndsAt, subscriptionStatus, createdAt, updatedAt, lastActivityAt`. Allowed values: `plan` = `trial|basic|pro|enterprise`, `status` = `active|trial|suspended|cancelled`, `subscriptionStatus` = `none|trial|active|past_due|cancelled`. The demo store is **not** auto-seeded into it — it stays empty until a platform owner adds stores. Don't auto-create it on boot; only writes create it.
- **Plan pricing** is provisional constants (`PLAN_PRICING_USD = { trial:0, basic:29, pro:49, enterprise:99 }`) used only to derive `estimatedMRR` (returned with `mrrProvisional: true`). There is no real billing. Don't build billing flows onto these yet.
- **Platform routes** (all behind `requirePlatformAdmin`): `POST /api/platform/admin/login|logout`, `GET /api/platform/admin/session|dashboard|stores|stores/:id`, `POST /api/platform/admin/stores`, `PUT /api/platform/admin/stores/:id`, `PATCH /api/platform/admin/stores/:id/status`. Plan changes and trial extensions go through `PUT`; only status changes use the `PATCH /status` route (so suspend/activate are always audited as their own action). Every platform action logs to `admin_audit.json` with `scope: 'platform'` and a distinct `action` name (`platform_login_success`, `platform_store_create`, `platform_store_status_change`, etc.) — grep for `scope: 'platform'` to find them.
- **Deliberately NOT implemented** (per F1 spec, don't add without being asked): real subscription/billing, "login as store", store deletion, multi-store routing/tenancy, auto-registering stores from the storefront setup wizard, and seeding the demo store into `platform_stores.json`.
- **Validation**: `validatePlatformStoreInput()` mirrors the expense/product validators (`partial` option for updates); `storeName` is the only required field on create. Reuse `PHONE_RE`/`BUSINESS_TYPES` from the existing settings validator rather than re-declaring them.

## 9. Seller operations & business reports (Phase F2)

New in this phase, all on the store-admin side (no multi-tenancy changes, platform layer untouched): dashboard improvements, the order workflow + timeline, WhatsApp step templates, notifications, quick restock, and server-generated PDF/CSV reports. Same three files as always: `server.js` (backend) and `admin.html` (UI).

- **F2B order workflow (single source of truth).** `SHIPPING_WORKFLOW = ['NOT_SHIPPED','PROCESSING','SHIPPED','DELIVERED']` lives in `server.js` (~line 134) and is mirrored in `admin.html` as `SHIPPING_WORKFLOW` + `nextShippingStatus()`. Stored enum values are **never** renamed; only the seller-facing labels change (`SHIPPING_STATUS_LABELS` in `admin.html`: NOT_SHIPPED→"New order"/"Pedido nuevo", PROCESSING→"Confirmed"/"Confirmado", SHIPPED→"Shipped"/"Enviado", DELIVERED→"Delivered"/"Entregado"). `POST /api/admin/orders/:reference/advance` moves an order exactly one step forward (400 when already DELIVERED), stores tracking/carrier when moving into SHIPPED, appends a `timeline` entry, and audits `order_status_change`. The dashboard's pending-orders card and the order detail panel both render a one-click Advance button; moving into SHIPPED prompts for optional tracking + carrier first (and the shipped WhatsApp template then includes "Tu guia es …" when present). Every order carries a `timeline` array (`{status, at, note}`) seeded at checkout (`{status:'NOT_SHIPPED', at, note:'Order created'}`) and appended on every status change via `/advance` and the existing `PATCH /shipping`. Demo orders get `demoTimeline(shippingStatus, createdAt)` — 3-hour-spaced history that ends at their current status.
- **F2D notifications.** `notifications.json` (git-ignored) holds entries `{id, type, reference, orderReference, message, createdAt, read}`; `orderReference` defaults to `reference` and lets the bell open the order. `NOTIFICATION_TYPES = ['new_order']`. `createNotification()` serializes writes through `notificationsWriteQueue` (same pattern as audit log) and caps storage at 500 entries (oldest dropped). Checkout calls it after saving a paid order. Routes (all `requireAdmin`): `GET /api/admin/notifications`, `PATCH /api/admin/notifications/:id/read`, `POST /api/admin/notifications/read-all`. Admin bell uses inline SVG (no icon-font glyphs); badge caps at "99+". Clicking a notification marks it read and auto-opens that order (via `focusOrderRef` in `admin.html`).
- **F2A dashboard payload.** `GET /api/admin/dashboard` adds `lowStockCount`, `recentOrders` (top 6 APPROVED by `createdAt`: reference/customerName/phone/shippingStatus/amountInCents/createdAt), and `unreadNotifications`. `admin.html` renders health cards, quick actions, a low-stock list with **Restock** buttons, and the pending-orders card (`renderPendingOrders`, filtered to `shippingStatus !== 'DELIVERED'`).
- **F2E restock.** `POST /api/admin/products/:id/restock` takes `{qty}` (positive integer, ≤ 100000), adds to stock, logs inventory history with `reason:'received'`, `note:'Restock +N'`, and audits `product_restock`.
- **F2F PDF/CSV reports.** All under `app.get('/api/admin/reports/:type')` with optional `?format=csv`; `:type` is one of `sales`, `expenses`, `profit`, `inventory`, `customers`. Auth-gated by `requireAdmin`. Range `from`/`to` are `YYYY-MM-DD`, defaulting to the current month; pass them through `dateKey()`/calendar semantics like expenses (see §5). CSVs use `csvValue()` (UTF-8 BOM, spreadsheet-validated). The PDF engine is **hand-rolled** (no dependencies): `newPdfDoc(settings)`, `pdfAscii()` (transliteration — don't rely on glyphs beyond ASCII/Latin-1), `pdfEsc()`, `pdfTextWidth()` (Helvetica em widths), `newPage()/ensureSpace()`, `title/subtitle/h2/valueRow/metricRow/hr/space/render`, and `assemblePdf()`. **xref gotcha**: the header `put()` consumes object index 0, so xref entries must be written for i=1..numObjs from `offsets[i]` — get this wrong and PDF viewers report a corrupt file. Metric boxes use plain text, and avoid non-ASCII glyphs (they render as `?` in Helvetica); the admin bell icon is an inline SVG for the same reason.
- **Testing UI JS without a browser.** The sandbox has no browser, but the admin UI can be exercised at runtime with a DOM stub: extract the inline `<script>` from `admin.html` (via `sed`/extraction), then run it in a Node `vm` context backed by stub `document`/`localStorage`/`fetch`/`prompt`/`Intl`. The stub's `querySelectorAll` can return generated "fake" wiring nodes so event listeners actually attach; firing them drives the real handlers (login → dashboard → advance → restock → notification click → order detail). This has already caught real typos (e.g. a `.filter` on an object when a route returned `{}`). `node --check` on the extracted JS catches syntax errors; the stub harness catches runtime/`TypeError` issues in the render + click paths.

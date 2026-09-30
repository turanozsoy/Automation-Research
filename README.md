# Automation Research — local prototype with a profile pool

```
localhost test form(s)  →  WebSocket  →  Node automation service  →  Playwright
   one workflow per tab                    profile pool (SQLite, encrypted)      one isolated Chromium context per workflow
                                                                                 →  Website B (real, online)  →  generated URL back
```

What exists now:

- **Profile pool.** Authenticated Website B sessions (Playwright storageState) stored encrypted in
  SQLite. Each workflow atomically reserves one profile; a profile is never held by two live workflows
  (enforced by the database). States: available → reserved → starting → active → cooldown → available,
  plus expired / invalid / disabled (out of rotation until you re-seed or enable).
- **Isolated workflows.** `workflowId → profileId → browser context`. Field updates and commands are
  routed by workflow id; values typed before the context exists are buffered; if a profile turns out to
  be expired during preparation the workflow is moved to another profile with its values carried over.
- **Release policy.** completed / abandoned / failed → cooldown (configurable, default 60 s);
  session lost → expired; unreadable session → invalid; three consecutive failures → invalid;
  service restart → orphaned assignments marked lost and their profiles put in cooldown.
- **Queue.** When every profile is busy or `MAX_WORKFLOWS` is reached, new workflows wait (bounded)
  and are served as profiles are released.
- **Link delivery and verification.** When the URL is captured the test page shows an **Open link**
  button. Clicking it marks the workflow's record as *visited* (stored next to the profile in SQLite).
  The automated Website B page keeps being watched, in every frame, for a success text
  (`verification.successTexts`, default "You're good to go"); when it appears the record becomes
  *verified*, the workflow closes and its profile is released. `npm run profile -- workflows` lists
  recent workflows with their link state and URL.
- Everything from the earlier phase: debounced live sync, masked authentication code, keyboard-driven
  Google address autocomplete, pausable submit steps with manual retry/skip, final-URL capture.

Not yet: headless by default, process sharding, warm pool, IP handling, deployment.

## Run it

```bash
npm install
npx playwright install chromium
# put your real URLs/selectors in config/site-b.local.json (gitignored, merged over config/site-b.json)

# seed one profile per Website B account (opens a visible Chromium; log in by hand, press Enter)
npm run profile -- seed --label acct1 --account user1@example.com
npm run profile -- list

npm start
```

Then open <http://localhost:3000> in one tab per user you want to simulate. Each tab:
**Start workflow** (a profile is reserved and Website B opens in its own context, already logged in),
type into the form, **Submit**. The status line shows the pool: available / live / cooldown / out / queued.

### Optional: driver's-license autofill (test form)

The test form has a "Scan driver's license to autofill" box. It takes a photo of the **back** of a
U.S. license (camera capture on phones, or upload; live camera on localhost/HTTPS), downsizes it in
the page, and posts it to `POST /api/scan/license`. The service decodes the PDF417 barcode in memory
(ZXing WebAssembly, no network), parses the AAMVA record, returns only first name, last name, date of
birth, address line 1, city, state and ZIP, and drops the image and the record. The page fills those
inputs, marks them as auto-filled for review, and the values reach the automation through the normal
field sync as if typed. Nothing about the image is stored or logged; the log line says only
"decoded, n/7 fields in N ms". "Clear fields" and "Scan another ID" reset the form for the next card.

Testing without a real card: `npm run scan:fixture -- license.png` writes a barcode with fictional
data, and `npm run e2e:scan -- license.png` uploads it through the real page and checks the fields.
A front-side OCR fallback (specialised ID API) is planned for cards whose barcode cannot be read.

### Adding accounts (manual login, no extension)

Open <http://localhost:3000/admin/accounts> while the service runs.

1. **Add Account** → enter an account name/number and the email → **Get Cookies**.
2. The account record is created and a separate, visible Chromium opens on Website B for that account.
   Log in there by hand (nothing is automated, nothing is pasted).
3. Back on the page, press **Done**. The service checks Website B is not on its login page, exports the
   browser context's storageState, encrypts it, saves it on that account, and closes the login browser.
   If you press Done too early the page tells you and the browser stays open.
4. **Refresh Cookies** repeats the flow, opening the browser with the account's current session, and
   replaces the saved session on Done. **Remove** deletes the account and its session.

The table shows: account, email, whether a session is saved, status (`expired` when Website B rejected
the session, otherwise the latest workflow's link state `visited` / `verified`, else `none`), created,
last session update, last workflow and its URL. Cookie values never reach the page; it only receives
metadata from `/api/accounts`. The account record already carries a slot for a per-account proxy /
egress configuration (not used yet).

The login browser is not an automation browser: its only job is manual login → capture → close.
Workflows load the saved sessions into the automation Chromium themselves.

Profile commands (`npm run profile -- <cmd>`): `seed` (manual login in a visible Chromium),
`import --file <storageState.json>`, `reseed <label>`, `list`, `verify <label>`, `disable`, `enable`,
`remove`, `events <label>`, `workflows`.

Service settings are environment variables (see `.env.example`): `MAX_WORKFLOWS`, `COOLDOWN_MS`,
`IDLE_TIMEOUT_MS`, `LEASE_MS`, `QUEUE_TIMEOUT_MS`, `MAX_REASSIGN`, `DATA_DIR`, `PROFILE_MASTER_KEY`.

### Encryption

storageState blobs are encrypted with AES-256-GCM under a random per-profile data key, which is itself
wrapped by a 32-byte master key (`PROFILE_MASTER_KEY`, base64). For development a key is generated once
into `data/master.key` (gitignored). Rotating the master key only re-wraps the small data keys.

## Configuration (`config/site-b.json`)

| Key | Meaning |
|---|---|
| `baseUrl`, `targetUrl` | Website B host and the page to open. Never hardcoded in code. |
| `loginPathPattern` | Regex on the path; a match on `baseUrl`'s host means "not authenticated". |
| `recommendedLink` | Locator clicked right after Start. |
| `fields.<name>.selector` | One selector or an ordered list; the first that matches the page wins. |
| `fields.<name>.kind` | `text` (fill, with key-press fallback for masked inputs) or `select` (`selectOption`). |
| `fields.<name>.format` | `MM/DD/YYYY` converts an ISO date before filling. |
| `fields.<name>.writeOnly` | Website B masks the value after entry (authentication code): filled, then checked for presence / `aria-invalid` only. Never read back for comparison, never logged. |
| `fields.<name>.syncMode` | `live` (default) fills as the user types. `deferred` keeps the value in the snapshot and applies it only during submit (address1). |
| `fields.<name>.inputMethod` | `fill` (default) or `type` (key presses, no delay) for widgets that need key events. |
| `fields.<name>.requiredAtStart` | `false` for fields that only exist after a later step (state appears once an address is accepted). Live updates to such fields are held and applied at submit. |
| `addressFinalize` | `fields` (sync/repair order), `inputField` (where Enter is pressed), `trigger` (the field whose first update finalises the address), `suggestionsWaitMs` (Enter is pressed only with a suggestion list open; the list is re-triggered once with Space+Backspace), `settleQuietMs` / `settleMaxMs` (wait for address values to stop changing), `repairRounds`. |
| `checkout.agreeButton` | Optional button that appears right after the submit click (e.g. `button[aria-label="Agree and continue"]`), clicked before the checkout iframe steps. |
| `submitButton` | The *last* visible, enabled match is clicked. |
| `checkout.toggle` | Element inside the iframe that must end up unchecked/off. |
| `checkout.primaryButton`, `checkout.secondaryButton` | Clicked inside the *current* frame, re-located for every step. |
| `checkout.frameUrlIncludes` | Optional substring to restrict which frames are searched. |
| `generatedUrl.prefix`, `generatedUrl.pattern` | What counts as the generated URL. |
| `generatedUrl.watchNavigationRequests` | Also watch navigation *requests* (fires before the response). No API traffic is inspected. |
| `fieldErrors` | How Website B flags an invalid field: `attribute` + `value` (default `data-accent-color="red"`) on the input or up to `ancestorLevels` ancestors, plus `aria-invalid` and required-but-empty. Right after the submit click the service watches, for up to `postSubmitWaitMs`, whether the next step appeared or the form is still there with a flagged field; a flagged field is re-filled from Website A immediately and submit is retried, up to `maxRetries` times. |
| `verification.successTexts`, `verification.pollMs`, `verification.timeoutMs` | Texts that mark the Website B page as verified after the link was delivered (any frame, shadow DOM included, apostrophes normalised); how often to look; when to give up (workflow ends as abandoned, record stays visited/none). |
| `generatedUrl.settleMs`, `generatedUrl.settleMaxMs` | After the first match, keep watching until no *new* matching URL appears for `settleMs` (capped by `settleMaxMs`), then report the URL a frame actually ended on. `settleMs: 0` = first match wins. |
| `timeouts.*` | Per-step timeouts in ms. |
| `debounceMs` | Client-side debounce per field. |

**Local override:** put your real URLs and selectors in `config/site-b.local.json` (gitignored). It is
deep-merged over `config/site-b.json`, so repo updates never conflict with your edits. Example:

```json
{ "baseUrl": "https://your-real-domain.com", "targetUrl": "https://your-real-domain.com/path" }
```

Field names on the local form (`data-field` attributes in `src/test-a/index.html`) must match the keys under `fields`.

URL detectors, first match wins: frame navigation, newly attached iframe, top-level navigation,
popup/new tab, visible anchor `href`, navigation request.

## Developing without the real Website B

`dev/fake-b/` is a throwaway local imitation of Website B with the same selectors
(login redirect, Recommended link, form, Google-style address suggestions, State revealed after an
address is accepted, Agree button, checkout iframe with a pre-checked box, primary → secondary → generated URL).

```bash
npm run fake-b                     # terminal 1: http://localhost:3001
npm run profile:fake -- import --label fake1 --account a1 --file dev/fake-b/profile.storage-state.json
npm run profile:fake -- import --label fake2 --account a2 --file dev/fake-b/profile.storage-state.json
npm run start:fake                 # terminal 2: service using config/site-b.fake.json and data/fake
E2E_PARALLEL=3 npm run e2e         # terminal 3 (optional): 3 simultaneous scripted workflows (2 profiles + 1 queued)
npm run e2e:page                   # drives the real test page in a headless browser (Start, type, Submit, Open link, verified)
npm run test:store                 # allocator unit test: no double allocation, cooldown, expiry, recovery
```

`HEADLESS=1` and `CHROMIUM_PATH=…` exist only for automated testing in containers. On your machine leave them unset so the browser is visible.

## Layout

```
config/site-b.json          Website B description (the only place selectors/URLs live)
config/site-b.fake.json     same shape, pointing at the local fake
src/shared/messages.ts      WebSocket message types (test page ⇄ service)
src/service/main.ts         boot: db, pool recovery, Chromium, registry, server
src/service/settings.ts     service settings from environment
src/service/config.ts       Website B config loader (+ local override) and login-URL check
src/service/db.ts           SQLite + migrations
src/service/crypto.ts       envelope encryption for storageState
src/service/profiles/store.ts   profiles, atomic allocation, leases, release policy, recovery
src/service/browser/manager.ts  one Chromium, one isolated context per workflow
src/service/workflows.ts    registry: allocation, queue, prepare, reassignment, idle/lease upkeep, release
src/service/workflow.ts     one workflow runtime: snapshot, coalescing queue, pausable submit steps
src/service/site-b.ts       everything that touches Website B's UI
src/service/url-capture.ts  generated-URL detectors (+ settle on the final URL)
src/service/ws.ts           static test page + WebSocket server, routing by workflow id
src/service/timeline.ts     timestamped event log (per-workflow children)
scripts/profile.ts          profile CLI
src/service/accounts/login-sessions.ts  per-account visible Chromium for manual login; Done exports + saves the session
src/service/scan/license.ts             server-side PDF417 decode + AAMVA parse, returns only the needed fields
src/test-a/scan.js                      license scan UI: camera / upload, downsize, post, fill, clear
src/test-a/admin.html, admin.js         the accounts management page (Website A side)
src/test-a/                 the local Website A stand-in (index.html + client.js)
dev/fake-b/                 local fake Website B (testing only)
dev/e2e-client.ts           scripted end-to-end run
```

## Error codes

`LOGIN_REQUIRED`, `RECOMMENDED_NOT_FOUND`, `FIELD_NOT_FOUND`, `FIELD_FILL_FAILED`, `UNKNOWN_FIELD`,
`RECONCILE_MISMATCH`, `SUBMIT_BUTTON_NOT_FOUND`, `IFRAME_NOT_FOUND`, `TOGGLE_NOT_FOUND`, `TOGGLE_STATE_FAILED`,
`PRIMARY_NOT_FOUND`, `SECONDARY_NOT_FOUND`, `URL_TIMEOUT`, `BROWSER_CLOSED`, `INVALID_STATE`, `INTERNAL`.
A fatal error moves the workflow to `failed`; use Reset (or restart the service if the browser was closed).

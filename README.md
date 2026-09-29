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

### Adding profiles with the browser extension (recommended)

`extension/` is a small Chrome extension (Manifest V3) that exports the session of the tab you are
logged in on and hands it to the service. Load it once: `chrome://extensions` → enable *Developer mode*
→ *Load unpacked* → pick the `extension` folder. Then, on a Website B tab where you are logged in:

1. Click the extension icon.
2. Enter a profile label and the account key (email/username, unique per profile).
3. **Send to service** posts the session to `http://localhost:3000/import` while `npm start` is running.
   The service stores it encrypted, opens Website B with it to verify, and the popup reports
   *session valid* or *NOT authenticated* (then the profile is marked expired).
   **Download file** saves `<label>.profile.json` instead; drop it into `data/inbox/` (created by the
   service) and it is imported the same way, then the plaintext file is deleted.

Sending the same account key again re-seeds the existing profile (fresh cookies after a re-login).
Set `IMPORT_TOKEN` on the service and the same token in the extension's options page if the service is
reachable by anyone other than you. The service URL is configurable in the options page for later
(VPS) use.

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
| `addressSearch` | Google Places style autocomplete. `order` of snapshot fields joined by `separator` (state as full `name` or `code`) is typed into `field`. Waits up to `suggestionsWaitMs` for an open list: Google classic `.pac-container .pac-item`, ARIA `role=option` (shadow DOM pierced, covers the newer Google widget), `aria-expanded`, or any newly rendered visible element containing the typed house number + street. Presses `keySequences[attempt]` (ArrowDown+Enter, then plain Enter on retry) with `keyDelayMs` between keys; with `enterWithoutList: true` (default) the keys are pressed even when no list was detected. Outcomes within `revealTimeoutMs`: **accepted** (`revealFields` visible and the input value changed), or **advanced** (Enter submitted the form: URL changed, agree button visible, or input and submit button gone), in which case the submit click is skipped and the flow continues. Otherwise the first suggestion is clicked with a real mouse click, then `retries` more attempts, then `ADDRESS_NOT_ACCEPTED` with a dump of what appeared. Fields in `order` are never filled into their own inputs. |
| `checkout.agreeButton` | Optional button that appears right after the submit click (e.g. `button[aria-label="Agree and continue"]`), clicked before the checkout iframe steps. |
| `submitButton` | The *last* visible, enabled match is clicked. |
| `checkout.toggle` | Element inside the iframe that must end up unchecked/off. |
| `checkout.primaryButton`, `checkout.secondaryButton` | Clicked inside the *current* frame, re-located for every step. |
| `checkout.frameUrlIncludes` | Optional substring to restrict which frames are searched. |
| `generatedUrl.prefix`, `generatedUrl.pattern` | What counts as the generated URL. |
| `generatedUrl.watchNavigationRequests` | Also watch navigation *requests* (fires before the response). No API traffic is inspected. |
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
src/service/profiles/import.ts  storageState normalisation + insert/reseed + verify (used by /import and the inbox)
src/service/profiles/inbox.ts   watched data/inbox folder for manually dropped session files
extension/                  Chrome extension: export the logged-in session to the service (or a file)
src/test-a/                 the local Website A stand-in (index.html + client.js)
dev/fake-b/                 local fake Website B (testing only)
dev/e2e-client.ts           scripted end-to-end run
```

## Error codes

`LOGIN_REQUIRED`, `RECOMMENDED_NOT_FOUND`, `FIELD_NOT_FOUND`, `FIELD_FILL_FAILED`, `UNKNOWN_FIELD`,
`RECONCILE_MISMATCH`, `SUBMIT_BUTTON_NOT_FOUND`, `IFRAME_NOT_FOUND`, `TOGGLE_NOT_FOUND`, `TOGGLE_STATE_FAILED`,
`PRIMARY_NOT_FOUND`, `SECONDARY_NOT_FOUND`, `URL_TIMEOUT`, `BROWSER_CLOSED`, `INVALID_STATE`, `INTERNAL`.
A fatal error moves the workflow to `failed`; use Reset (or restart the service if the browser was closed).

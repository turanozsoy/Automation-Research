# Automation Research — Phase 1 local prototype

Local proof of the core loop:

```
localhost test form (Website A stand-in)
  → WebSocket → local Node automation service
  → Playwright → VISIBLE Chromium → Website B (real, online)
  → generated URL captured → WebSocket → shown on the test form
```

Phase 1 deliberately has **one** browser, **one** page, **one** workflow, manual login,
no cookie pool, no headless mode, no deployment. See the conversation notes for the
production architecture that this grows into.

## Run it

```bash
npm install
npx playwright install chromium      # once, downloads the Chromium build Playwright expects
# edit config/site-b.json  (target URL, selectors, generated URL prefix…)
npm start
```

Then:

1. A visible Chromium opens on the configured Website B target URL.
2. If Website B shows `/login/*`, log in manually in that window and reach the target page.
   The service waits for you; it does not time out.
3. Open <http://localhost:3000> and press **Start automation** (or press Enter in the terminal).
   The service clicks the "Recommended" link, resolves the field selectors and reports **READY**.
4. Type into the local form. Each field is sent after a short debounce (`debounceMs` in the config)
   and filled into Website B. The event log shows transit / fill latency per field.
5. Press **Submit (final action)**. The service reconciles the ordinary fields against the full
   snapshot (state/city/zip included), validates the masked authentication code without reading it
   back, then runs the keyboard-driven address autocomplete (types "address1, State, city, zip",
   ArrowDown, Enter, waits for the State field to appear, retries once with plain Enter). City and
   zip are never typed into their own fields. It then clicks the last `button[type=submit]`, clicks
   "Agree and continue" when it appears, waits for the checkout iframe, makes sure the
   configured toggle is OFF, clicks primary, waits for the next state, clicks secondary, and
   captures the first URL matching the configured prefix/pattern. The URL appears on the test page.
6. **Reset** reloads the target URL and returns to the waiting state for another run.

Every step is timestamped in both the terminal and the test page's event log.

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
| `addressSearch` | Keyboard-only address autocomplete: `order` of snapshot fields joined by `separator` (state as full `name` or `code`), typed into `field`; waits up to `suggestionsWaitMs` for an aria-expanded / role=option signal, presses the keys of `keySequences[attempt]` (default ArrowDown+Enter, then plain Enter on retry) with `keyDelayMs` between keys, waits `revealTimeoutMs` for `revealFields` to appear, retries `retries` times. Fields in `order` are never filled into their own inputs; `dependentFields` (default none) are reconciled afterwards if listed. |
| `checkout.agreeButton` | Optional button that appears right after the submit click (e.g. `button[aria-label="Agree and continue"]`), clicked before the checkout iframe steps. |
| `submitButton` | The *last* visible, enabled match is clicked. |
| `checkout.toggle` | Element inside the iframe that must end up unchecked/off. |
| `checkout.primaryButton`, `checkout.secondaryButton` | Clicked inside the *current* frame, re-located for every step. |
| `checkout.frameUrlIncludes` | Optional substring to restrict which frames are searched. |
| `generatedUrl.prefix`, `generatedUrl.pattern` | What counts as the generated URL. |
| `generatedUrl.watchNavigationRequests` | Also watch navigation *requests* (fires before the response). No API traffic is inspected. |
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
(login redirect, Recommended link, form, checkout iframe with a pre-checked box, primary → secondary → generated URL).

```bash
npm run fake-b                     # terminal 1: http://localhost:3001  (FAKE_B_AUTOLOGIN=1 to auto-login)
npm run start:fake                 # terminal 2: service using config/site-b.fake.json
npm run e2e                        # terminal 3 (optional): scripted client that drives the whole loop
```

`HEADLESS=1` and `CHROMIUM_PATH=…` exist only for automated testing in containers. On your machine leave them unset so the browser is visible.

## Layout

```
config/site-b.json          Website B description (the only place selectors/URLs live)
config/site-b.fake.json     same shape, pointing at the local fake
src/shared/messages.ts      WebSocket message types (test page ⇄ service)
src/service/main.ts         boot: launch Chromium, open Website B, serve test page, wait for Start
src/service/config.ts       config loader + login-URL check
src/service/browser.ts      Chromium launch (visible by default)
src/service/site-b.ts       everything that touches Website B's UI (fields, submit, frames, toggle, buttons)
src/service/url-capture.ts  generated-URL detectors
src/service/workflow.ts     the single workflow: state, snapshot, coalescing queue, submit sequence
src/service/ws.ts           static test page + WebSocket server
src/service/timeline.ts     timestamped event log
src/test-a/                 the local Website A stand-in (index.html + client.js)
dev/fake-b/                 local fake Website B (testing only)
dev/e2e-client.ts           scripted end-to-end run
```

## Error codes

`LOGIN_REQUIRED`, `RECOMMENDED_NOT_FOUND`, `FIELD_NOT_FOUND`, `FIELD_FILL_FAILED`, `UNKNOWN_FIELD`,
`RECONCILE_MISMATCH`, `SUBMIT_BUTTON_NOT_FOUND`, `IFRAME_NOT_FOUND`, `TOGGLE_NOT_FOUND`, `TOGGLE_STATE_FAILED`,
`PRIMARY_NOT_FOUND`, `SECONDARY_NOT_FOUND`, `URL_TIMEOUT`, `BROWSER_CLOSED`, `INVALID_STATE`, `INTERNAL`.
A fatal error moves the workflow to `failed`; use Reset (or restart the service if the browser was closed).

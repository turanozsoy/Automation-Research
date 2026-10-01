# Shipzora application service (Automation Research)

The job-application system for Shipzora. Website A (the applicant site, apply.shipzora.com in the
future) collects the application; when everything Website B needs is present, the service runs the
Website B flow in the background with a pooled account and hands the generated link back.

```
applicant page  →  /ws/app (session cookie)  →  application (SQLite)  →  workflow  →  isolated Chromium context
/debug harness  →  /ws (raw workflow protocol)                            profile pool (SQLite, encrypted)  →  Website B  →  generated URL
```

Development runs against the local fake Website B (`dev/fake-b`); nothing here talks to a real
third-party service unless `config/site-b.local.json` says so.

What exists now:

- **Public application (`/`).** Shipzora Careers: landing, then Step 1–7 (about you, date of birth,
  address, verification code, three configurable question screens) and a final "Your role details"
  screen. Vanilla HTML/CSS/JS in `src/apply/`, mobile-first, saves every step, resumes by cookie, never
  shows workflow/profile/pool/automation detail. Questions and the code length live in
  `config/apply-questions.json` (`APPLY_CONFIG` to override). See [Applicant site](#applicant-site).
- **Proxy egress.** Optional per-workflow proxies managed on the operations page: exclusive sessions,
  held after use until released, encrypted credentials, health checks. See [Proxy egress](#proxy-egress).
- **Applications.** A persistent applicant record (`applications` + `application_events`), independent
  of any workflow: it survives refreshes, reconnects, automation failures and service restarts. Owned
  through an opaque session token in an HttpOnly cookie (only its hash is stored). See
  [Applications](#applications-shipzora-foundation).

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
- Everything from the earlier phase: debounced live sync, masked verification code, keyboard-driven
  Google address autocomplete, pausable submit steps with manual retry/skip, final-URL capture.

Not yet: admin authentication, headless by default,
process sharding, warm pool, IP handling, deployment. The driver's-license autofill experiment was removed.

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

Then open <http://localhost:3000/debug> in one tab per workflow you want to drive by hand. Each tab:
**Start workflow** (a profile is reserved and Website B opens in its own context, already logged in),
type into the form, **Submit**. The status line shows the pool: available / live / cooldown / out / queued.
The debug harness is an internal developer tool; applicants use the application API below.

### Applicant page content (editable copy)

The operations page has an **Applicant page content** section: every applicant-facing string (landing
hero, step headings and helper text, verification screen, question wording and option labels, preparing /
problem copy, role-ready screen) grouped by screen, with the current text, a character limit, "Reset to
default" per field and per group, and Save. Copy only: option values, routes, field names, states and the
automation are untouched (an option's stored value stays `part_time` whatever its label says).

Defaults live in `src/service/applications/content.ts`; edits are stored in the `site_content` table
(migration 7) and merged into `GET /api/apply/config` (`content`), so a change is live on the next
applicant page load with no deploy. Values are plain text: control characters are stripped, HTML is never
interpreted (the applicant page renders them with `textContent`), `{n}` = code length and `{name}` = first
name are the only placeholders. API: `GET /api/admin/content`, `PUT /api/admin/content`
`{ values: { key: text | null } }` (`null` resets).

## Operations page: `/admin/accounts`

Internal page for HR / operations staff (`src/test-a/admin.html`, `admin.css`, `admin.js`; the `/debug`
harness keeps its plain developer look). Top bar with section links and a small "Automation: Visible |
Headless" pill; **Overview** cards (accounts, sessions current, needs attention, verified applicants);
**Account & session management** (search by name or email, session filter chips, Add account in a
dialog, Refresh / Get cookies, Remove behind a confirmation); and **Verified applications**: every
application whose link state reached `verified`, newest first, with the total, search by full name or
application ID (`APP-XXXXXX` or the full id), Copy ID, Load more, and an expandable detail row
(timestamps, account used, workflow id and outcome, session last saved, job answers). It updates live:
the service nudges the page over `/ws/admin` (a data-free notification) when an application is
verified or an account changes, and the page re-fetches `GET /api/admin/applications/verified`.
"Processed with: <account>" scrolls to and highlights that account in the table. Nothing there ever
includes cookies, storageState, the verification code, date of birth or address.

Which account processed an application is stored on the application itself
(`processed_workflow_id`, `processed_profile_id`, `processed_profile_label`, set when the link is
captured), so it survives assignment cleanup and account removal.

**Session refresh after a successful run.** When a workflow ends verified (or its URL was captured and
only the verification wait ran out), the context's current storageState is exported, encrypted and
saved on the **same** account: `session_saved_at` / `last_verified_at` move forward, any
`SESSION_PERSIST_FAILED` note is cleared, and profile + application events `session_refreshed` are
recorded. If the export or save fails, the account gets `session_note = SESSION_PERSIST_FAILED` and
`needs_verify`, the Session column shows "saved · needs attention", and the application event
`session_persist_failed` is recorded; the applicant is not told (their application is unaffected).
The accounts table's Session column shows: none / saved · current / saved · needs attention /
saved · expired.

### Proxy egress

Where a workflow's traffic leaves from is an **egress**. `Direct (server IP)` is the first row and is
what every workflow used until now. Proxy rows are **exclusive sessions**: `max_concurrent` (1) live
workflows at a time, and after a workflow they are **held** until an operator presses *Release proxy*
on the operations page, after checking with the provider that the session may be reused. Lifecycle:

```
available → in_use → held → (Release proxy) → available
available / held → down            three failed health checks or network failures; needs Restore
any (not in use) → retired         Retire; needs Reinstate
```

- **Import** on `/admin/accounts` → *Add proxies*: one per line as `host:port:username:password`
  (the username may carry provider parameters), `host:port`, or `http://user:pass@host:port`.
  Feedback: `N added / N duplicates / N invalid` with the reason per invalid line. The same proxy is
  never stored twice (fingerprint of kind, host, port and credentials).
- **Credentials** are encrypted with the same envelope encryption as sessions and only ever reach
  Playwright's context options. The API, the page, logs, events and sockets carry host:port only.
- **Allocation** is one SQLite transaction with the account: an allocatable egress (available, below
  its cap; proxies before direct, least recently used first) must exist before the account is
  reserved. Both or neither. The egress is fixed for the workflow's lifetime and recorded on the
  assignment (`egress_id`); verified applications show it in their details.
- **Health**: an active probe through each proxy every `EGRESS_CHECK_INTERVAL_MS` (60 s) against
  `EGRESS_CHECK_URL` (default Website B's base URL), plus passive failures when a workflow cannot open
  Website B through its proxy (`EGRESS_FAILED`, a retryable problem for the applicant; the other
  workflows are unaffected). Three consecutive failures take the session down.
- **No pooling of used sessions.** Finishing a workflow never returns a session to the pool.
- **Direct** can be retired to force proxy-only operation (workflows then queue when no session is
  available) and reinstated later.
- **Windows note.** Chromium needs Playwright's per-context proxy placeholder on Windows
  (`CHROMIUM_PROXY_MODE=per-context`, or `auto` when a proxy exists at start); under it no context can
  go direct, so the direct egress is unavailable. Linux and macOS need nothing special.
- **Login capture** (Add account / Refresh cookies) takes one available session exclusively for the
  capture browser and launches through it; on Done, Cancel or closing the window the session becomes
  held, like after a workflow. With no available session and Direct retired, the action is refused
  with a message rather than silently using the server IP.

Testing: `npm run fake-proxy -- --port 3100 --control 3900 --auth user1:pass1` (and a second on 3101),
then `npm run e2e:egress`: import feedback, exclusive use, held/release serving the queue, health
down, a failing proxy failing only its own workflow, Restore, and no credential in any table, log or page.

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

## Applications (Shipzora foundation)

Three kinds of state stay separate:

| | Belongs to | Values |
|---|---|---|
| Profile / account | Website B account pool | available, reserved, starting, active, cooldown, expired, invalid, disabled |
| Workflow | one automation run | allocating, preparing, ready, submitting, paused, link_ready, visited, completed, failed, abandoned |
| Application | the applicant | `started`, `processing`, `link_ready`, `completed`, `problem` (+ `current_step`, `verification_step`, `link_state`) |

`applicationId` is the applicant's identity. `workflow_id` on the application is the *current* run and
is `NULL` when none is running; every run is in `application_events` (`automation_started` carries its
workflow id). One application may go through several workflows.

**When the automation starts.** Never while the applicant fills the early steps: no profile is
reserved until the address step is complete, i.e. `app.address_completed` arrives and every Website B
field except the write-only code (firstName, lastName, dateOfBirth, mobileNumber, address1, city,
state, zip, from `config.fields`) is present. Then ONE workflow starts in the background while the
applicant moves to the verification-code step: profile reserved, onboarding page prepared, the
collected fields seeded through the normal live-sync path, and the address finalised with the
existing tested logic (`Workflow.finalizeAddress()`, the same code the `/debug` harness reaches through
the first code keystroke). The view shows `automation.phase`: `preparing` → `awaiting_code` →
`submitting`. When `app.verify` arrives the code goes into the live workflow's write-only field
(masked handling) and the submit sequence runs to the generated URL. A code that arrives before the
address is finalised is held in memory and handed over as soon as it is. If no workflow is running
when the code arrives (a retry, or a client that skipped the address message) one is started first.
Once every seeded field is acknowledged after the code (or `APPLICANT_SUBMIT_FALLBACK_MS` later) the
bridge submits. A workflow that pauses (a step failed) is aborted rather than held: the profile is
released and the application becomes a `problem` the applicant can retry (the code must be entered
again). Applicant activity never extends a workflow's life; a workflow left waiting for the code is
bounded by `IDLE_TIMEOUT_MS` like any other ready workflow.

**Verification code.** Never persisted, logged, or echoed: frontend → authenticated socket →
`ApplicationService.provideVerification` → workflow snapshot → Website B. The application records only
`verification_step` = required / completed / failed. `app.update` refuses the field.

**Session.** `POST /api/applications` creates an application and sets `shipzora_session` (256-bit
random token, HttpOnly, SameSite=Lax, `Secure` with `SECURE_COOKIES=1`, lifetime `SESSION_TTL_DAYS`).
The server stores the token's SHA-256 only. `GET /api/applications/me` and the `/ws/app` upgrade
authenticate with the cookie; an applicationId alone opens nothing.

**Applicant WebSocket `/ws/app`** (types in `src/shared/messages.ts`, applicant section):

| Client → service | Service → applicant |
|---|---|
| `app.update { fields }` save Website B fields + `email` | `app.state { application }` full safe view, on connect and after every change |
| `app.answers { answers }` merge job answers (JSON) | `app.progress { event }` automation_started / automation_ready / address_finalized / verification_received / automation_submitting / generated_link_ready / visited / verified / problem |
| `app.step { step, completedStep? }` | `app.error { code, message, missingFields? }` UNAUTHENTICATED, INVALID_FIELD, INFORMATION_REQUIRED, INVALID_STATE, BAD_REQUEST |
| `app.address_completed` address step done → start/prepare the workflow, finalise the address | |
| `app.verify { code }` hand the code to the live workflow (starts one if none) | |
| `app.link_opened` final call to action clicked → visited | |

Routing is server-side: a socket is bound to one application at upgrade time and receives only that
application's view. Raw workflow messages, timeline events, pool status and account metadata go only
to `/ws` (the `/debug` harness and e2e scripts). Closing an applicant socket never ends a workflow.

**Capacity note.** After the link is captured a workflow keeps its context and profile while it watches
Website B for the success text (`verification.timeoutMs`, default 10 minutes), so an applicant who never
opens their link holds a profile for that long. The concurrency test's NO_VERIFY scenario shows this.

**Restart.** Live workflows do not survive a restart; applications that were `processing` become
`problem` (`SERVICE_RESTARTED`) on boot. Applications at `link_ready` keep their link.

**Events** (`application_events`): application_started, step_viewed, step_completed, fields_updated,
information_required, automation_started, automation_ready, address_finalized, verification_received, automation_submitting, generated_link_ready,
problem (code, stage, safe message, bounded internal detail, retry count), final_cta_clicked, visited,
verified, automation_ended, service_restarted.

## Applicant site

`src/apply/index.html` + `apply.css` + `apply.js`, served at `/` with assets under `/apply/*`; footer
links `/privacy`, `/terms`, `/contact` are honest placeholders until real pages exist.

Design: mobile is the authoritative layout (QA at 375, 390 and 430 px wide; desktop only centres the same
540 px shell), white background, black type, red primary action, warm yellow accent; tokens live at the top of `apply.css` (`--color-*`, `--radius-*`, `--control-h`, `--shell`). The
shell is the same on every step: header (back arrow + centred title on steps, brand on the landing page),
4 px red/yellow progress line, "Step n of 7" badge, heading, copy, then a bottom action area with one red
CTA. Back navigation is the header arrow (`#headerBack`, `aria-label="Back"`). The type face is Inter
from Google Fonts with a system-sans fallback; self-host it if external font requests are unwanted.
`body[data-screen]` is `landing`, `step` or `status`.

Routes (one browser path per funnel stage, for later pixel/funnel tracking; the server serves the applicant
page for all of them): `/` landing · `/step-2` about you · `/step-3` date of birth · `/step-4` address ·
`/step-5` verification code · `/step-6` experience · `/step-7` schedule · `/step-8` getting started ·
`/preparing` while the role details are being prepared (also the problem state) · `/completed` only once
the generated role-details link exists. Refreshing or opening a step URL directly resumes that step when the
saved application has reached it (otherwise the furthest reached step), never creates an application, and
shows the landing page when there is no application; browser Back/Forward move between steps; nothing
about the application is in the URL. Flow:

| Screen | Saves | Notes |
|---|---|---|
| Landing | — | one mobile screen: red/black `SHIPZORA CAREERS` header with a short red/yellow accent, full-width hero photo (`src/apply/hero.png` or `hero.jpg`, picked up automatically; dark placeholder until then) with a gradient, cash pill, headline with the brand word in yellow, trust row, red CTA with a small copyright line and the legal links beneath it → `POST /api/applications` (cookie). A returning applicant sees a Welcome back panel; the CTA resumes. |
| 1 About you | firstName, lastName, mobileNumber (digits), email | `autocomplete` given-name / family-name / tel / email |
| 2 Date of birth | dateOfBirth (ISO) | month / day / year inputs (`bday-*`); copy says it sets up the onboarding record and is not used to evaluate the application |
| 3 Address | address1, city, state, zip | "Street address" (as on the driver’s license), City, State + ZIP; separate fields, real state list; Continue → `app.address_completed` → straight to step 4 while the workflow prepares |
| 4 Verification code | nothing (code → `app.verify` only) | one numeric `one-time-code` input, length from config; shows "received" once handed over; asks again after a problem |
| 5–7 Questions | answers (saved on each selection) | card radios from `config/apply-questions.json` |
| Final | — | `processing` → "Preparing your role details…" (updates live); `link_ready` → "Your role details are ready" + **View Role Details** (new tab, `app.link_opened` → visited); `completed` → confirmed; `problem` → Try again (back to the code step) |

Resume: on load the page calls `GET /api/applications/me`; fields, answers, current step and state
come back through `app.state`. The verification code is never restored. Validation is inline, in
plain language, and sends `app.validation_failed` with field names only.

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
| `checkout.agreeButton` | Step 4: optional button that appears right after the submit click (e.g. `button[aria-label="Agree and continue"]`). After Step 3 the workflow races Step 4 against Step 7 (`secondaryButton`), searching every frame: if Step 4 is visible first the path is 4 → optional 5 → 6 → 7; if Step 7 is visible first (a previously-used account lands there directly) it is clicked at once and Steps 4, 5 and 6 are never waited for. A checkout that opens on the primary button without an Agree screen is handled as 6 → 7. The post-submit field-error watch also ends as soon as any of these controls shows up. |
| `checkout.agreeOptional`, `checkout.toggleOptional` | Default `true`: Step 4 and Step 5 may not exist. `agreeOptional: false` waits for Step 4 alone; `toggleOptional: false` requires the toggle after Step 4. After Step 4 the toggle (5) and the primary button (6) are looked for together; when 6 is there without 5 the toggle step is skipped without waiting. The toggle is only ever turned OFF. |
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
| `timeouts.proxyMultiplier` | Default `2`. When a workflow runs through a proxy egress every wait is multiplied by this: step timeouts, page load, address suggestion / settle waits, the post-submit watch and the URL settle cap. Direct runs are unchanged. Set `1` to disable. |
| `debounceMs` | Client-side debounce per field. |

**Local override:** put your real URLs and selectors in `config/site-b.local.json` (gitignored). It is
deep-merged over `config/site-b.json`, so repo updates never conflict with your edits. Example:

```json
{ "baseUrl": "https://your-real-domain.com", "targetUrl": "https://your-real-domain.com/path" }
```

Field names on the local form (`data-field` attributes in `src/test-a/index.html`) must match the keys under `fields`.

URL detectors, first match wins: frame navigation, newly attached iframe, top-level navigation,
popup/new tab, visible anchor `href`, navigation request.

## Development: automation browser mode (visible / headless)

The `/debug` page has an **Automation browser** panel: **Visible** / **Headless**, with the current mode,
`Chromium: running | restarting`, and the number of active workflows. Same automation either way;
only Playwright's launch `headless` differs. Playwright chooses headless at launch, so switching
closes the idle Chromium and launches a new one ("Restarting Chromium…" → "Headless ready"). With
workflows active the request is kept ("Will switch to headless after N active workflow(s) finish")
and applied automatically once they end; no workflow is interrupted. The choice is persisted in
`<DATA_DIR>/dev-settings.json` (gitignored) and used at the next start; without that file `HEADLESS=1`
still selects headless, otherwise visible. API: `GET/POST /api/dev/browser` (internal).

**Failure artifacts.** When a step fails (a paused step or a fatal error), the service saves, in either
mode, to `<DATA_DIR>/debug/failures/` (gitignored, `FAILURE_ARTIFACTS=0` disables):
`<timestamp>-<workflow8>-<stage>.png` (full-page screenshot of every page in that context),
`.html` (sanitized snapshot: no scripts, no input values, no `data-*` attributes) and `.json`
(stage, error code, message, browser mode, page URLs, frame count and frame URLs). Never cookies,
storageState, or the verification code.

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
npm run e2e:page                   # drives the /debug harness in a headless browser (Start, type, Submit, Open link, verified)
npm run e2e:app                    # applicant foundation: session, resume, reconnect, isolation, workflow mapping, URL, visited/verified, no secret in the DB
npm run e2e:apply                  # drives the public application at / on a phone viewport: start → steps → code → questions → refresh/resume → role details → visited → verified
CONCURRENCY=5 npm run e2e:concurrency   # N applicants at once (headless): isolation of data, contexts, URLs, sockets, codes, session write-back; queue; admin live; DB consistency; resources
npm run test:store                 # allocator unit test: no double allocation, cooldown, expiry, recovery
npm run test:app                   # application store + session helpers (throwaway DB)
npm run typecheck

# concurrency scenarios (service started with MAX_WORKFLOWS=10; K imported fake accounts):
#   CONCURRENCY=8 EXPECT_PROFILES=5   more applicants than profiles: at most 5 live, FIFO queue, everyone completes
#   CONCURRENCY=3 FAIL_ONE=1          applicant #1's checkout iframe never appears (fake: last name contains NOIFRAME) -> problem, others unaffected
#   CONCURRENCY=3 DROP_ONE=1          applicant #1 drops and resumes its socket mid-automation
#   CONCURRENCY=3 EXPIRE_ONE=1        an expired profile is inserted; the workflow that draws it is reassigned, profile leaves rotation
#   CONCURRENCY=3 SKIP_CTA=1          applicant #1 never clicks View Role Details: verified without visited
#   CONCURRENCY=3 SKIP_CTA=1 NO_VERIFY=1  with FAKE_B_GOOD_TO_GO_MS=600000 npm run fake-b: nobody verifies; workflows keep monitoring and hold their profiles
# checkout paths: a fresh account (3 → 4 → 5 → 6 → 7), a previously-used one (3 → 7; fake: last name contains RETURNING)
#   and a checkout that opens on the primary button (3 → 6 → 7; last name contains RETURNING6);
#   proves Step 7 is clicked right after it appears instead of waiting for Step 4
npm run e2e:checkout
# whole fake in returning mode (checkout opens on Step 7): FAKE_B_RETURNING=1 npm run fake-b  then  E2E_EXPECT_RETURNING=1 npm run e2e  and  npm run e2e:apply
# failure path: an applicant whose last name contains NOIFRAME never gets the checkout iframe on the fake -> pause -> aborted -> retryable problem
npm run e2e:app:problem
# restart recovery: start an applicant workflow, kill -9 the service, start it again -> the application is a SERVICE_RESTARTED problem
npm run app:start
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
src/service/workflow.ts     one workflow runtime: snapshot, coalescing queue, explicit or code-triggered address finalisation, pausable submit steps
src/service/site-b.ts       everything that touches Website B's UI
src/service/url-capture.ts  generated-URL detectors (+ settle on the final URL)
src/service/ws.ts           HTTP (static, applicant session API, accounts API) + /ws (developer) and /ws/app (applicant) with server-side routing
src/service/applications/store.ts    applications + application_events persistence, session token hash lookup
src/service/applications/service.ts  application ⇄ workflow bridge: start when complete, seed, submit, map results, problems, restart recovery
src/service/applications/session.ts  opaque session token, hashing, cookie helpers
src/service/dev/browser-mode.ts      development control: visible / headless switch, deferred while workflows run, persisted preference
src/service/egress/store.ts          proxy egress: parser, encrypted credentials, exclusive sessions, held/release, health state
src/service/egress/health.ts         active proxy probes (CONNECT / GET through the proxy)
dev/fake-proxy.ts, egress-e2e.ts     local CONNECT proxy with a control port; egress end-to-end test
src/service/timeline.ts     timestamped event log (per-workflow children)
scripts/profile.ts          profile CLI
src/service/accounts/login-sessions.ts  per-account visible Chromium for manual login; Done exports + saves the session
src/test-a/admin.html, admin.js         the accounts management page (internal)
src/test-a/debug.html, debug.js         the developer harness served at /debug (raw workflow protocol)
src/apply/index.html, apply.css, apply.js   the public Shipzora application (served at /)
config/apply-questions.json              question screens + verification-code length for the public application
dev/fake-b/                 local fake Website B (testing only)
dev/e2e-client.ts           scripted end-to-end run over /ws
dev/app-e2e.ts, app-problem-e2e.ts, app-start.ts   applicant foundation tests / helper
dev/apply-page-test.ts      public application driven like an applicant (phone viewport)
dev/concurrency-e2e.ts      N concurrent synthetic applicants with overlapping stages; isolation, queue, failure, resume, admin, DB, resources
```

## Error codes

`LOGIN_REQUIRED`, `RECOMMENDED_NOT_FOUND`, `FIELD_NOT_FOUND`, `FIELD_FILL_FAILED`, `UNKNOWN_FIELD`,
`RECONCILE_MISMATCH`, `SUBMIT_BUTTON_NOT_FOUND`, `IFRAME_NOT_FOUND`, `TOGGLE_NOT_FOUND`, `TOGGLE_STATE_FAILED`,
`PRIMARY_NOT_FOUND`, `SECONDARY_NOT_FOUND`, `URL_TIMEOUT`, `BROWSER_CLOSED`, `INVALID_STATE`, `INTERNAL`.
A fatal error moves the workflow to `failed`; use Reset (or restart the service if the browser was closed).
For an applicant workflow the failure becomes an application `problem` with a safe message; the applicant retries.

# Couples Life App

A PWA for two people (Jamall and Rebecca) covering a shared calendar, training,
and food. Static frontend on GitHub Pages, Supabase for database, auth,
realtime and Edge Functions. No build step — plain ES modules, loaded directly.

Live: <https://jamallsamuels28-lab.github.io/Couples-life-app/>
Supabase project: `zaofuncpffumxhshoujk` (couples-life)

---

## The spec is authoritative

`.kiro/kiro-algorithm-spec.md` is the source of truth for every calculation.
It exists because the calculations are the part an assistant will otherwise
quietly replace with a plausible guess. Its §0 rules apply everywhere:

1. All timestamps stored `timestamptz` in UTC; convert at the display layer.
2. **Never trust LLM-generated numbers.** Any macro figure reaching the
   database must come from a food-database lookup, never from model prose.
3. Every derived metric is recomputed on read, never stored as truth.
4. All health-metric algorithms have floors and caps. Not optional.
5. Idempotent writes — client-generated UUIDs so offline sync cannot double-insert.

If you are about to implement something the spec covers, read the spec section
first and follow it exactly. Where you must deviate, say so in a comment at the
site of the deviation and explain why.

### Known deviations from the spec, deliberate

- **§3.3 measured TDEE sign.** The spec writes `meanIntake + (ΔS × 7700 / days)`
  and then says in prose that losing weight should raise the figure. Those
  contradict. The prose is right; the formula is not. Implemented as minus ΔS.
  See `js/nutrition-engine.js`.
- **§2.2 model name.** Spec says `claude-sonnet-4-6`, which no longer exists.
  Uses `claude-sonnet-5`, overridable via the `CLAUDE_MODEL` secret.
- **§4.1 column naming.** Spec says `owner_id`; the repo already used `user_id`
  everywhere, so tables use `user_id` for consistency.

---

## Architecture

Engines are pure — no database, no DOM — so the maths can be tested directly
and a substituted formula is visible. Modules do fetching and rendering.

```
js/
  app-shell.js          auth, routing, nav. VALID_VIEWS is the single source
                        of truth for tabs — three copies of that list once
                        drifted and silently broke the Fitness tab.
  free-windows.js       §1.3–1.5 overlap engine (pure)
  schedule-patterns.js  shift/sleep data access, versioned edits
  schedule-editor.js    shift/sleep UI
  calendar-views.js     month/week/day views
  calendar-module.js    calendar CRUD, recurrence expansion (§1.2)
  google-sync.js        OAuth client + auto-sync
  fitness-engine.js     §4.2–4.5 e1RM, volume, ACWR, MET (pure)
  fitness-module.js     fitness data + view; mounts steps-module
  steps-module.js       steps; a section inside Fitness, not its own tab
  device-sync.js        iOS Shortcuts token issuing (§5.1)
  nutrition-engine.js   §2.5, §3.2–3.6 smoothing, TDEE, targets (pure)
  barcode-scanner.js    camera scanning; polyfills BarcodeDetector for Safari
  food-diary.js         diary data + view, barcode lookup
  nutrition-settings.js profile inputs feeding the target maths
  portion-split.js      §2.5 couples portion UI
  food-module.js        food view composition, recipe generator UI

supabase/
  migrations/           run in order; setup-complete.sql concatenates them
  functions/            generate-recipe, google-calendar-sync, ingest-steps
```

---

## Invariants that have already bitten

These are not style preferences. Each one caused a real bug.

**Local dates, never UTC dates.** Use `localDateKey()` from `js/ui-helpers.js`.
`toISOString().split('T')[0]` answers in UTC, which during BST is the previous
day between midnight and 01:00 — squarely inside a night shift, so meals and
steps logged at 00:30 were filed under yesterday.

**Sleep is busy time.** Availability is derived per person from shift patterns
and sleep rules. There is no shared waking-hours band; the original
`DAY_START_HOUR = 8 / DAY_END_HOUR = 23` reported ~12 hours of mutual free time
for a night-shift worker sleeping through the morning.

**Shift patterns are versioned, never updated in place.** Editing closes the
old row with `valid_to` and inserts a new one. Updating in place rewrites
history: change your rota in October and every past week claims the new hours.

**`Number(null)` is `0`.** An unrecorded reps-in-reserve read as "taken to
failure" and inflated every e1RM. Guard nulls explicitly before coercing.

**ACWR windows use exclusive lower bounds** so they hold exactly 7 and 28 days.

**Unilateral sets stay out of bilateral PRs.** A rehab block otherwise reads as
a regression across every metric.

**Macros are snapshotted onto food entries** at log time. Correcting a food
later must not rewrite history.

**Don't let a test skip its own assertions.** Four property tests ended with
`if (!result.success) return;` before asserting anything, so a signature change
left them passing while testing nothing at all.

---

## Testing

```bash
npm install
npm test              # vitest, ~874 tests
```

`tests/rls-policies.test.js` needs live Supabase keys and fails without them.
That is expected; everything else should pass.

Engines carry the heaviest coverage because that is where correctness lives.
When fixing a bug, add the test that would have caught it.

---

## Deployment

Frontend: commit and push; GitHub Pages serves `main` at root. Bump
`CACHE_NAME` in `sw.js` on every deploy or the service worker serves stale
files. Nothing is bundled, so a new `js/*.js` file must be added to
`APP_SHELL_ASSETS` in `sw.js` and imported somewhere.

Database: `supabase/setup-complete.sql` is all migrations concatenated and
re-runnable. Paste into the SQL editor. Regenerate it after adding a migration.

Edge Functions: deployed via the dashboard (Edge Functions → Deploy a new
function → Via Editor), not the CLI. Secrets live in Project Settings → Edge
Functions → Secrets: `ANTHROPIC_API_KEY`, `USDA_API_KEY`, and
`GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` once Google sync is set up.
Never `SUPABASE_SERVICE_ROLE_KEY` — Supabase injects it.

Full runbook: `docs/go-live.md`. Google setup: `docs/google-calendar-setup.md`.

---

## Design system

`.kiro/design-system.html` is the reference. Greyscale chassis, two OKLCH
identity hues, nothing else. Rules:

- Never hardcode an identity colour: `oklch(var(--id-l) var(--id-c) var(--id-x-h))`
- Radii 3 / 6 / 10px only. Shadows max `0 1px 2px`. Spacing multiples of 4.
- No gradients except the overlap ribbon fill. No emoji in the interface.
- Icons stroked, 1.5px, 20px box. Focus 2px solid, 1px offset.
- Motion 120–250ms; honour `prefers-reduced-motion`.
- Numerals use `.num` — IBM Plex Mono, tabular.

Known violation: `.input-error-msg` hardcodes `#e55`, outside the token system.

---

## Current state

Working: calendar with sleep-aware free windows, month/week/day views, shift
editor, fitness with progressive overload and ACWR, steps inside fitness, food
diary with measured TDEE, barcode lookup, portion splitting, nutrition settings.

Deployed but barely exercised: `generate-recipe`. Watch the coverage percentage
— if ingredient matching resolves poorly, the tuning points are `MIN_MATCH` and
the `normalise()` function in the Edge Function.

Not built, deliberately: Android health sync (needs a native wrapper — no web
API exists), background sync while the app is closed.

Camera barcode scanning used to be listed here as impossible on iOS Safari for
want of `BarcodeDetector`. It is built now: `js/barcode-scanner.js` polyfills
the detector in WebAssembly where the browser has none, so the scan button
appears on every phone. Two consequences worth knowing:

- The polyfill is fetched from a CDN on first scan, so the first scan of a
  session needs a connection even though the rest of the diary works offline.
  The service worker does not cache it.
- `getUserMedia` is called *before* the polyfill is awaited. Safari only grants
  camera access inside a user gesture, and awaiting an import first spends the
  gesture, after which the permission prompt never appears.

---

## Working style

Say what is actually true. If something is untested, unverified, or a guess,
name it as such rather than presenting it as done. When a spec and reality
disagree, surface the conflict instead of quietly picking one.

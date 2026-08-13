# Couples Calendar

A PWA for two people (Jamall and Rebecca): a shared calendar with sleep- and
shift-aware mutual free time. Static frontend on GitHub Pages, Supabase for database, auth,
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

## Next up, in order

1. **UK bank holidays, all three nations, filterable.** Do NOT type the dates
   from memory: Easter-derived holidays move each year, and England & Wales,
   Scotland and Northern Ireland have different sets. gov.uk publishes an
   official feed at <https://www.gov.uk/bank-holidays.json> — no key, all three
   nations, several years either side. Generate a static file from it with a
   script under `scripts/`, the same pattern the food and exercise seeds used:
   real provenance, static output, works offline. Each person picks which
   nation applies. Holidays are display-only markers — decide explicitly
   whether they count as busy time before letting them near `free-windows.js`
   (they should not; a bank holiday is not a shift).


1. **All-day events.** `events` has only `start_time` / `end_time`, so a
   birthday or a day off has to occupy a specific time slot. Needs a migration,
   changes to the views, and changes to `free-windows.js`. Do this one first
   and on its own: it is the only item here that can break availability maths,
   which is what the whole calendar exists for. An all-day event is not busy
   time in the same sense a shift is — decide that explicitly rather than
   letting the overlap engine infer it.

2. **Add-event button in day view.** There is no way to create an event for a
   particular day; every event starts from the blank form at the bottom of the
   page. Tapping a month cell already navigates to day view, so the affordance
   belongs there.

3. **Shared vs personal events, with identity colours.** The two hues exist in
   the design system and the ribbon already uses them; events do not.

## Ideas, once the backlog above is clear

Ordered by how much they serve the one thing this app is for: two people with
mismatched schedules finding time together. Anything that does not serve that
was deliberately left out — weather, task lists, shared shopping, habit
tracking. The app was just stripped down for this reason; do not refill it.

### 1. Notify when mutual free time appears

The highest-value item here, and the only one with real design decisions.

The free-window engine already computes availability better than an
off-the-shelf calendar, because it knows about shifts and sleep. But it only
speaks when someone opens the app. A push saying "You're both free Thursday
15:00–19:00" is the entire product in one notification.

Feasible: iOS 16.4+ supports web push for **installed** PWAs, which both users
have. Needs a VAPID key pair, a `push_subscriptions` table, a Supabase Edge
Function to send, and something scheduled to trigger it (pg_cron or an external
ping — Supabase has no built-in scheduler on the free tier).

Decisions to make BEFORE writing any of it, because each one is the difference
between useful and unbearable:

- **When does it fire?** A window appearing is not news if it appears every
  day. Probably: only windows over some minimum length, and only a fixed number
  of notifications per week.
- **What counts as a change worth announcing?** A rota edit can create or
  destroy dozens of windows at once. Announcing each one is spam; announcing
  none makes the feature pointless. Likely a daily digest rather than
  event-driven pushes.
- **Who gets told?** Both people, or only the one who did not make the change?
- **Quiet hours are not optional here.** One of the two works nights. A
  notification at 14:00 is the middle of the night for a day sleeper, and the
  sleep rules already in the database say exactly when that is — use them.

### 2. One-tap "book this window"

The dashboard already surfaces the top three mutual free windows as read-only
text. Making one tappable — creating a shared event spanning that slot — closes
the loop between finding time and protecting it. Small, and it makes the
existing headline feature do something.

### 3. Countdown to the next shared day off

One line at the top: "Next full day together: Sunday, in 9 days." Computable
entirely from data already fetched. For a night-shift household this is the
number that actually matters, and it costs almost nothing to add.

### 4. Protected time

A recurring block that means "do not schedule over this" — a date night, or the
evening before a run of nights. The inverse of an event: it defends free time
rather than filling it. Pairs with the repeat picker, which already exists.
Needs a decision on whether protected time is busy time to the overlap engine
(it is busy to *other* commitments, but it is not busy to each other — that
distinction is the whole point and the engine has no concept of it yet).

---

Also unchecked: whether the Fitness tab has the same shape of bug the Food tab
did, where an incomplete profile removed the whole feature rather than just the
part that needed the profile. Worth signing in as the other person and looking.

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

---

## Removed: fitness and food

Fitness, steps, the exercise library, the food diary, nutrition targets, the
recipe book and the AI recipe generator were all removed. They are moving to a
separate coaching app. This one is a calendar.

**The database tables were deliberately left in place.** `sets`, `steps_log`,
`weigh_ins`, `food_entries`, `foods`, `recipes`, `exercises` and the rest still
hold real logged history, and that history belongs to whoever migrates it — not
to a tidy-up. Their RLS policies are untouched, so nothing has changed about
who can read them. Do not write a drop migration without being asked.

Consequences worth knowing:

- `supabase/setup-complete.sql` and the migrations still create every one of
  those tables. That is correct: the file must stay able to rebuild the
  database as it actually is.
- `realtime-wiring.js` still bridges `meals`, `recipes`, `pantry_items` and
  `steps_log` events. Nothing listens for them any more. Harmless, but dead —
  worth removing next time that file is touched.
- `tests/integration-cross-module.test.js` was deleted rather than trimmed. It
  imported the removed modules, and most of it covered them. The calendar and
  free-window paths it also touched are still covered by
  `free-windows.test.js`, `property-free-windows.test.js` and
  `calendar-module.test.js`, but the cross-module integration angle is gone and
  would be worth rebuilding.
- The bottom nav was removed entirely. With one view there is nothing to switch
  between. `VALID_VIEWS` is still the single source of truth for routing, and
  any unknown hash now lands on the calendar rather than a blank screen.

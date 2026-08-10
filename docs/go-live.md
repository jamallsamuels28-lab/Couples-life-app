# Go live — step by step

Everything from the current folder to the app running on both your phones.

Work through it in order; later steps depend on earlier ones. Anything marked
**you only** is done once by you; **both of you** means Rebecca does it on her
own device or account.

Rough timings: Supabase and deploy about 40 minutes, Google OAuth about 30,
the iPhone shortcut about 10 each.

---

## Before you start

You need:

- A Supabase account (free tier is fine)
- A GitHub account
- Node 18 or newer, to run the tests
- The Supabase CLI: `npm install -g supabase`

`js/supabase-client.js` already points at your project:

```
https://zaofuncpffumxhshoujk.supabase.co   (couples-life)
```

The publishable key is in there too. Nothing to change — **skip step 1 and
start at step 2.** The project is new and empty, so all ten migrations need to
run.

---

## 1. Supabase project — you only

1. Go to <https://supabase.com/dashboard> → **New project**.
2. Name it `couples-life`, pick the London region, set a strong database
   password and save it somewhere.
3. Wait for provisioning (a couple of minutes).
4. **Settings → API**. Copy the **Project URL** and the **anon / publishable**
   key.
5. Open `js/supabase-client.js` and replace the two constants at the top with
   those values.

The anon key belongs in client code — access is governed by the row level
security policies, not by hiding it. The **service role** key is different:
that one never goes in this repo, only into Edge Function secrets.

---

## 2. Run the migrations — you only

From the project folder, linked to your Supabase project:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase db push
```

If you would rather paste SQL by hand, open the SQL editor and run these **in
this order**. Order matters — later files reference tables the earlier ones
create.

| # | File | What it adds |
|---|------|--------------|
| 1 | `20250101000000_create_profiles_events_settings.sql` | profiles, events, settings |
| 2 | `20250101000001_create_steps_meals_recipes_preferences_pantry.sql` | steps, meals, recipes, pantry |
| 3 | `20250101000002_rls_policies.sql` | row level security |
| 4 | `20250101000003_enable_realtime.sql` | realtime publication |
| 5 | `20250101000004_sleep_rules_shift_patterns.sql` | sleep, shift patterns, event overrides |
| 6 | `20250101000005_google_calendar_sync.sql` | Google connection and mapping tables |
| 7 | `20250101000006_fitness_progressive_overload.sql` | exercises, sets, sessions |
| 8 | `20250101000007_food_macro_engine.sql` | foods, entries, weigh-ins |
| 9 | `20250101000008_step_days_and_sync.sql` | step days, device tokens |
| 10 | `20250101000009_google_delete_through.sql` | delete propagation to Google |
| 11 | `20250101000010_food_cache.sql` | ingredient resolution cache |

Files 5 to 10 are the new ones. Re-running any of them is safe — every
statement is `if not exists` or `create or replace`.

**Check it worked.** In the SQL editor:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

You should see `device_tokens`, `exercises`, `food_entries`, `foods`,
`google_connections`, `nutrition_profile`, `sets`, `shift_patterns`,
`sleep_rules`, `step_days`, `training_sessions`, `weigh_ins` among the rest.

---

## 3. Create both accounts — both of you

1. **Authentication → Providers** and make sure Email is enabled.
2. **Authentication → Users → Add user** twice, once for each of you. Set
   passwords directly and tick **Auto Confirm** so there is no email round trip.
3. A profile row is created automatically by a trigger. Give them names:

```sql
update public.profiles set display_name = 'Jamall'  where id = '<your-uuid>';
update public.profiles set display_name = 'Rebecca' where id = '<her-uuid>';
```

The app expects exactly two profiles and will refuse to load with fewer.

---

## 4. Deploy the Edge Functions — you only

No CLI needed. In the dashboard: **Edge Functions** → **Deploy a new function**
→ **Via Editor**. Delete the sample code, paste the file, press Deploy.

The name must match exactly — it forms the URL the app calls, and a typo fails
silently.

| Name it exactly | Paste from |
|---|---|
| `generate-recipe` | `supabase/functions/generate-recipe/index.ts` |
| `google-calendar-sync` | `supabase/functions/google-calendar-sync/index.ts` |
| `ingest-steps` | `supabase/functions/ingest-steps/index.ts` |

### Secrets

**Project Settings → Edge Functions → Secrets**, then Add new secret:

| Secret | Needed for | Where to get it |
|---|---|---|
| `ANTHROPIC_API_KEY` | recipes | <https://console.claude.com> → API keys |
| `USDA_API_KEY` | ingredient lookup | <https://fdc.nal.usda.gov/api-key-signup> (free, instant) |
| `GOOGLE_CLIENT_ID` | calendar sync | step 6 |
| `GOOGLE_CLIENT_SECRET` | calendar sync | step 6 |
| `CLAUDE_MODEL` | optional | defaults to `claude-sonnet-5`; set `claude-haiku-4-5-20251001` to cut cost |

Never add `SUPABASE_SERVICE_ROLE_KEY` — Supabase injects it, along with
`SUPABASE_URL` and `SUPABASE_ANON_KEY`.

`USDA_API_KEY` is free and worth having. Without it, ingredient resolution
falls back to Open Food Facts alone, which is good on packaged products and
patchy on raw ingredients like "chicken thigh, skinless" — so more of each
recipe ends up unmatched and excluded from the totals.

### What this costs

Roughly 3–40p a month at two recipes a day, depending on model. Both Anthropic
and USDA have no minimum beyond Anthropic's ~$5 starting credit, which at this
usage lasts years. Every resolved ingredient is cached, so the second time you
cook with chicken thigh nothing hits the network at all.

---

## 5. Put it on the web — you only

The app is a static site, so GitHub Pages is enough. There is no git repository
in the folder yet, so start one:

```bash
cd "Personal Life Tools"
git init
printf "node_modules/\n.env\n" > .gitignore
git add .
git commit -m "Couples life app"
git branch -M main
git remote add origin https://github.com/<you>/couples-life.git
git push -u origin main
```

Then **Settings → Pages** on the repository: source **Deploy from a branch**,
branch `main`, folder `/ (root)`. It goes live at
`https://<you>.github.io/couples-life/` within a minute or two.

**The repository has to be public.** GitHub Pages only serves private repos on
Pro and above; on a free account, private means no site. That is fine here, but
know what it implies:

- Your Supabase URL and **publishable** key are visible. They are designed to
  be — row level security is what protects the data, not key secrecy.
- No API keys are in the repo. `ANTHROPIC_API_KEY`, `USDA_API_KEY` and the
  Google client secret live in Supabase Edge Function secrets, and `.gitignore`
  blocks `.env` files as a backstop.
- What actually protects your data is your two account passwords and the RLS
  policies. Use passwords you would use for a bank, not for a forum.

If a public repo bothers you, the alternatives are GitHub Pro (about £3/month)
or hosting on Cloudflare Pages or Netlify, both of which serve private repos
free. Nothing in the app depends on GitHub specifically — it is a static site.

> The service worker is disabled on `localhost` and active in production, so
> the deployed copy caches for offline use while local development always loads
> fresh files.

---

## 6. Google Calendar sync — you only, then both of you

Follow `docs/google-calendar-setup.md` in full. Summary:

1. Google Cloud project, enable the Calendar API.
2. OAuth consent screen, External, **leave it in Testing**, add both your Google
   addresses as test users.
3. OAuth client ID, Web application, with your Pages URL as both an authorised
   origin and a redirect URI. The trailing slash matters.
4. Paste the client ID into `GOOGLE_CLIENT_ID` in `js/google-sync.js`, commit,
   push.
5. `supabase secrets set GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=...`

Then each of you opens the app → **Calendar** → **Connected calendars** →
**Connect Google Calendar**.

**The 7-day thing.** In Testing mode Google expires refresh tokens after a
week, so you will each need to press Connect again roughly weekly. Publishing
to Production removes that, but triggers a security assessment aimed at
commercial apps. For two people, re-connecting weekly is the lesser annoyance.

---

## 7. Set up your schedules — both of you

This is the step that makes the app work at all. Skip it and every hour you are
not in a logged event counts as free, which is the bug the whole rewrite was
about.

Each of you, signed in as yourself:

1. **Calendar** → **Shift pattern & sleep**.
2. Fill in the pattern: name it, tap the days you work, work start and end.
   An end time earlier than the start means an overnight shift — the form says
   so when it spots one.
3. Fill in sleep start and end for that pattern. Yours is roughly 09:30 to
   17:30 after a night; Rebecca's follows her earlies.
4. Set **In force from** to today and save.
5. Under **Sleep**, fill the three contexts for days the pattern does not cover.

**When your rota changes**, edit and save again with the new effective date.
The old pattern is closed rather than overwritten, so past weeks keep the hours
you actually worked.

**Check it worked.** The Calendar dashboard should show a realistic **Next free
together** — for a night-shift week that is an evening window of a few hours,
not eleven or twelve. If it says twelve hours, a pattern or a sleep rule is
missing.

---

## 8. Phone step sync — both of you

iPhone only. Android needs a native wrapper, which is not built.

1. **Steps** → **Sync from your phone** → **Connect a phone**.
2. Copy the token immediately. It is stored as a one-way digest and cannot be
   shown again — if you lose it, revoke and issue a new one.
3. Follow the on-screen instructions to build the Shortcuts automation: daily at
   23:50, Find Health Samples for today's steps, POST to the ingest URL.
4. Turn **Notify When Run** off, or it pings you nightly.

Run the shortcut manually once. The **Last posted** date in the panel should
update.

---

## 9. Nutrition setup — both of you

Targets refuse to compute until they have real inputs, because a guessed
calorie target is worse than none. No SQL needed.

1. **Food** → **Your targets**. Fill in sex, height, date of birth, current
   weight, goal weight and rate. The preview underneath updates as you type and
   tells you when a cap or floor has bitten — so if you ask for 1.5 kg a week
   and get given less, it says why.
2. **Save**. This also stores your body weight for the training-calorie maths.
3. **Weigh in** and log today's weight, so the smoothed line has a starting
   point.

Expenditure starts as a prediction and switches to measured after about a
fortnight of logging. Below ten logged days it says so rather than showing a
number it cannot support.

---

## 10. Install on your phones — both of you

Open the Pages URL in **Safari** (iOS) or **Chrome** (Android) → Share →
**Add to Home Screen**. It runs full screen and works offline for anything
already cached.

---

## Verification checklist

Work down it. Each line is something that has actually broken before.

- [ ] `npm install && npm test` passes locally
- [ ] Both profiles exist with the right display names
- [ ] Signing in as each of you shows the other as partner
- [ ] Calendar loads without "Partner account is not linked"
- [ ] Both shift patterns saved, both showing in the month view as coloured bands
- [ ] Sleep hatching visible in week and day views
- [ ] **Next free together** shows a plausible window, not eleven hours
- [ ] Creating an event on one account appears on the other without a refresh
- [ ] Google connected on both accounts, **Sync now** reports in/out counts
- [ ] An event created here appears in Google within one sync
- [ ] Deleting it here removes it from Google on the next sync
- [ ] Leaving the app open shows a "last synced" time that updates on its own
- [ ] Fitness tab lists exercises; logging a set updates volume and e1RM
- [ ] Starting and finishing a session gives a calorie figure, not "untimed"
- [ ] Food search returns results; a barcode lookup resolves or says why not
- [ ] **Your targets** produces a calorie and macro preview for both of you
- [ ] A suggested recipe shows two different plate weights under "Your plates"
- [ ] Weigh-in saves and the smoothed figure appears
- [ ] Shortcut posts steps and **Last posted** updates
- [ ] Installed to the home screen on both phones

---

## When something breaks

**"Partner account is not linked."** Fewer than two rows in `profiles`. Check
both users exist in Authentication and that the trigger created their profiles.

**Calendar shows twelve hours free.** No shift pattern or sleep rule for one of
you. Step 7.

**`redirect_uri_mismatch`.** The URI in the Google credential does not match
the app URL exactly, trailing slash included.

**"Google did not return a refresh token."** You have consented before. Remove
the app at <https://myaccount.google.com/permissions> and connect again.

**Sync stops working after about a week.** Expected in Testing mode. Press
Connect again.

**Shortcut posts nothing.** Check the token was pasted whole, the date is
formatted `yyyy-MM-dd`, and the URL ends `/functions/v1/ingest-steps`. Then:

```bash
supabase functions logs ingest-steps
```

**Old version stuck after a deploy.** The service worker cached it. Bump
`CACHE_NAME` in `sw.js` (currently `couples-life-v6`), push, and reload twice.

**Everything looks unstyled.** A CSS file 404ed — check the paths in
`index.html` match the deployed folder structure, which they will not if you
put the app in a subfolder without adjusting them.

---

## What is deliberately not built

**Android health step sync.** This one is a hard limit, not a shortcut. There
is no web API that reads Google Fit or Health Connect — reaching them needs a
native app wrapper (Capacitor or a TWA), a Play Store listing and the Health
Connect permissions review. Anyone who tells you a PWA can do it is describing
a native app. Rebecca's iPhone is covered by step 8; an Android user enters
steps by hand, which is one tap on the Steps tab.

**Sync while the app is closed.** Sync runs by itself whenever the app is open,
throttled to five minutes and paused when the tab is hidden. Genuinely
background sync needs a scheduled function plus a Google watch channel with a
renewing webhook — a lot of moving parts for two people, to save a few seconds
on opening the app. Worth revisiting only if you find yourself waiting on it.

**Barcode scanning by camera on iPhone.** Safari does not ship
`BarcodeDetector`, so the Scan button only appears on browsers that have it.
Typing the digits works everywhere and is the main path on iOS, not a fallback.

# Algorithm & Logic Spec — Couples Life App

**Purpose:** the decision logic, formulas and validation rules that Kiro is bad at inventing. Kiro handles UI, CRUD, routing, auth wiring. This document handles *how things are calculated*.

**Stack:** GitHub Pages frontend (PWA) + Supabase (Postgres, Auth, Realtime, Edge Functions) + Claude API for recipe generation.

**Modules:** 1) Couples calendar · 2) AI recipe maker · 3) Food log & macro engine · 4) Fitness / progressive overload · 5) Steps & energy expenditure.

**How to use this with Kiro:** feed it ONE module at a time. Give it the schema block, then the algorithm block, then say "implement exactly this logic, do not substitute your own formulas." Kiro will otherwise quietly replace a calibrated formula with a guess.

---

## 0. Cross-cutting rules (give Kiro these first)

1. **All timestamps stored `timestamptz` in UTC.** Convert at the display layer only. Europe/London has BST — a shift stored as naive local time will silently shift by an hour twice a year.
2. **Never trust LLM-generated numbers.** Any macro figure that reaches the database must be computed from a food-database lookup, not from prose the model wrote.
3. **Every derived metric is recomputed, never stored as truth.** Store raw logs (weigh-ins, food entries, sets). Derive TDEE, trends, 1RMs on read. Cache if slow; never let a derived value become un-recomputable.
4. **All health-metric algorithms have floors and caps.** Specified per algorithm below. These are not optional — an unbounded deficit algorithm will happily recommend something harmful after a couple of bad data days.
5. **Idempotent writes.** Every log row gets a client-generated UUID so offline PWA sync can't double-insert.

---

## 1. COUPLES CALENDAR

### 1.1 Schema addition — sleep as first-class data

The naive version of "when are we both free" fails for you specifically, because after a night shift you're asleep 09:00–17:30 and that time is *not* free. Sleep must be modelled or the whole feature outputs garbage.

```sql
alter table public.events
  add column exdates timestamptz[] default '{}',      -- cancelled instances of an rrule
  add column override_of uuid references public.events(id), -- this row replaces one instance
  add column busy_weight smallint not null default 100; -- 100 = hard busy, 50 = soft, 0 = free

create table public.sleep_rules (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  -- applies to days where the person has a shift matching this tag
  context     text not null,          -- 'post_night_shift' | 'default' | 'pre_night_shift'
  start_local time not null,
  end_local   time not null,
  crosses_midnight boolean not null default false
);
```

### 1.1b Shift patterns must be user-editable and versioned

Do **not** seed shifts as fixed rows via SQL. Rotas change — Amazon reshuffles, ISO patterns rotate — and a hardcoded pattern means every change needs a developer. It also silently corrupts history: edit your shift in October and every past week retroactively claims you worked the new hours.

Fix: patterns are rows with a validity window, edited in the app, never overwritten.

```sql
create table public.shift_patterns (
  id           uuid primary key default gen_random_uuid(),
  owner_id     uuid not null references public.profiles(id) on delete cascade,
  label        text not null,              -- 'Nights Sun-Wed', 'ISO earlies'
  days_of_week smallint[] not null,        -- 0=Sun .. 6=Sat
  start_local  time not null,
  end_local    time not null,              -- < start_local means it crosses midnight
  sleep_start  time,
  sleep_end    time,
  valid_from   date not null,
  valid_to     date,                       -- null = current pattern
  created_at   timestamptz default now()
);
create index shift_patterns_owner_idx on public.shift_patterns(owner_id, valid_from);
```

**Editing rule (implement exactly):** changing a pattern never updates the row in place. Set `valid_to = <day before the change>` on the existing row, then insert a new row with `valid_from = <change date>`. Past weeks keep resolving against the old pattern; future weeks use the new one.

**Resolution:** to expand a day D for a person, select the pattern where `valid_from <= D and (valid_to is null or valid_to >= D)` and `extract(dow from D) = any(days_of_week)`. Exactly one row should match; if more than one does, the edit logic is broken — surface an error rather than picking arbitrarily.

**Overnight handling:** `end_local < start_local` means the shift runs into the next day. When expanding, emit it as a single interval with the correct duration; when rendering it onto a single-day ribbon, split at midnight into two visual blocks. Same for sleep windows.

**One-off deviations** (overtime, swapped shift, a day off) go in `events` as normal rows and take precedence over the pattern for that date. The pattern is the default; events are the truth.

### 1.2 Recurrence expansion (exact order of operations)

Kiro will get this wrong if you don't spell out the sequence:

```
expandEvents(rows, rangeStart, rangeEnd):
  instances = []
  for row in rows where row.override_of is null:
      if row.rrule is null:
          if overlaps(row, rangeStart, rangeEnd): instances.push(row)
      else:
          duration = row.end_time - row.start_time          # fixed duration, computed ONCE
          starts   = RRule(row.rrule, dtstart=row.start_time).between(rangeStart, rangeEnd)
          for s in starts:
              if s in row.exdates: continue                 # step 1: drop cancellations
              instances.push({...row, start: s, end: s + duration})
  # step 2: apply overrides AFTER expansion
  for row in rows where row.override_of is not null:
      remove from instances the instance of row.override_of at the same original start
      instances.push(row)
  return instances
```

Critical detail: `duration` is computed from the seed row, then added to each generated start. Do **not** re-derive end times from the RRULE. A 22:30→09:00 night shift is one instance with a 10.5h duration crossing midnight; treating it as two events breaks the overlap maths.

Library: `rrule` (npm). Expand client-side — Postgres has no native recurrence and doing it in SQL means expanding twice.

### 1.3 Busy-interval union (sweep line)

```js
// intervals: [{start:ms, end:ms, weight:0-100}]
function mergeBusy(intervals, threshold = 50) {
  const hard = intervals.filter(i => i.weight >= threshold)
                        .sort((a,b) => a.start - b.start);
  const out = [];
  for (const iv of hard) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}
```

O(n log n). Handles back-to-back and fully-nested events correctly, which naive pairwise comparison does not.

### 1.4 Both-free windows (the feature that justifies the app)

```
bothFreeWindows(personA_events, personB_events, sleepRules, range, opts):
  opts = { minMinutes: 45, qualityMinMinutes: 120 }

  1. expand both people's events over range
  2. materialise sleep blocks:
       for each day in range, for each person:
         context = 'post_night_shift' if person has a shift ending that morning
                   else 'pre_night_shift' if a shift starts that evening
                   else 'default'
         emit sleep interval from matching sleep_rule, weight = 100
  3. busy = mergeBusy(A.instances ++ B.instances ++ sleepBlocks)
  4. free = complement(busy) over range      # gaps between merged busy blocks
  5. drop gaps shorter than opts.minMinutes
  6. score each gap (§1.5) and sort descending
  return scored gaps
```

`complement` is trivial once merged: walk the merged list, the gap between `merged[i].end` and `merged[i+1].start` is free, plus the head and tail of the range.

**Why this beats the earlier draft:** no fixed `dayStartHour`. Waking hours are *derived* from each person's actual shift context rather than assumed to be 08:00–23:00 — which is wrong for you on four days out of seven.

### 1.5 Window quality score

Not all free time is equal. 45 minutes at 04:00 is not a date night.

```
score(window):
  base      = min(durationMinutes / 180, 1) * 40          # up to 40 pts, saturates at 3h
  timeOfDay = 30 if 17:00–22:00
              20 if 11:00–17:00
              10 if 08:00–11:00
              0  otherwise
  weekend   = 15 if Sat/Sun else 0
  buffer    = 15 if ≥60 min gap from nearest hard-busy block on BOTH sides
              else 5 if ≥30 min
              else 0                                       # avoids "free" slots sandwiched
                                                           # between shift and sleep
  proximity = -10 if window starts within 90 min of either person's shift end
                                                           # nobody wants to socialise post-shift
  return base + timeOfDay + weekend + buffer + proximity
```

Surface the top 3 windows per week as "you're both free here." That single output is the product.

### 1.6 Conflict detection

On insert/update of any event, check the owner's own instances for overlap where both `busy_weight >= 50`. Warn, don't block — double-booking is sometimes intentional. Query the ±1 day window only; don't scan the table.

---

## 2. AI RECIPE MAKER

### 2.1 Architecture (the important bit)

```
User taps "what can I cook?"
   ↓
App computes remaining macros for each person (§3.4) + reads pantry
   ↓
Claude API → returns INGREDIENTS + METHOD as strict JSON. No macro numbers used.
   ↓
For each ingredient: resolve against food DB (Open Food Facts / USDA FDC)
   ↓
Compute recipe macros by SUMMING resolved ingredients
   ↓
Score fit (§2.4), scale portions per person (§2.5)
   ↓
Show recipe with COMPUTED macros. Unresolved ingredients flagged, not guessed.
```

The model proposes; the database disposes. If ≥2 ingredients fail to resolve, mark the recipe "macros approximate" in the UI rather than showing a confident wrong number.

### 2.2 Claude API call

Model: `claude-sonnet-4-6`. System prompt must force bare JSON:

```
You generate recipes. Respond with ONLY a JSON object, no preamble, no markdown fences.
Schema:
{
  "title": string,
  "servings": number,
  "prep_minutes": number,
  "cook_minutes": number,
  "ingredients": [
    { "item": string,        // plain searchable food name, e.g. "chicken thigh, skinless"
      "grams": number,       // ALWAYS grams. Convert cups/tbsp yourself.
      "note": string|null }  // e.g. "diced"
  ],
  "method": [string],        // numbered steps, one per array element
  "tags": [string]
}
Rules:
- Do NOT include calorie or macronutrient values. They are computed downstream.
- "item" must be a generic ingredient name suitable for a nutrition database lookup,
  not a brand name and not a compound phrase.
- All quantities in grams, including liquids (use grams, assume 1ml=1g for water-based).
```

User message assembles: remaining macros (as a *hint*, "aim for roughly X kcal / Yg protein"), pantry list, constraints (time available, equipment, dislikes), and cuisine preference.

Parse defensively — strip ``` fences, `JSON.parse` in try/catch, validate against the schema before use, retry once on failure with the error appended.

### 2.3 Ingredient resolution

- **Primary: Open Food Facts** — free, no API key, good barcode coverage, patchy raw-ingredient coverage.
- **Primary for raw ingredients: USDA FoodData Central** — free API key, excellent for "chicken thigh raw", authoritative per-100g values. Use the *Foundation* and *SR Legacy* datasets; skip *Branded* for generic ingredients.
- Cache every resolution in a local `food_cache` table keyed by normalised name. Second lookup of "chicken thigh" must never hit the network.

Matching: normalise (lowercase, strip punctuation, singularise), then exact match → cached alias → search API top result with a token-overlap check. If token overlap < 0.5, mark unresolved rather than accepting a bad match. A wrong match is worse than a missing one.

```
macros_for_ingredient = per_100g_values × (grams / 100)
recipe_totals = Σ ingredients
per_serving  = recipe_totals / servings
```

### 2.4 Macro-fit score

```
fitScore(recipe_per_serving, remaining):
  weights = { kcal: 0.40, protein: 0.35, carbs: 0.125, fat: 0.125 }
  score = 100
  for each macro m:
      err = (recipe[m] - remaining[m]) / max(remaining[m], 1)
      penalty = (err > 0)
                ? err * 1.5      # overshoot penalised harder than undershoot
                : abs(err) * 1.0
      score -= weights[m] * min(penalty, 1.0) * 100
  return clamp(score, 0, 100)
```

Protein undershoot is weighted less harshly than calorie overshoot deliberately — hitting protein matters, but blowing the calorie budget is the failure mode that actually derails a deficit.

### 2.5 Couples portion scaling (cook once, eat differently)

You and Rebecca will rarely have the same remaining macros. Don't generate two recipes — generate one and split it unevenly.

```
portionsFor(recipe_per_serving, remainingA, remainingB):
  # how many "recipe servings" each person should eat, driven by calories
  pA = remainingA.kcal / recipe_per_serving.kcal
  pB = remainingB.kcal / recipe_per_serving.kcal

  # clamp to realistic plate sizes
  pA = clamp(pA, 0.5, 2.5); pB = clamp(pB, 0.5, 2.5)

  # round to nearest 0.25 serving for practicality
  pA = round(pA * 4) / 4;   pB = round(pB * 4) / 4

  batch = ceil(pA + pB)                    # how many servings to actually cook
  leftovers = batch - (pA + pB)
  return { pA, pB, batch, leftovers, 
           macrosA: recipe_per_serving × pA,
           macrosB: recipe_per_serving × pB }
```

Display as grams on the plate, not "1.25 servings" — compute `total_cooked_weight × (pA / batch)` so the scale does the work.

---

## 3. FOOD LOG & MACRO ENGINE

### 3.1 Schema

```sql
create table public.foods (            -- cached food database entries
  id            uuid primary key default gen_random_uuid(),
  source        text not null,          -- 'off' | 'usda' | 'custom'
  source_id     text,
  name          text not null,
  brand         text,
  barcode       text,
  per_100g      jsonb not null,         -- {kcal, protein, carbs, fat, fibre, sugar, salt}
  serving_grams numeric,                -- default portion if known
  verified      boolean default false,
  created_at    timestamptz default now()
);
create index foods_barcode_idx on public.foods(barcode);
create index foods_name_trgm on public.foods using gin (name gin_trgm_ops);

create table public.food_entries (
  id         uuid primary key,          -- client-generated for offline idempotency
  owner_id   uuid not null references public.profiles(id) on delete cascade,
  food_id    uuid references public.foods(id),
  logged_at  timestamptz not null,
  meal       text not null,             -- breakfast|lunch|dinner|snack
  grams      numeric not null,
  macros     jsonb not null,            -- snapshot at log time (foods rows can change)
  recipe_id  uuid,
  created_at timestamptz default now()
);

create table public.weigh_ins (
  id        uuid primary key,
  owner_id  uuid not null references public.profiles(id) on delete cascade,
  date      date not null,
  weight_kg numeric not null,
  unique (owner_id, date)
);
```

Note `macros` is snapshotted onto the entry. If a food's data is later corrected, history must not silently rewrite itself.

### 3.2 Weight smoothing (do this before anything else touches weight)

Raw daily weight is mostly water. Every downstream calculation uses the smoothed value.

```
EMA: s[0] = w[0]
     s[i] = α·w[i] + (1-α)·s[i-1],  α = 0.25   (≈7-day responsiveness)
```

Missing days: carry `s` forward, don't interpolate the raw value. Outlier guard: if `|w[i] - s[i-1]| > 2.5 kg`, still include it but flag the entry — a 3kg overnight jump is a mis-log or a different scale, and the user should be asked.

### 3.3 TDEE — measured, not predicted

Predicted TDEE (BMR × activity multiplier) is a *starting guess only*. After 14 days of data, switch to measured.

**Cold start (< 14 days of logs):**
```
Mifflin-St Jeor BMR (male)   = 10·kg + 6.25·cm − 5·age + 5
Mifflin-St Jeor BMR (female) = 10·kg + 6.25·cm − 5·age − 161

TDEE_predicted = BMR × 1.15            # sedentary baseline incl. thermic effect of food
               + stepCalories (§5.2)   # NEAT from actual step count, not a guessed multiplier
               + trainingCalories      # from logged sessions, §4.5
```

Using measured steps instead of a lifestyle multiplier removes the single largest source of error in the classic formula.

**Measured (≥14 days, preferred):**
```
window = last 28 days (min 14, require ≥70% of days with a food log)
ΔS     = smoothedWeight[today] − smoothedWeight[windowStart]      # kg
TDEE_measured = meanDailyIntake_over_window + (ΔS × 7700 / windowDays)
```

7700 kcal ≈ 1 kg of body mass change. Sign convention: losing weight (ΔS negative) means true TDEE was *higher* than intake — the `+` with a negative ΔS handles it.

Blend during transition: `TDEE = λ·measured + (1−λ)·predicted`, `λ = min(loggedDays/28, 1)`.

**Data quality gate:** if fewer than 10 days in the window have a food log, do not display a measured TDEE at all. Show "keep logging — X more days for an accurate figure." A confidently-wrong TDEE from sparse data is worse than none.

### 3.4 Targets, with hard safety bounds

```
setTargets(TDEE, weight_kg, goalRate_kg_per_week, sex, bmr):
  # 1. requested deficit
  deficit = goalRate × 7700 / 7

  # 2. CAPS — apply in this order, most restrictive wins
  deficit = min(deficit, TDEE × 0.25)               # never exceed 25% of TDEE
  deficit = min(deficit, weight_kg × 0.01 × 7700/7) # never exceed 1% bodyweight/week
  target  = TDEE − deficit

  # 3. FLOORS
  target = max(target, bmr)                         # never below BMR
  target = max(target, sex == 'male' ? 1500 : 1200) # absolute floor
  
  # 4. protein — anchored to TARGET weight, not current, for higher body weights
  refWeight = min(weight_kg, goalWeight_kg × 1.1)
  protein_g = refWeight × 2.0                       # g/kg, 1.6–2.2 range
  
  # 5. fat — essential-intake floor
  fat_g = max(refWeight × 0.8, target × 0.20 / 9)
  
  # 6. carbs — remainder
  carbs_g = (target − protein_g×4 − fat_g×9) / 4
  if carbs_g < 50: reduce fat_g toward its floor until carbs_g ≥ 50
```

Anchoring protein to a reference weight rather than current weight matters at higher body weights — 2.0 g/kg of 116 kg is 232 g, which is neither necessary nor achievable. Against a ~105 kg reference it's a sane 210 g.

**Plateau rule:** if smoothed weight change over 21 days is < 0.3% of bodyweight AND logging compliance > 80%, recompute TDEE from measured data and re-derive targets. Do not simply subtract 200 kcal — that's how people ratchet down to an unsustainable intake. Recalculating from measured expenditure is self-correcting.

### 3.5 Remaining macros & end-of-day projection

```
remaining = target − Σ(entries logged today)

projectedTotal = consumedSoFar + expectedRemainderOfDay
  where expectedRemainderOfDay = mean intake in this time-of-day bucket over last 14 days
```

The projection is what makes the recipe suggester useful at 15:00 rather than only at 21:00.

### 3.6 Search ranking (foods)

```
rank = 0.45 × trigramSimilarity(query, name)
     + 0.30 × personalFrequency          # log(1 + times user logged it) / log(1+max)
     + 0.15 × recency                    # exp(−daysSinceLastLogged / 30)
     + 0.10 × verified ? 1 : 0
```

Barcode scan bypasses ranking entirely — exact match or create-new.

---

## 4. FITNESS / PROGRESSIVE OVERLOAD

### 4.1 Schema

```sql
create table public.exercises (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  pattern     text,     -- squat|hinge|push_h|push_v|pull_h|pull_v|carry|isolation
  unilateral  boolean default false,
  restricted_for uuid[] default '{}'   -- profile ids currently unable to perform it
);

create table public.sets (
  id          uuid primary key,
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  exercise_id uuid not null references public.exercises(id),
  session_id  uuid not null,
  performed_at timestamptz not null,
  weight_kg   numeric not null,
  reps        smallint not null,
  rir         smallint,          -- reps in reserve, 0-5, nullable
  side        text,              -- 'both'|'left'|'right' for unilateral work
  is_warmup   boolean default false
);
```

`restricted_for` + `side` exist because a one-sided restriction (injury, post-op rehab) otherwise corrupts every volume and progression metric. Sets flagged `side` are tracked per-limb and excluded from bilateral PR comparisons.

### 4.2 Estimated 1RM

```
Epley:   e1RM = w × (1 + reps/30)
Brzycki: e1RM = w × 36 / (37 − reps)

use: reps ≤ 10 → average of both
     reps > 10 → Epley only (Brzycki degrades badly above 10 and breaks at 37)
     reps = 1  → e1RM = w
RIR adjustment: if rir provided, effectiveReps = reps + rir, compute on that,
                then report as "estimated at failure"
```

Never display e1RM from sets above 12 reps — the error exceeds the signal.

### 4.3 Volume load & progression

```
volumeLoad(set)     = weight × reps           (working sets only, exclude warmups)
sessionVolume       = Σ volumeLoad
weeklyVolumePerPattern = Σ by exercise.pattern
```

**Double progression** — the rule Kiro should implement:
```
given target rep range [lo, hi] and a set count:
  if ALL working sets hit `hi` reps at current weight with rir ≤ 1:
      increase weight by:
        upper body isolation → 2.5%  (or smallest available increment)
        upper body compound  → 2.5%
        lower body compound  → 5%
      reset target reps to `lo`
  else:
      keep weight, add 1 rep to the weakest set
```

### 4.4 Deload / overreaching trigger (ACWR)

```
acute   = mean daily volumeLoad over last 7 days
chronic = mean daily volumeLoad over last 28 days
ACWR    = acute / chronic

ACWR > 1.5           → flag "spiking load, injury risk elevated"
ACWR < 0.8 for 14d   → flag "detraining"
0.8 ≤ ACWR ≤ 1.3     → optimal band
```

Also trigger a deload suggestion if e1RM on a lift has failed to improve across 3 consecutive sessions AND ACWR > 1.2. Stalling under high load is fatigue; stalling under low load is a programming problem, and they need different responses.

### 4.5 Training energy expenditure (feeds TDEE)

Use METs — more honest than any per-exercise calorie table:

```
kcal = MET × weight_kg × hours
  resistance training, moderate  MET ≈ 3.5
  resistance training, vigorous  MET ≈ 6.0
  walking pad, 4–5 km/h          MET ≈ 3.3
  walking pad, 5.5–6.5 km/h      MET ≈ 4.3
```

Subtract BMR-equivalent for the duration to avoid double-counting: `net = (MET − 1) × weight × hours`. This matters — gross MET calories double-count resting metabolism that's already in TDEE.

---

## 5. STEPS

### 5.1 The honest constraint

A PWA **cannot read Apple Health or Google Fit directly.** There is no web API for it. Anyone telling you otherwise is describing a native app. Your three real options:

1. **iOS Shortcuts automation (best for Rebecca).** A daily personal automation at 23:50: *Get step count → Get contents of URL → POST JSON to a Supabase Edge Function*. Zero app-store involvement, fully automatic. Write the Edge Function to accept `{ owner_id, date, steps, secret }`.
2. **Android Health Connect** — needs a native wrapper (Capacitor/TWA). Phase 3, not now.
3. **Manual entry** — fallback, keep it as a one-tap field.

Build option 1. It's an afternoon's work and it removes the main reason step trackers get abandoned.

```sql
create table public.step_days (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  date     date not null,
  steps    integer not null,
  source   text default 'manual',
  primary key (owner_id, date)
);
```

### 5.2 Step → calorie conversion

```
netKcalPerStep ≈ 0.000385 × weight_kg        # derived from ~0.5 kcal/kg/km, ~1300 steps/km
stepCalories   = steps × netKcalPerStep
```

For 116 kg that's ~0.045 kcal/step → 13,500 steps ≈ 600 kcal. Sanity-check against that figure; if your implementation produces 1,200, the code is using gross rather than net.

Subtract a baseline so incidental movement isn't double-counted with BMR: only count steps above ~2,000/day when feeding TDEE.

### 5.3 Streaks & trend

```
streak = consecutive days meeting target, computed from the step_days table on read,
         NOT stored (a stored counter will desync the first time a day syncs late)
trend  = 7-day rolling mean; compare current 7d mean to prior 7d mean for the arrow
```

Grace rule: allow one missed day per 7 without breaking a streak, but display it honestly as "6/7". Punitive streak logic makes people quit.

---

## 6. Build order

Do not build these in parallel. Each depends on the one before.

1. **Auth + profiles + calendar schema** — everything hangs off `profiles`.
2. **Calendar CRUD + recurrence expansion** (§1.2) — verify a night shift renders correctly across a DST boundary before moving on.
3. **Sleep rules + both-free algorithm** (§1.4–1.5). Ship this. It's the emotional core of the app.
4. **Weigh-ins + EMA smoothing** (§3.2) — small, and everything nutritional depends on it.
5. **Food DB integration + food log** (§3.1, §3.6) — the biggest single chunk of work.
6. **TDEE + targets engine** (§3.3–3.4) — needs 14 days of data before it does anything, so ship it early and let data accumulate.
7. **Steps via Shortcuts** (§5) — feeds TDEE, so ideally before you rely on measured numbers.
8. **Fitness logging + progression** (§4).
9. **AI recipe maker** (§2) — last, because it consumes remaining-macros from §3.5 and is useless without it.

---

## 7. What to tell Kiro verbatim

> Implement the following logic exactly as specified. Do not substitute alternative formulas, do not simplify the safety bounds, and do not remove the data-quality gates. Where the spec says a value must be computed from a database lookup, do not use a language model to estimate it. Flag anything you cannot implement rather than approximating it.

Kiro's failure mode is confident substitution — it will swap a calibrated constant for a rounder-looking one and not mention it. Diff what it produces against this document.

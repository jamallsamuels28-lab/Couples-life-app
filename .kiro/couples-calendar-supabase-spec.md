# Couples Calendar — Supabase Build Spec

**For:** expanding the existing PWA (GitHub Pages frontend) into a two-person shared app for Jamall + Rebecca.
**Backend:** Supabase (Postgres + Auth + Realtime).
**Scope locked:** in-app shared events table now; native Google/Apple sync deferred to phase 2.
**Core feature:** not "a calendar with two names in it" — it's *seeing each other's unavailability and finding the windows you're both actually free.* Every decision below serves that.

---

## 1. Architecture in one line

GitHub Pages keeps hosting the frontend. Supabase holds all shared data. The browser stores **nothing** that matters (localStorage is per-device and never syncs — that's the whole reason for this migration). Two auth accounts, both see everything, sync is real-time.

---

## 2. Supabase setup (do first)

1. Create a project at supabase.com (free tier covers two users indefinitely).
2. Auth → Providers → enable **Email**. Turn *off* "confirm email" during dev so you and Rebecca can log in immediately.
3. Create the two accounts (yours + Rebecca's).
4. Run the SQL in section 3, then insert the two `profiles` rows (section 6).
5. Grab the project URL + anon key for the frontend client.

---

## 3. Schema (run in Supabase SQL editor)

```sql
-- PROFILES: extends Supabase's built-in auth.users
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  display_name text not null,
  color        text not null default '#3b82f6',  -- hex, for calendar colour-coding
  created_at   timestamptz not null default now()
);
alter table public.profiles enable row level security;

-- EVENT CATEGORIES
create type event_category as enum
  ('shift','appointment','personal','date','dog','deposit','other');

-- EVENTS: the one table that does everything, including shifts
create table public.events (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  category    event_category not null default 'personal',
  start_time  timestamptz not null,
  end_time    timestamptz not null,
  all_day     boolean not null default false,
  is_shared   boolean not null default false,  -- true = belongs to both, neutral colour
  is_busy     boolean not null default true,   -- counts as unavailable for overlap calc
  rrule       text,                            -- iCal RRULE string; null = one-off
  notes       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
alter table public.events enable row level security;

create index events_owner_idx on public.events(owner_id);
create index events_start_idx on public.events(start_time);
```

**Why shifts aren't their own table:** a shift is just an event with `category='shift'` and an `rrule`. One table, one calendar view, one overlap calculation. Fewer moving parts.

---

## 4. Row Level Security (run after schema)

This is a *private two-person space*, so the rule is "both partners see everything, but you can only edit your own or shared events."

```sql
-- PROFILES
create policy "read all profiles"   on public.profiles
  for select to authenticated using (true);
create policy "update own profile"  on public.profiles
  for update to authenticated using (id = auth.uid());

-- EVENTS
create policy "couple reads all events" on public.events
  for select to authenticated using (true);

create policy "insert own events" on public.events
  for insert to authenticated with check (owner_id = auth.uid());

create policy "update own or shared" on public.events
  for update to authenticated using (owner_id = auth.uid() or is_shared = true);

create policy "delete own or shared" on public.events
  for delete to authenticated using (owner_id = auth.uid() or is_shared = true);
```

**Honest caveat:** `select using (true)` means any authenticated user sees all events. That's correct *because there are only two of you and shared visibility is the point.* If this ever grew past a couple, you'd add a `household_id` and scope by it. Don't build that now — it's over-engineering for two people.

---

## 5. Recurrence — the thing that forces client-side logic

Postgres has no native recurring events. Store the pattern as a standard **iCal RRULE string** in `events.rrule`, then **expand it in the frontend** with [`rrule.js`](https://github.com/jkbrend/rrule) (or the maintained `rrule` npm package).

Key point: the seed row's `start_time`/`end_time` define the *duration*. When you expand the RRULE you get a list of start datetimes; add the fixed duration to each for its end. A night shift crossing midnight is one instance of `start 22:30 → end 09:00 next day`.

Because you're expanding recurrence in JS anyway, **the overlap calculation also lives in JS** (section 7). Don't try to do interval maths in SQL — you'd have to expand recurrence there too, and it gets ugly fast.

---

## 6. Seed data

Insert profiles (replace the UUIDs with the real `auth.users` ids from your two accounts):

```sql
insert into public.profiles (id, display_name, color) values
  ('<jamall-auth-uuid>',  'Jamall',  '#2563eb'),   -- blue
  ('<rebecca-auth-uuid>', 'Rebecca', '#db2777');   -- pink
```

Seed **your** shift (nights Sun–Wed, 22:30–09:00). Times are BST (+01:00) in summer — Supabase stores UTC, so be explicit:

```sql
insert into public.events
  (owner_id, title, category, start_time, end_time, is_busy, rrule)
values
  ('<jamall-auth-uuid>', 'AMXL Night Shift', 'shift',
   '2026-08-09T22:30:00+01:00', '2026-08-10T09:00:00+01:00',
   true, 'FREQ=WEEKLY;BYDAY=SU,MO,TU,WE');
```

Rebecca's ISO pattern goes in the same way — **I need her exact shift times/days to write hers.** Placeholder until then.

---

## 7. The payoff: "when are we both free?"

Fetch all events in a window, expand recurrence, then run interval subtraction. This is the one screen that justifies the whole build.

```js
// events: expanded instances for BOTH people in [rangeStart, rangeEnd]
//         each { start: Date, end: Date, isBusy: bool }
// Returns windows where NEITHER person is busy, within waking hours.
function bothFreeWindows(events, rangeStart, rangeEnd, {
  dayStartHour = 8, dayEndHour = 23, minMinutes = 30
} = {}) {
  // 1. busy intervals only, sorted
  const busy = events.filter(e => e.isBusy)
    .map(e => [e.start.getTime(), e.end.getTime()])
    .sort((a, b) => a[0] - b[0]);

  // 2. merge the union of both people's busy time
  const merged = [];
  for (const [s, e] of busy) {
    const last = merged[merged.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else merged.push([s, e]);
  }

  // 3. for each day, subtract busy from waking hours -> free gaps
  const free = [];
  for (let d = new Date(rangeStart); d < rangeEnd; d.setDate(d.getDate() + 1)) {
    const dayStart = new Date(d); dayStart.setHours(dayStartHour, 0, 0, 0);
    const dayEnd   = new Date(d); dayEnd.setHours(dayEndHour, 0, 0, 0);
    let cursor = dayStart.getTime();
    for (const [s, e] of merged) {
      if (e <= cursor || s >= dayEnd.getTime()) continue;
      if (s > cursor) free.push([cursor, Math.min(s, dayEnd.getTime())]);
      cursor = Math.max(cursor, e);
      if (cursor >= dayEnd.getTime()) break;
    }
    if (cursor < dayEnd.getTime()) free.push([cursor, dayEnd.getTime()]);
  }

  // 4. keep only gaps long enough to matter
  return free
    .filter(([s, e]) => (e - s) >= minMinutes * 60000)
    .map(([s, e]) => ({ start: new Date(s), end: new Date(e) }));
}
```

Tune `dayStartHour`/`dayEndHour` to your real waking windows — on night-shift days your "day" is shifted, so you may end up passing per-day bounds rather than fixed 8–23.

---

## 8. Build order for Kiro (don't jump around)

1. Create Supabase project, run schema (§3) + RLS (§4).
2. Enable email auth, create both accounts, insert `profiles` (§6).
3. Add `supabase-js` to the PWA; wire URL + anon key.
4. Login screen — gate the whole app behind auth.
5. Seed shift events (yours from §6, Rebecca's once you give me her pattern).
6. Events CRUD: add / edit / delete, with owner, `is_shared`, category.
7. Calendar week-view: colour by owner, shared events neutral.
8. Recurrence expansion with `rrule.js` for display.
9. **Both-free view** (§7) — the feature that makes it a *couples* calendar.
10. Migrate old fitness data from localStorage (only if that's where it lives).

---

## 9. iOS gotchas (Rebecca's side especially)

- She **must** "Add to Home Screen" — installed PWAs keep data; uninstalled Safari can evict local data after ~7 days idle. Another reason real data lives in Supabase.
- PWA push works only on iOS 16.4+ and only once installed. Don't rely on in-app push for reminders — use the phone's real calendar/alarms for anything time-critical.

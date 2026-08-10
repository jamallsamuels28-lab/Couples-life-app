-- Migration: food_cache for ingredient resolution (kiro-algorithm-spec.md §2.3)
--
-- "Cache every resolution in a local food_cache table keyed by normalised name.
--  Second lookup of 'chicken thigh' must never hit the network."
--
-- Also holds negative results: an ingredient that could not be matched is
-- recorded as unresolved, so the same miss does not re-query USDA and Open
-- Food Facts on every recipe.

create table if not exists public.food_cache (
  id             uuid primary key default gen_random_uuid(),
  -- lowercase, punctuation stripped, singularised
  normalised_name text not null unique,
  display_name   text,
  source         text not null check (source in ('usda','off','custom','unresolved')),
  source_id      text,
  per_100g       jsonb,
  -- Token overlap with the query that produced it. Below 0.5 is treated as a
  -- miss: a wrong match is worse than a missing one.
  match_score    numeric(4,3),
  resolved       boolean not null default true,
  hits           integer not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index if not exists food_cache_name_idx on public.food_cache(normalised_name);
create index if not exists food_cache_name_trgm on public.food_cache using gin (normalised_name gin_trgm_ops);

alter table public.food_cache enable row level security;

-- Shared reference data. Written by the Edge Function via the service role;
-- the client only ever reads it.
drop policy if exists "couple reads food cache" on public.food_cache;
create policy "couple reads food cache" on public.food_cache
  for select to authenticated using (true);

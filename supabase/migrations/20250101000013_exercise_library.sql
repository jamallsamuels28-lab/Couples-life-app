-- Migration: exercise library metadata (kiro-algorithm-spec.md §4.1)
--
-- The exercises table held only what the progression maths needs: pattern,
-- unilateral, lower_body, compound. That is enough to compute an e1RM and
-- rank a lift, and not enough to answer "what should I do for shoulders" or
-- "how is this meant to look". With 27 seeded rows it was a lookup list, not
-- a library.
--
-- These columns are reference material. Nothing here feeds a calculation, so
-- an exercise with no image or a thin description still logs and progresses
-- exactly as before — deliberately, so importing third-party data can never
-- move a training number.

alter table public.exercises
  -- ExRx-style taxonomy: browse by body part, then narrow by equipment.
  add column if not exists category          text,
  add column if not exists primary_muscles   text[] not null default '{}',
  add column if not exists secondary_muscles text[] not null default '{}',
  add column if not exists equipment         text[] not null default '{}',
  add column if not exists description       text,
  add column if not exists image_url         text,
  add column if not exists video_url         text,
  -- Provenance. Imported rows carry their licence and author so attribution
  -- survives in the data rather than living only in a comment nobody reads.
  add column if not exists source            text not null default 'builtin',
  add column if not exists source_id         text,
  add column if not exists license           text,
  add column if not exists license_author    text;

-- Browsing is always "show me everything for this body part", so the index
-- follows the taxonomy rather than the name.
create index if not exists exercises_category_idx
  on public.exercises(category) where category is not null;

create index if not exists exercises_primary_muscles_idx
  on public.exercises using gin (primary_muscles);

create index if not exists exercises_equipment_idx
  on public.exercises using gin (equipment);

-- Name search, matching how foods are searched.
create index if not exists exercises_name_trgm
  on public.exercises using gin (name gin_trgm_ops);

-- An imported exercise is identified by (source, source_id) so re-running the
-- seed updates rather than duplicates. The existing unique constraint on name
-- cannot do this: two legitimate variants can share a name across sources.
create unique index if not exists exercises_source_ref_idx
  on public.exercises(source, source_id)
  where source_id is not null;

comment on column public.exercises.source is
  'builtin for the original hand-seeded rows, wger for imported ones.';
comment on column public.exercises.license is
  'Licence of the imported description/images. Must be honoured when displaying them.';

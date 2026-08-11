-- Migration: per-person recipe favourites
--
-- Favourites lived in localStorage, keyed per user. That made them
-- per-browser rather than per-person: favouriting a recipe on the laptop left
-- it unfavourited on the phone, and clearing site data wiped the lot.
--
-- `recipes.is_favorite` already existed but was never read or written by any
-- code. It could not do this job anyway — it is one boolean on a row shared by
-- both partners, so it can only express "one of us likes this", not which one.
-- Left in place rather than dropped, so an existing row's data is not thrown
-- away, but commented as superseded.

create table if not exists public.recipe_favorites (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  recipe_id  uuid not null references public.recipes(id) on delete cascade,
  created_at timestamptz not null default now(),
  -- One row per person per recipe. Makes favouriting idempotent, so a double
  -- tap or an offline replay cannot insert twice.
  primary key (user_id, recipe_id)
);

create index if not exists recipe_favorites_user_idx
  on public.recipe_favorites(user_id);

alter table public.recipe_favorites enable row level security;

-- The book is shared, so seeing what the other person has starred is the
-- point. Writing is your own only.
create policy "couple reads recipe favourites" on public.recipe_favorites
  for select to authenticated using (true);
create policy "insert own recipe favourites" on public.recipe_favorites
  for insert to authenticated with check (user_id = auth.uid());
create policy "delete own recipe favourites" on public.recipe_favorites
  for delete to authenticated using (user_id = auth.uid());

comment on column public.recipes.is_favorite is
  'Superseded by public.recipe_favorites, which records favourites per person. Not read or written by the app.';

alter publication supabase_realtime add table public.recipe_favorites;

-- Migration: Apply Row Level Security policies for all new tables
-- Requirements: 11.1, 11.2, 11.3
--
-- Policy rules:
--   steps_log & meals: both partners read all, insert/update/delete own (user_id = auth.uid())
--   recipes & pantry_items: fully shared CRUD for both authenticated users
--   dietary_preferences: both read all, insert/update own (user_id = auth.uid())

-- =============================================================================
-- STEPS_LOG: both partners see all, edit own
-- =============================================================================
create policy "couple reads steps" on public.steps_log
  for select to authenticated using (true);

create policy "insert own steps" on public.steps_log
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own steps" on public.steps_log
  for update to authenticated using (user_id = auth.uid());

create policy "delete own steps" on public.steps_log
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- MEALS: both partners see all, edit own
-- =============================================================================
create policy "couple reads meals" on public.meals
  for select to authenticated using (true);

create policy "insert own meals" on public.meals
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own meals" on public.meals
  for update to authenticated using (user_id = auth.uid());

create policy "delete own meals" on public.meals
  for delete to authenticated using (user_id = auth.uid());

-- =============================================================================
-- RECIPES: shared — both read/write all
-- =============================================================================
create policy "couple reads recipes" on public.recipes
  for select to authenticated using (true);

create policy "insert recipes" on public.recipes
  for insert to authenticated with check (created_by = auth.uid());

create policy "update recipes" on public.recipes
  for update to authenticated using (true);

create policy "delete recipes" on public.recipes
  for delete to authenticated using (true);

-- =============================================================================
-- DIETARY PREFERENCES: both see all, edit own
-- =============================================================================
create policy "couple reads prefs" on public.dietary_preferences
  for select to authenticated using (true);

create policy "upsert own prefs" on public.dietary_preferences
  for insert to authenticated with check (user_id = auth.uid());

create policy "update own prefs" on public.dietary_preferences
  for update to authenticated using (user_id = auth.uid());

-- =============================================================================
-- PANTRY ITEMS: fully shared
-- =============================================================================
create policy "couple reads pantry" on public.pantry_items
  for select to authenticated using (true);

create policy "insert pantry" on public.pantry_items
  for insert to authenticated with check (added_by = auth.uid());

create policy "update pantry" on public.pantry_items
  for update to authenticated using (true);

create policy "delete pantry" on public.pantry_items
  for delete to authenticated using (true);

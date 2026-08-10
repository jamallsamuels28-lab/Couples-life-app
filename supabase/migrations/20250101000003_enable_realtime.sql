-- Migration: Enable Realtime on the shared data tables
-- Requirement 12.1: subscribe to Realtime channels for events, steps_log,
-- meals, recipes, and pantry_items upon successful authentication.
--
-- Realtime only broadcasts changes for tables in the supabase_realtime
-- publication. The events and user_settings tables are added in migration
-- 20250101000000; this adds the remaining five.

alter publication supabase_realtime add table public.steps_log;
alter publication supabase_realtime add table public.meals;
alter publication supabase_realtime add table public.recipes;
alter publication supabase_realtime add table public.pantry_items;
alter publication supabase_realtime add table public.dietary_preferences;

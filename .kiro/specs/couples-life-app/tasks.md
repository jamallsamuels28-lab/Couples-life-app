# Implementation Plan: Couples Life App

## Overview

Implement a unified PWA with three modules (Calendar, Steps, Food) for two authenticated users on Supabase. The frontend is vanilla JavaScript hosted on GitHub Pages, using the design system defined in design-system.html (neutral greyscale chassis with two identity colours per partner). Backend uses Supabase (PostgreSQL, Auth, Realtime, Edge Functions) with OpenAI for recipe generation.

## Tasks

- [x] 1. Database schema and security setup
  - [x] 1.1 Create Supabase migration for steps_log, meals, recipes, dietary_preferences, and pantry_items tables
    - Include all CHECK constraints (step_count 0–200000, macros >= 0, meal_type enum, unique user+date on steps_log)
    - Add indexes: steps_user_date_idx, meals_user_date_idx, recipes_tags_idx (GIN)
    - _Requirements: 4.1, 4.2, 4.3, 7.2, 7.3, 11.1, 14.4_

  - [x] 1.2 Apply Row Level Security policies for all new tables
    - steps_log and meals: both partners read all, insert/update/delete own (user_id = auth.uid())
    - recipes and pantry_items: fully shared CRUD for both authenticated users
    - dietary_preferences: both read, upsert/update own
    - _Requirements: 11.1, 11.2, 11.3_

  - [x] 1.3 Write integration tests for RLS policies
    - Test that user A cannot insert/update user B's steps_log or meals
    - Test that both users can read all records across all tables
    - Test shared write access on recipes and pantry_items
    - _Requirements: 11.1, 11.2, 11.3_

- [x] 2. Design system and app shell
  - [x] 2.1 Implement CSS design tokens and theme system
    - Port all CSS custom properties from design-system.html (colours, fonts, spacing, radii, shadows)
    - Implement dark/light theme toggle via data-theme attribute on root element
    - Load General Sans (Fontshare) and IBM Plex Mono (Google Fonts)
    - Apply tabular-nums and monospace to all numeric displays
    - _Requirements: 13.1, 13.2, 13.5, 13.6_

  - [x] 2.2 Implement identity colour picker with 60° gap enforcement
    - Six hue options per partner (Slate 250°, Teal 190°, Moss 145°, Brass 85°, Clay 35°, Plum 330°)
    - Disable hues within 60° of the other partner's selection
    - Store selection in user profile / localStorage
    - Use oklch(var(--id-l) var(--id-c) var(--id-x-h)) — never hardcode colours
    - _Requirements: 13.2, 13.3_

  - [x] 2.3 Implement app shell with authentication gating and navigation
    - Init Supabase client, check session on load, redirect to auth if no session
    - Bottom navigation bar with Calendar, Steps, Food tabs and active state indicators
    - SPA routing between modules without full page reload
    - Provide currentUser and partner profile context to child modules
    - Handle session expiry: revoke access, clear cache, return to login
    - Display error on auth failure with retry; show partner-not-linked message if partner unresolved
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8_

  - [x] 2.4 Implement design system UI components
    - Focus indicators: 2px solid outline, 1px offset on all interactive elements
    - Honour prefers-reduced-motion (disable transitions)
    - No gradients except overlap-fill, no emoji, stroked icons (1.5px weight, 20px box)
    - Border-radius constrained to 3/6/10px; spacing multiples of 4; shadows max 0 1px 2px
    - Shared items styled with var(--ink-2) graphite, not a third colour
    - _Requirements: 13.4, 13.6, 13.7, 13.8_

  - [x] 2.5 Implement realtime connection management and offline indicator
    - Subscribe to Supabase Realtime channels for events, steps_log, meals, recipes, pantry_items on auth
    - Show non-blocking offline indicator in nav bar within 3 seconds of connection loss
    - Auto-reconnect on restore, refetch latest data to reconcile missed changes
    - After 3 failed reconnection attempts, display persistent error with manual refresh option
    - _Requirements: 12.1, 12.2, 12.3, 12.4, 12.6_

- [x] 3. Checkpoint — Shell and infrastructure
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Calendar module — events CRUD
  - [x] 4.1 Implement calendar event creation with validation
    - Title 1–100 chars, start time, end time (must be after start), optional RRULE
    - Insert into events table via Supabase, display on calendar view
    - Inline error on validation failure or network error; preserve form data
    - _Requirements: 2.1, 2.7, 14.6_

  - [x] 4.2 Implement calendar event read, update, and delete
    - Fetch and display all events from both partners within visible date range
    - Update event fields with same validation rules as creation
    - Delete event removes from DB and view
    - _Requirements: 2.2, 2.3, 2.4_

  - [x] 4.3 Implement RRULE recurrence expansion
    - Use rrule library to expand recurring events into concrete instances within visible range
    - Cap at 365 instances per event
    - _Requirements: 2.5_

  - [x] 4.4 Implement realtime subscription for partner calendar changes
    - Subscribe to events table changes; update view on partner create/update/delete without refresh
    - Show toast on concurrent edit conflict with refresh option
    - _Requirements: 2.6, 14.5_

  - [x] 4.5 Write property test for RRULE expansion instance count
    - **Property 5: RRULE expansion instance count**
    - **Validates: Requirement 2.5**

- [x] 5. Calendar module — free window calculation
  - [x] 5.1 Implement bothFreeWindows algorithm
    - Port the reference implementation from design-system.html, adapting for date ranges
    - Extract busy intervals (isBusy events from both partners including expanded recurrences)
    - Merge overlapping busy intervals into sorted union
    - For each day: subtract busy from waking hours (dayStartHour/dayEndHour)
    - Filter by minimum duration (default 45 min, configurable 5–480 min)
    - Return sorted, non-overlapping free windows
    - Reject invalid range (start >= end or > 31 days) with error message
    - Return empty list if no free windows exist
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8_

  - [x] 5.2 Implement the overlap ribbon UI component
    - Two tracks showing each partner's busy/sleep blocks with identity colours
    - Combined band below highlighting mutual free windows with gradient from id-a to id-b
    - Minor windows (< longest) rendered at reduced opacity
    - Hour markers and total free time display
    - _Requirements: 13.9_

  - [x] 5.3 Write property test: free windows never overlap busy events
    - **Property 1: Free windows never overlap with busy events**
    - **Validates: Requirements 3.1, 3.5**

  - [x] 5.4 Write property test: free windows meet minimum duration
    - **Property 2: Free windows meet minimum duration**
    - **Validates: Requirement 3.2**

  - [x] 5.5 Write property test: free windows within waking hours
    - **Property 3: Free windows are within waking hours**
    - **Validates: Requirement 3.3**

  - [x] 5.6 Write property test: free windows sorted and non-overlapping
    - **Property 4: Free windows are sorted and non-overlapping**
    - **Validates: Requirements 3.4, 3.6**

- [x] 6. Checkpoint — Calendar module complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 7. Steps module — logging and sync
  - [x] 7.1 Implement manual step count logging with validation
    - Upsert single entry per user per date
    - Reject count < 0 or > 200,000 with inline error
    - Reject future dates with inline error
    - Record source as 'manual'
    - Preserve form data on validation failure
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.8, 14.2, 14.3, 14.6_

  - [x] 7.2 Implement health API sync for step data
    - Request step data from Health Connect / Apple Health for current date
    - Upsert result, retaining whichever value is higher (manual vs sync)
    - Record source as 'health_connect' or 'apple_health'
    - Display error on sync failure, retain existing entry unchanged
    - Fall back to manual if device unsupported or permissions denied, with explanation message
    - _Requirements: 4.5, 4.6, 4.7, 4.8, 12.5_

  - [x] 7.3 Write property test: step log uniqueness per user per date
    - **Property 6: Step log uniqueness per user per date**
    - **Validates: Requirement 4.2**

  - [x] 7.4 Write property test: health sync never decreases manual value
    - **Property 7: Health sync never decreases manual value**
    - **Validates: Requirement 4.6**

- [x] 8. Steps module — partner visibility, comparison, and streaks
  - [x] 8.1 Implement partner step visibility and realtime updates
    - Fetch and display step data for both partners within selected range (show 0 for missing dates)
    - Subscribe to steps_log realtime; update partner display within 5 seconds without refresh
    - _Requirements: 5.1, 5.2_

  - [x] 8.2 Implement comparative statistics (daily and weekly)
    - Show each partner's total for current day and current week (Mon–Sun)
    - Indicator for who has higher total; tied-state indicator for equal counts
    - _Requirements: 5.3, 5.4_

  - [x] 8.3 Implement streak calculation (current and longest)
    - Count consecutive days ending at today (or yesterday if today unlogged) where count >= goal
    - Compute longest streak across entire history
    - Ensure currentStreak <= longestStreak
    - Default goal: 10,000 steps; configurable 1–200,000 with validation
    - Goal changes apply prospectively, not retroactively
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.6_

  - [x] 8.4 Write property test: streak calculation invariants
    - **Property 8: Streak calculation invariants**
    - **Validates: Requirements 6.1, 6.2, 6.3, 6.4**

  - [x] 8.5 Write property test: partner comparison correctness
    - **Property 16: Partner comparison correctness**
    - **Validates: Requirement 5.3**

- [x] 9. Checkpoint — Steps module complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 10. Food module — meal logging and macros
  - [x] 10.1 Implement meal logging with validation
    - Accept title (max 100 chars, non-empty/non-whitespace), meal_type (breakfast/lunch/dinner/snack), macros
    - Validate calories, protein_g, carbs_g, fats_g each 0–10,000
    - Insert meal record for user+date; allow multiple meals of same type per date
    - Inline error messages adjacent to failing fields; preserve form data on failure
    - Make meals visible to partner via shared data layer
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.7, 14.1, 14.6_

  - [x] 10.2 Implement daily macro aggregation
    - Sum calories, protein_g, carbs_g, fats_g across all meals for user+date
    - Return zero for all values if no meals exist
    - Display using IBM Plex Mono with tabular-nums for numeric alignment
    - _Requirements: 7.5, 7.6_

  - [x] 10.3 Write property test: macro aggregation equals independent sum
    - **Property 9: Macro aggregation equals independent sum**
    - **Validates: Requirements 7.5, 7.6**

- [x] 11. Food module — dietary preferences
  - [x] 11.1 Implement dietary preferences CRUD
    - Upsert semantics (one record per user)
    - Persist allergies (up to 20), dislikes (up to 30), diet type, macro targets (positive integers)
    - Validate diet_type in ['flexible', 'vegetarian', 'vegan', 'keto', 'halal']
    - Reject invalid diet type with error listing valid options
    - _Requirements: 10.1, 10.2, 10.4, 10.5_

- [x] 12. Food module — recipe book and pantry
  - [x] 12.1 Implement recipe book (save, browse, filter, favorite)
    - Save recipes to shared book (title, ingredients, steps, macros, meal type, tags)
    - Filter by tags, meal type, favorite status; sort most recently saved first
    - Per-user favorites (independent per partner)
    - _Requirements: 9.1, 9.2, 9.3_

  - [x] 12.2 Implement pantry management
    - Add pantry item: name (1–100 chars), category, optional quantity, optional expiry date
    - Reject empty/over-100-char names with inline error
    - Both partners can update or remove any pantry item
    - Exclude expired items from recipe generation context
    - _Requirements: 9.4, 9.5, 9.6, 9.7_

  - [x] 12.3 Write property test: recipe book filtering correctness
    - **Property 15: Recipe book filtering correctness**
    - **Validates: Requirement 9.2**

- [x] 13. Food module — AI recipe generation
  - [x] 13.1 Implement Edge Function for recipe generation (Supabase)
    - Store OpenAI API key in server-side secrets only
    - Accept prompt from client, call OpenAI chat completion
    - Return structured recipe JSON (title, ingredients with name/amount/unit, ordered steps, macro estimates)
    - Retry up to 3 times with exponential backoff (starting 1s) on API error/malformed response
    - Return non-technical error message if all retries fail
    - _Requirements: 8.5, 8.8, 11.5_

  - [x] 13.2 Implement client-side recipe generation flow
    - Merge both partners' allergies into combined exclusion list (union)
    - Select more restrictive diet type per hierarchy: vegan > vegetarian > halal > keto > flexible
    - Include non-expired pantry items as preferred ingredients in prompt
    - Accept optional constraints: meal type, max prep time, max calories, servings
    - Treat missing preferences as no allergies/dislikes + 'flexible' diet
    - Validate generated recipe against allergen list and diet type; discard and error if failed
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.6, 8.7, 8.9, 8.10, 10.3_

  - [x] 13.3 Write property test: allergy exclusion is union of both partners
    - **Property 10: Allergy exclusion list is the union of both partners**
    - **Validates: Requirements 8.2, 10.3**

  - [x] 13.4 Write property test: restrictive diet type selection
    - **Property 11: Restrictive diet type selection**
    - **Validates: Requirement 8.3**

  - [x] 13.5 Write property test: generated recipes contain no allergens
    - **Property 12: Generated recipes contain no allergens**
    - **Validates: Requirement 8.6**

  - [x] 13.6 Write property test: generated recipes respect diet type
    - **Property 13: Generated recipes respect diet type**
    - **Validates: Requirement 8.7**

  - [x] 13.7 Write property test: pantry items included in generation prompt
    - **Property 14: Pantry items included in generation prompt**
    - **Validates: Requirements 8.4, 9.6**

- [x] 14. Checkpoint — Food module complete
  - Ensure all tests pass, ask the user if questions arise.

- [x] 15. Integration wiring and final polish
  - [x] 15.1 Wire all modules to shared realtime subscription layer
    - Ensure realtime updates propagate to active views within 2 seconds
    - Verify auth token included on all API calls; reject if missing/expired
    - _Requirements: 12.1, 12.2, 11.4_

  - [x] 15.2 Implement PWA manifest and service worker
    - Configure for GitHub Pages hosting
    - Handle install prompt, cache app shell assets
    - _Requirements: 1.2_

  - [x] 15.3 Write integration tests for cross-module flows
    - Test: create event → appears in both free windows and partner's view
    - Test: log meal → macros aggregate → visible to partner
    - Test: update pantry → reflected in recipe generation context
    - _Requirements: 2.6, 5.2, 7.7, 9.7_

- [x] 16. Final checkpoint — Ensure all tests pass
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document using fast-check
- Unit tests validate specific examples and edge cases
- The design-system.html contains a working reference implementation of the bothFreeWindows algorithm (MIN_FREE=45 minutes) — use it as the source of truth when implementing task 5.1
- All CSS identity colours must use oklch with custom properties, never hardcoded hex/rgb values
- Fonts: General Sans for UI, IBM Plex Mono for numbers — both loaded externally
- The app is strictly for two users (Jamall + Rebecca) — no invite system or multi-household support

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "2.1"] },
    { "id": 2, "tasks": ["1.3", "2.2", "2.3"] },
    { "id": 3, "tasks": ["2.4", "2.5"] },
    { "id": 4, "tasks": ["4.1", "7.1", "10.1", "11.1"] },
    { "id": 5, "tasks": ["4.2", "4.3", "7.2", "10.2", "12.1", "12.2"] },
    { "id": 6, "tasks": ["4.4", "4.5", "5.1", "7.3", "7.4", "10.3"] },
    { "id": 7, "tasks": ["5.2", "5.3", "5.4", "5.5", "5.6", "8.1", "12.3"] },
    { "id": 8, "tasks": ["8.2", "8.3", "13.1"] },
    { "id": 9, "tasks": ["8.4", "8.5", "13.2"] },
    { "id": 10, "tasks": ["13.3", "13.4", "13.5", "13.6", "13.7"] },
    { "id": 11, "tasks": ["15.1", "15.2"] },
    { "id": 12, "tasks": ["15.3"] }
  ]
}
```

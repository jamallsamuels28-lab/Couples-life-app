# Requirements Document

## Introduction

The Couples Life App is a unified PWA for two authenticated users (Jamall + Rebecca) that integrates three modules — shared calendar with availability overlap detection, step count fitness tracker with partner visibility, and food tracker with AI-powered recipe generation. The app extends the existing Supabase-backed architecture with real-time data sharing, mutual visibility by default, and a text-based vanilla JS UI hosted on GitHub Pages.

## Glossary

- **App_Shell**: The navigation and auth-gating wrapper that routes between the three modules and provides partner context to child views
- **Calendar_Module**: The component responsible for shared event management, recurrence expansion, and free window calculation
- **Steps_Module**: The component responsible for daily step count tracking, streak calculation, and partner comparison
- **Food_Module**: The component responsible for meal logging, macro aggregation, and AI recipe generation
- **PWA**: Progressive Web App — the single-page application served from GitHub Pages
- **Supabase**: The backend-as-a-service platform providing PostgreSQL, Auth, Realtime subscriptions, and Edge Functions
- **RLS**: Row Level Security — PostgreSQL policies controlling data access per authenticated user
- **RRULE**: iCal recurrence rule format used to define repeating calendar events
- **Free_Window**: A time interval where neither partner has a busy event, within waking hours and meeting minimum duration
- **Streak**: Consecutive days where a user's step count meets or exceeds their daily goal
- **Macro**: Macronutrient values — calories (kcal), protein (g), carbohydrates (g), and fats (g)
- **Edge_Function**: A Supabase-hosted serverless function used to call external APIs securely
- **Health_API**: Device health data sources (Health Connect on Android, Apple Health on iOS) used for step count sync
- **Recipe_Book**: The shared collection of saved recipes accessible to both partners
- **Pantry**: The shared inventory of available ingredients in the couple's kitchen
- **Design_System**: The visual language defined in design-system.html — neutral greyscale chassis with two identity colours (one per partner), shared items use graphite/neutral
- **Identity_Colour**: A per-user accent colour expressed as oklch(var(--id-l) var(--id-c) var(--id-x-h)), never hardcoded; six hue options (Slate 250°, Teal 190°, Moss 145°, Brass 85°, Clay 35°, Plum 330°) with a 60° minimum gap enforced between partners
- **Overlap_Ribbon**: The signature UI element showing both schedules as tracks with a combined band highlighting mutual free time

## Requirements

### Requirement 1: Authentication and App Shell

**User Story:** As a user, I want to authenticate and navigate between the app's modules, so that I can securely access all features from a single interface.

#### Acceptance Criteria

1. WHEN a user opens the PWA without an active session, THE App_Shell SHALL redirect to the Supabase authentication flow
2. WHEN a user successfully authenticates, THE App_Shell SHALL load the navigation bar, default to the Calendar view, and grant access to all three modules
3. THE App_Shell SHALL display a bottom navigation with active-state indicators for Calendar, Steps, and Food views
4. WHEN a user selects a navigation item, THE App_Shell SHALL route to the corresponding module view without a full page reload
5. THE App_Shell SHALL provide the authenticated user's profile (user ID and display name) and partner profile context to all child modules
6. WHEN the auth session expires or the user logs out, THE App_Shell SHALL revoke access to all module views, clear cached module data, and return to the login screen
7. IF authentication fails, THEN THE App_Shell SHALL display an error indication and offer a retry option
8. IF the partner profile cannot be resolved after authentication, THEN THE App_Shell SHALL display a message indicating the partner account is not linked and disable partner-dependent features

### Requirement 2: Calendar Event Management

**User Story:** As a user, I want to create, read, update, and delete shared calendar events, so that my partner and I can coordinate our schedules.

#### Acceptance Criteria

1. WHEN a user creates a new event with a title (1–100 characters), start time, end time (must be after start time), and optional recurrence rule, THE Calendar_Module SHALL validate the input, insert the event into the database, and display it on the calendar view
2. WHEN the calendar view loads for a date range, THE Calendar_Module SHALL fetch and display all events from both partners within that range
3. WHEN a user updates an existing event's title, start time, end time, or recurrence rule, THE Calendar_Module SHALL validate the updated fields using the same rules as creation, persist the changes, and reflect them on the calendar view
4. WHEN a user deletes an event, THE Calendar_Module SHALL remove it from the database and the calendar view
5. WHEN an event contains an RRULE, THE Calendar_Module SHALL expand the recurrence into concrete instances within the visible date range, up to a maximum of 365 instances per event
6. WHEN a partner creates, updates, or deletes an event, THE Calendar_Module SHALL display the change via realtime subscription without requiring a manual refresh
7. IF event creation, update, or deletion fails due to a network error or validation rejection, THEN THE Calendar_Module SHALL display an inline error message indicating the failure reason and preserve any user-entered data in the form

### Requirement 3: Calendar Free Window Calculation

**User Story:** As a user, I want to see when both my partner and I are free, so that we can easily find time to spend together.

#### Acceptance Criteria

1. WHEN a user requests free windows for a date range, THE Calendar_Module SHALL include all events from both partners (including expanded recurrence instances) where isBusy is true, and compute non-overlapping time intervals within that range where neither partner has a busy event
2. THE Calendar_Module SHALL exclude free windows shorter than the configured minimum duration (default 45 minutes, configurable between 5 and 480 minutes)
3. THE Calendar_Module SHALL restrict free windows to waking hours defined by dayStartHour (default 8, range 0–23) and dayEndHour (default 23, range 1–24), where dayEndHour is greater than dayStartHour
4. THE Calendar_Module SHALL return free windows sorted in chronological order
5. FOR ALL computed free windows, THE Calendar_Module SHALL ensure no window overlaps with any busy event from either partner
6. FOR ALL computed free windows w1 and w2 where w1 is not w2, THE Calendar_Module SHALL ensure w1 does not overlap w2
7. IF the requested date range is invalid (rangeStart is not before rangeEnd) or exceeds 31 days, THEN THE Calendar_Module SHALL reject the request with an error message indicating the constraint violated
8. IF no free windows exist within the requested date range after applying all filters, THEN THE Calendar_Module SHALL return an empty list

### Requirement 4: Step Count Logging

**User Story:** As a user, I want to log my daily step count manually or via health API sync, so that I can track my fitness progress.

#### Acceptance Criteria

1. WHEN a user submits a step count for a date, THE Steps_Module SHALL upsert a single entry for that user and date with the provided count
2. THE Steps_Module SHALL enforce that only one step log entry exists per user per date
3. IF a user submits a step count less than 0 or greater than 200,000, THEN THE Steps_Module SHALL reject the submission and display an error message indicating the allowed range is 0 to 200,000
4. IF a user submits a log date that is after the current calendar date in the user's local timezone, THEN THE Steps_Module SHALL reject the submission and display an error message indicating future dates are not allowed
5. WHEN a user triggers health API sync, THE Steps_Module SHALL request step data from the device Health_API for the current date and upsert the result
6. IF the health API sync fails or returns no data, THEN THE Steps_Module SHALL display an error message indicating the sync was unsuccessful and retain any existing step entry unchanged
7. WHEN health API data is received for a date that already has a manually-entered value, THE Steps_Module SHALL retain whichever value is higher
8. THE Steps_Module SHALL record the data source as 'manual', 'health_connect', or 'apple_health' for each entry

### Requirement 5: Step Count Partner Visibility and Realtime

**User Story:** As a user, I want to see my partner's step counts in real time, so that we can motivate each other and compare progress.

#### Acceptance Criteria

1. WHEN the steps view loads, THE Steps_Module SHALL fetch and display step data for both partners within the selected date range, showing zero steps for any date where a partner has no logged entry
2. WHEN a partner logs or syncs new step data, THE Steps_Module SHALL update the displayed partner step count via Supabase Realtime subscription within 5 seconds of the data change, without requiring manual refresh
3. THE Steps_Module SHALL display comparative statistics for the current day and current week (Monday through Sunday) consisting of each partner's total step count and an indicator identifying which partner has the higher total
4. IF both partners have equal total step counts for the current day or current week comparison, THEN THE Steps_Module SHALL display a tied-state indicator instead of highlighting one partner

### Requirement 6: Step Streak Calculation

**User Story:** As a user, I want to see my streak of consecutive days meeting my step goal, so that I can stay motivated to keep moving.

#### Acceptance Criteria

1. WHEN the streak is calculated, THE Steps_Module SHALL count consecutive days ending at today (or yesterday if today is not yet logged) where the logged step count meets or exceeds the user's daily goal, treating any day with no step log entry as a streak-breaking day
2. THE Steps_Module SHALL compute and display both the current streak and the longest streak as whole numbers of days across the user's entire step log history
3. THE Steps_Module SHALL ensure that currentStreak is less than or equal to longestStreak
4. WHEN a user's current streak is greater than zero, THE Steps_Module SHALL verify that today or yesterday has a step count meeting the goal
5. WHEN a user updates their daily goal, THE Steps_Module SHALL validate the goal is between 1 and 200,000 steps inclusive, persist the new goal, and use it for all subsequent streak calculations without retroactively changing previously completed streak counts
6. IF a user has no daily goal configured, THEN THE Steps_Module SHALL use a default goal of 10,000 steps for streak calculations until the user sets a custom goal

### Requirement 7: Meal Logging and Macro Tracking

**User Story:** As a user, I want to log my meals with nutritional data, so that I can track my daily caloric and macronutrient intake.

#### Acceptance Criteria

1. WHEN a user logs a meal with a title (maximum 100 characters), meal type, and macro values, THE Food_Module SHALL insert the meal record for that user and date, allowing multiple meals of the same meal type per date
2. THE Food_Module SHALL validate that meal_type is one of 'breakfast', 'lunch', 'dinner', or 'snack'
3. THE Food_Module SHALL validate that calories, protein_g, carbs_g, and fats_g are each between 0 and 10,000 inclusive
4. IF a user submits a meal with a title that is empty or contains only whitespace, THEN THE Food_Module SHALL reject the entry and display an inline error message indicating the title is required
5. WHEN a user requests daily macros, THE Food_Module SHALL return the sum of calories, protein_g, carbs_g, and fats_g across all meals for that user and date
6. IF no meals exist for the requested user and date, THEN THE Food_Module SHALL return zero for calories, protein_g, carbs_g, and fats_g
7. WHEN a partner logs a meal, THE Food_Module SHALL make it visible to the other partner via the shared data layer

### Requirement 8: AI Recipe Generation

**User Story:** As a user, I want to generate recipes tailored to our couple's dietary needs using AI, so that we can find meal ideas that work for both of us.

#### Acceptance Criteria

1. WHEN a user requests a recipe with optional constraints (meal type, maximum preparation time, maximum calories, and servings), THE Food_Module SHALL invoke the Edge_Function with the couple's merged dietary preferences, pantry items, and the provided constraints
2. THE Food_Module SHALL merge both partners' allergies into a combined exclusion list and include all items in the generation prompt
3. THE Food_Module SHALL select the more restrictive diet type between the two partners according to the hierarchy vegan > vegetarian > halal > keto > flexible, where the leftmost matching type is selected
4. WHEN pantry items are available, THE Food_Module SHALL include them in the prompt as preferred ingredients, allowing the recipe to include additional ingredients not in the pantry when necessary to complete the recipe
5. THE Edge_Function SHALL return a structured recipe object containing title, ingredients list (each with name, amount, and unit), ordered steps, and macro estimates (calories, protein_g, carbs_g, fats_g)
6. FOR ALL generated recipes, THE Food_Module SHALL verify that no ingredient matches any allergy from either partner's combined exclusion list
7. FOR ALL generated recipes, THE Food_Module SHALL verify that the recipe respects the selected diet type according to the hierarchy vegan > vegetarian > halal > keto > flexible
8. IF the OpenAI API returns an error or malformed response, THEN THE Edge_Function SHALL retry up to 3 times with exponential backoff starting at 1 second, and IF all retries fail, THEN THE Edge_Function SHALL return a non-technical error message indicating that recipe generation is temporarily unavailable
9. IF one or both partners have no dietary preferences record, THEN THE Food_Module SHALL treat missing preferences as having no allergies, no dislikes, and a diet type of 'flexible'
10. IF a generated recipe fails allergen or diet type validation, THEN THE Food_Module SHALL discard the recipe and return an error message indicating the generated recipe did not meet dietary safety requirements

### Requirement 9: Recipe Book and Pantry Management

**User Story:** As a user, I want to save recipes and manage our shared pantry, so that we can build a collection of meals we love and know what ingredients we have.

#### Acceptance Criteria

1. WHEN a user saves a recipe, THE Food_Module SHALL store it in the shared Recipe_Book accessible to both partners, retaining title, ingredients, steps, macro estimates, meal type, and any user-assigned tags
2. WHEN a user browses the Recipe_Book, THE Food_Module SHALL support filtering by user-assigned tags, meal type, and favorite status, and SHALL return results sorted by most recently saved first
3. WHEN a user marks a recipe as favorite, THE Food_Module SHALL persist the favorite preference for that individual user, so that each partner maintains their own list of favorites independent of the other
4. WHEN a user adds a pantry item with a name (1–100 characters), category, optional quantity, and optional expiry date, THE Food_Module SHALL store it in the shared Pantry
5. IF a user submits a pantry item with an empty name or a name exceeding 100 characters, THEN THE Food_Module SHALL reject the submission with an inline error message indicating the name constraint
6. THE Food_Module SHALL allow both partners to update or remove any pantry item in the shared Pantry
7. WHEN a user requests recipe generation, THE Food_Module SHALL provide pantry items that have no expiry date or whose expiry date is today or later as context for ingredient selection, excluding expired items

### Requirement 10: Dietary Preferences Management

**User Story:** As a user, I want to set my dietary preferences including allergies, dislikes, and macro targets, so that recipe generation respects my needs.

#### Acceptance Criteria

1. WHEN a user sets dietary preferences, THE Food_Module SHALL persist allergies (up to 20 items), dislikes (up to 30 items), diet type, and macro targets (calorie_target, protein_target, carbs_target, fats_target as positive integers) for that user
2. THE Food_Module SHALL enforce that each user has at most one dietary preferences record, using upsert semantics on subsequent updates
3. WHEN generating recipes, THE Food_Module SHALL read both partners' preferences and merge exclusions (union of allergies and dislikes)
4. THE Food_Module SHALL support diet types: 'flexible', 'vegetarian', 'vegan', 'keto', and 'halal'
5. IF a user submits a diet type not in the supported list, THEN THE Food_Module SHALL reject the submission with an error message indicating valid diet type options

### Requirement 11: Data Access and Security

**User Story:** As a user, I want my data to be secure and shared only with my partner, so that our personal information stays private to our couple.

#### Acceptance Criteria

1. THE Supabase RLS SHALL allow both authenticated users to read all records in steps_log, meals, recipes, dietary_preferences, and pantry_items
2. THE Supabase RLS SHALL allow a user to insert and update only their own records in steps_log, meals, and dietary_preferences (enforced via user_id = auth.uid() check)
3. THE Supabase RLS SHALL allow both authenticated users to insert, update, and delete records in recipes and pantry_items (shared resources)
4. THE App_Shell SHALL ensure all API calls include a valid JWT token from Supabase Auth, and SHALL reject any operation if the token is missing or expired
5. THE Edge_Function SHALL store the OpenAI API key exclusively in server-side secrets, never exposing it to the client or including it in frontend bundles

### Requirement 12: Realtime Sync and Offline Handling

**User Story:** As a user, I want changes made by my partner to appear instantly, and I want graceful handling when connectivity drops, so that the app feels responsive and reliable.

#### Acceptance Criteria

1. THE PWA SHALL subscribe to Supabase Realtime channels for events, steps_log, meals, recipes, and pantry_items tables upon successful authentication
2. WHEN a realtime subscription delivers a partner's change, THE PWA SHALL update the active view within 2 seconds of receiving the event without requiring user action
3. WHEN the WebSocket connection drops, THE App_Shell SHALL display a visible, non-blocking offline indicator in the navigation bar within 3 seconds of connection loss, and SHALL remove the indicator when the connection is restored
4. WHEN the WebSocket connection is restored, THE PWA SHALL auto-reconnect and refetch the latest data from all subscribed tables to reconcile any changes missed during disconnection
5. IF a health API sync is unavailable due to missing device support or denied permissions, THEN THE Steps_Module SHALL fall back to manual entry and display a message indicating the reason for unavailability and directing the user to enter steps manually
6. IF the WebSocket connection cannot be re-established after 3 retry attempts, THEN THE App_Shell SHALL display a persistent connectivity error message and offer a manual refresh option

### Requirement 13: Design System Compliance

**User Story:** As a user, I want the app to have a consistent, legible visual identity where colour only appears to distinguish ownership (mine, partner's, shared), so that the interface is calm and instantly scannable.

#### Acceptance Criteria

1. THE PWA SHALL implement the Design_System tokens from design-system.html, including dark and light theme variants toggled via a data-theme attribute on the root element
2. THE PWA SHALL render all identity-coloured elements using the oklch function with CSS custom properties (--id-l, --id-c, --id-x-h), never hardcoding colour values
3. THE PWA SHALL offer six hue choices per partner (Slate 250°, Teal 190°, Moss 145°, Brass 85°, Clay 35°, Plum 330°) and SHALL disable any hue within 60° of the other partner's selection to maintain legibility
4. THE PWA SHALL style shared items (events owned by both partners, shared resources) using the neutral graphite colour (var(--ink-2)), not a third identity colour
5. THE PWA SHALL use General Sans as the primary UI font and IBM Plex Mono with tabular-nums for all numeric displays (steps, macros, times)
6. THE PWA SHALL constrain border-radius to 3px, 6px, or 10px; spacing to multiples of 4px; and shadows to a maximum of 0 1px 2px
7. THE PWA SHALL apply no gradients except on the overlap-fill ribbon element, use no emoji in the interface, and render icons as stroked paths at 1.5px weight in a 20px bounding box
8. THE PWA SHALL provide visible focus indicators (2px solid outline, 1px offset) on all interactive elements and honour prefers-reduced-motion by disabling transitions
9. THE PWA SHALL display the Overlap_Ribbon as the primary calendar visualization, showing each partner's busy/sleep blocks on separate tracks with a combined band highlighting mutual free windows using a gradient from identity colour A to identity colour B

### Requirement 14: Input Validation and Error Handling

**User Story:** As a user, I want clear feedback when I enter invalid data, so that I can correct mistakes before they affect my tracking.

#### Acceptance Criteria

1. WHEN a user submits a meal with calories, protein_g, carbs_g, or fats_g exceeding 10,000 for a single entry, THE Food_Module SHALL reject the submission with an inline error message adjacent to each field that failed validation
2. WHEN a user submits a step count outside the range 0–200,000, THE Steps_Module SHALL reject the submission with an inline error message adjacent to the step count field indicating the allowed range
3. WHEN a user attempts to log steps for a future date, THE Steps_Module SHALL reject the submission with an inline error message indicating that the selected date is in the future and cannot be logged
4. THE Supabase database SHALL enforce CHECK constraints requiring calories, protein_g, carbs_g, and fats_g to be greater than or equal to zero, and step_count to be between 0 and 200,000 inclusive
5. IF a concurrent edit conflict is detected on a calendar event via realtime, THEN THE Calendar_Module SHALL display a toast notification indicating another user modified the event, and the toast SHALL remain visible until the user dismisses it or selects the refresh option
6. WHEN any module rejects a submission due to validation failure, THE module SHALL preserve all user-entered form data so the user can correct only the invalid fields and resubmit without re-entering valid data

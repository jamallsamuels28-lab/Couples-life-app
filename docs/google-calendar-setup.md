# Google Calendar sync — setup

Everything in the code is done. What remains is account setup on Google's side
and three secrets on Supabase's side, neither of which can be automated from
here. Budget about half an hour.

You and Rebecca each connect your own Google account. The steps below are done
once by you as the project owner; she then just presses **Connect** in the app.

---

## 1. Create the Google Cloud project

1. Go to <https://console.cloud.google.com/projectcreate>.
2. Name it something recognisable — `couples-life-app` is fine. Create it.
3. With the project selected, open **APIs & Services → Library**, search for
   **Google Calendar API**, and press **Enable**.

## 2. Configure the consent screen

**APIs & Services → OAuth consent screen.**

| Field | Value |
| --- | --- |
| User type | External |
| App name | Couples Life App |
| User support email | your address |
| Developer contact | your address |

On the **Scopes** step, add these two:

```
https://www.googleapis.com/auth/calendar.events
https://www.googleapis.com/auth/userinfo.email
```

On the **Test users** step, add both your Google address and Rebecca's.

> **Leave the app in Testing.** Publishing triggers Google's verification
> review, which for calendar scopes means a security assessment aimed at
> commercial apps. In Testing mode, up to 100 listed test users can connect
> indefinitely. The only cost is that refresh tokens expire after **7 days**,
> so roughly weekly you will both need to press Connect again. Publishing to
> Production removes that expiry but starts the review.

## 3. Create the OAuth client

**APIs & Services → Credentials → Create credentials → OAuth client ID.**

- Application type: **Web application**
- Authorised JavaScript origins:
  - `https://<your-github-username>.github.io`
  - `http://localhost:8000` (for local development)
- Authorised redirect URIs — these must match exactly, trailing slash included:
  - `https://<your-github-username>.github.io/<repo-name>/`
  - `http://localhost:8000/`

Copy the **client ID** and **client secret**.

## 4. Put the client ID in the app

In `js/google-sync.js`:

```js
export const GOOGLE_CLIENT_ID = '1234567890-abcdef.apps.googleusercontent.com';
```

This value is public by design — it identifies the app and authorises nothing
on its own. The secret must never go in this file.

## 5. Set the Edge Function secrets

From the repo root, with the Supabase CLI linked to your project:

```bash
supabase secrets set GOOGLE_CLIENT_ID="<client id>"
supabase secrets set GOOGLE_CLIENT_SECRET="<client secret>"
supabase functions deploy google-calendar-sync
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are
injected automatically — do not set them yourself.

## 6. Run the migrations

```bash
supabase db push
```

Or paste these into the SQL editor in order:

- `supabase/migrations/20250101000004_sleep_rules_shift_patterns.sql`
- `supabase/migrations/20250101000005_google_calendar_sync.sql`

## 7. Connect

Open the app → **Calendar** → **Connected calendars** → **Connect Google
Calendar**. Approve the consent screen. You land back in the app with the
account shown as connected.

---

## How the sync behaves

**Direction.** Events created in the app are pushed to Google. Events in your
Google calendar are pulled in. Pulled events are marked `origin = 'google'` and
are never pushed back — that marker is what stops the two calendars echoing the
same event indefinitely.

**Conflicts.** Last write wins, compared on timestamps. A tie resolves to the
local row, on the grounds that it is the one you both edited here. The pull
runs before the push, so a newer remote edit settles first and the push pass
skips it.

**Deletions.** Deleting in Google deletes locally on the next sync. Deleting
locally does not yet delete in Google — the mapping row is kept so it can be
added without a schema change, but the delete-through is not wired up. Worth
knowing before you rely on it.

**Shift patterns are not pushed.** A rota is a rule, not a list of
appointments; expanding six months of night shifts into individual Google
events would be noisy and would fight the versioning in §1.1b. The free windows
the app calculates from your rota stay in the app.

**Timezones.** Everything crosses the wire as UTC ISO strings and is converted
for display only. Europe/London BST is handled by the browser rather than by
arithmetic here.

**Sync is manual.** Press **Sync now**. There is no background job — adding one
means a scheduled function and a Google `watch` channel, which is a further
piece of work and not worth it until the manual path has proved itself.

---

## When it breaks

**"Google did not return a refresh token."** You have consented before, so
Google skipped issuing a new one. Remove the app at
<https://myaccount.google.com/permissions> and connect again.

**"Google refused to refresh the token."** Usually the 7-day Testing-mode
expiry. Press Connect again.

**`redirect_uri_mismatch` on the consent screen.** The redirect URI in the
Google credential does not match the app URL character for character. The
trailing slash counts.

**Nothing appears after connecting.** Check the function logs:

```bash
supabase functions logs google-calendar-sync
```

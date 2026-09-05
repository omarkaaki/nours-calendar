# Nour’s Calendar

A private, installable calendar for one person — built for a nurse who needs to
track shifts, appointments and notes, and get reminded on her iPhone.

Everything runs on permanently-free tiers: **GitHub Pages** for the site,
**Supabase** for the login and the database.

---

## What it does

- **Month grid + agenda** — shifts as coloured chips, events as dots
- **Shift types** she can rename, recolour and re-time (Morning / Evening / Night / On-call / Off / Leave to start)
- **Repeat tool** — fill a month with "4 on, 4 off", or "every Mon/Wed/Fri", in one go
- **Per-day notes**, ward/unit, and per-day time overrides when she stays late
- **Events** with location, notes, colour and a reminder
- **Monthly tally** — total hours and shift counts, computed automatically
- **iPhone reminders** — two independent paths (see below)
- **Works offline** — opens and edits with no signal, uploads when it's back
- **Installs to the Home Screen** like a real app

## How the privacy works

The site is public; **the data is not**. Every row in the database carries a
`user_id`, and Postgres Row Level Security refuses to return or accept a row
that doesn't belong to whoever's login token made the request.

So even with the source code, the URL and the public anon key, a stranger gets
an empty calendar. There is exactly one account, and public sign-up is turned
off, so nobody else can even make one.

## Why it's fast

- ~23 KB gzipped, total. No framework, no build step, no npm
- No third-party origins at all — the Supabase client is 150 hand-written lines
  in `sb.js` instead of a 120 KB library that fans out into six CDN requests
- CSS is inlined, so nothing blocks the first paint
- The calendar paints from a `localStorage` mirror **before** any network call;
  the server sync happens afterwards and swaps in quietly
- The service worker serves repeat visits from cache and revalidates behind them

---

# Setup

## Part 1 — the site (5 minutes)

1. Create a **public** repo on GitHub (it must be public — GitHub Pages on a
   free account only serves public repos; that's fine, the data isn't in it).
2. Push these files to it.
3. Repo **Settings → Pages → Source: Deploy from a branch → `main` / `(root)`** → Save.
4. Two minutes later it's live at `https://<you>.github.io/<repo>/`.

At this point it already works as a local-only calendar. Keep going to make it
private, synced and able to send reminders.

## Part 2 — the database and her login (10 minutes)

1. Sign up at [supabase.com](https://supabase.com) → **New project**.
   Free plan. Pick the region closest to her (`eu-central` for Lebanon).
   Save the database password somewhere; you won't need it often.
2. **SQL Editor → New query** → paste all of [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
   It creates the tables, switches on Row Level Security and writes the policies.
3. **Authentication → Users → Add user → Create new user**
   - her email + a password you both agree on
   - tick **Auto Confirm User**
4. **Authentication → Sign In / Providers → Email**: turn **Allow new users to sign up** OFF.
   Now hers is the only account that can ever exist.
5. **Project Settings → API**: copy the **Project URL** and the **anon / public** key
   into [`config.js`](config.js):

   ```js
   export const SUPABASE_URL = "https://xxxxxxxxxxxx.supabase.co";
   export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
   export const DEFAULT_TIMEZONE = "Asia/Beirut";
   ```

6. Commit and push. Done — she can now sign in, and everything she types is
   saved to the database and synced to every device she signs in on.

> The anon key is *meant* to be public. It grants nothing on its own; Row Level
> Security is the gate. Never put the **service_role** key in `config.js`.

## Part 3 — iPhone reminders

Two independent paths. **Do Path A** — it's simpler and more reliable. Path B is
a bonus.

### Path A — subscribe iOS Calendar to her feed (recommended)

This gives real, native iOS alerts that work with the web app closed, and it
survives iOS updates.

1. **Edge Functions → Create a new function**, name it exactly `ics`.
2. Paste in [`supabase/functions/ics/index.ts`](supabase/functions/ics/index.ts).
3. **Turn "Verify JWT" OFF** — iOS can't send an auth header on a subscribed
   calendar. The function authenticates with the secret token in the URL instead.
4. Deploy.
5. In the app: **⚙ Settings → Add it to my iPhone Calendar**. That button hands
   iOS a `webcal://` link and iOS offers to subscribe. Manual steps are printed
   underneath if the button doesn't fire.
6. **Important:** after subscribing, iPhone **Settings → Apps → Calendar →
   Calendar Accounts → [the subscription]** and set **Remove Alarms = OFF**,
   otherwise iOS strips the reminders out. Set **Fetch** to every 15 minutes.

Her shifts and events now appear in the normal Calendar app and alert her there.

### Path B — Web Push to the installed app (optional)

Buzzes the app itself. iOS only allows this for apps added to the Home Screen,
on iOS 16.4+.

1. Generate a key pair:
   ```bash
   node tools/gen-vapid.mjs
   ```
2. Put the **public** key in `config.js` as `VAPID_PUBLIC_KEY`, commit, push.
3. **Edge Functions → Create a new function** named `send-reminders`, paste in
   [`supabase/functions/send-reminders/index.ts`](supabase/functions/send-reminders/index.ts),
   **Verify JWT OFF**, deploy.
4. **Edge Functions → Secrets**, add:
   | Name | Value |
   |---|---|
   | `VAPID_PUBLIC_KEY` | the public key |
   | `VAPID_PRIVATE_KEY` | the private key |
   | `VAPID_SUBJECT` | `mailto:you@example.com` |
   | `CRON_SECRET` | any long random string |
5. **SQL Editor**, run this once (fill in your project ref and the same secret):

   ```sql
   create extension if not exists pg_cron;
   create extension if not exists pg_net;

   select cron.schedule('shift-reminders', '* * * * *', $$
     select net.http_post(
       url     := 'https://YOUR_PROJECT_REF.supabase.co/functions/v1/send-reminders',
       headers := jsonb_build_object('Content-Type','application/json',
                                     'x-cron-secret','YOUR_CRON_SECRET')
     );
   $$);
   ```

6. On her iPhone: open the site in Safari → **Share → Add to Home Screen** →
   open it from the Home Screen icon → **⚙ Settings → Push notifications ON**.

To check it later: `select * from cron.job_run_details order by start_time desc limit 10;`

---

## Day-to-day

**Backups.** ⚙ Settings → *Download a backup copy* writes a JSON file with
everything. Supabase also keeps its own daily backups.

**Don't let the project sleep.** Supabase pauses free projects after ~7 days of
no activity. Daily use is plenty; if it ever does pause, un-pause it from the
dashboard and nothing is lost.

**Changing her password:** Supabase dashboard → Authentication → Users → ⋯ → Reset password.

**If she gets a new phone:** she just signs in. Everything is on the server.
Re-do Path A's subscription step on the new phone.

---

## Files

```
index.html    the whole UI, with the CSS inlined
app.js        rendering, sheets, interactions
store.js      data + offline cache + write queue
sb.js         the tiny Supabase client (auth + REST)
config.js     >>> the only file you edit <<<
sw.js         offline caching + push handling
manifest.webmanifest / icons/

supabase/
  schema.sql                     tables, RLS policies, triggers
  functions/ics/                 the iPhone calendar feed
  functions/send-reminders/      the push sender (cron)

tools/
  gen-icons.mjs   regenerate the PNG icons
  gen-vapid.mjs   generate Web Push keys
```

## Local development

```bash
python -m http.server 8125
```

Then open `http://localhost:8125`. With `config.js` empty it runs in local-only
mode against `localStorage`, which is handy for trying UI changes.

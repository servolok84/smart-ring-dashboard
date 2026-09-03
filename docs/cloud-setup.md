# Optional: sync across devices with Supabase

The app works fully offline. Everything is stored in your browser, which means
your history lives in exactly one browser on one device.

If you want it on several devices, you can connect **your own** free Supabase
project. Nothing is shared with the project maintainers — this repo ships with
no database attached, and you own everything you create here.

Roughly five minutes.

## 1. Create a project

Sign up at [supabase.com](https://supabase.com) and create a project. The free
tier is far more than this needs.

## 2. Create the tables

In the dashboard, open **SQL Editor → New query**, paste the whole of
[supabase-schema.sql](supabase-schema.sql), and run it.

That creates four tables and — importantly — turns on **row-level security**
with a policy that limits every row to the account that owns it. Signed-out
callers get nothing at all.

## 3. Turn off public signups

**Authentication → Sign In / Providers → Email.**

While you're there:

- Turn **"Confirm email"** off if you want account creation to be instant. It's
  your own project; there's no one to verify.
- Create your account in the app first (next step), then come back and turn
  **"Allow new users to sign up"** OFF.

That last one matters. The anon key ships in the browser bundle — that's by
design, and it's safe because row-level security stops anyone reading your data
— but while signups are open, a stranger who finds your deployed URL can create
accounts in your project and consume your free-tier quota. Once your account
exists you never need signups again.

## 4. Point the app at your project

**Project Settings → API keys**, copy the **anon / publishable** key (it starts
with `eyJ` or `sb_publishable_`).

> **Never use the `service_role` key.** It bypasses row-level security
> entirely. If it ever leaks, anyone can read and delete everything.

Then, in `web/`:

```bash
cp .env.example .env
```

and fill in:

```
VITE_SUPABASE_URL=https://your-project-ref.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...your-key...
```

Restart `npm run dev`. A **Cloud backup** card now appears under Settings.

If you deploy, set the same two variables as environment variables in your host
(Vercel: Project Settings → Environment Variables) and redeploy. `.env` is
gitignored, so your key never enters the repo.

## 5. Use it

Create your account in the app (Settings → Cloud backup → Create account), then
go turn off signups as described above.

From then on:

- Every ring sync uploads automatically.
- **Signing in syncs both directions** — pulls anything in the cloud, then
  pushes anything local. So signing in on the device that holds your history
  uploads it.
- Actions report counts, e.g. `Cloud in sync — 157 restored, 12 uploaded`, so
  you can tell the difference between "nothing to do" and "nothing happened".

## Is my health data safe?

Within the usual limits of a hobby project:

- **In transit:** HTTPS, always.
- **Between accounts:** row-level security, enforced by Postgres. Verified by
  direct API probing — an unauthenticated caller is refused outright, and an
  authenticated user attempting to read or write another user's rows gets an
  empty result or a `403`.
- **At rest:** encrypted at the disk level by Supabase, but *not*
  end-to-end encrypted. Someone with admin access to your Supabase project can
  read your readings. That's you, and Supabase.

If that last point matters to you, don't enable cloud sync — the app is
perfectly usable without it, and local-only means the data never leaves your
device.

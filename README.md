# Smart Ring Dashboard

Your own app for cheap generic smart rings — **sleep, heart rate, steps, blood
oxygen, HRV** — with no vendor account, no subscription, and no cloud unless
you choose to add one.

Built for the **Anko smart ring** sold by Kmart Australia, which turns out to be
a rebadged generic ring. It also supports the Colmi/Yawell family (R02, R03,
R06, R10 and friends).

The ring talks straight to your browser over Bluetooth. Your data lands in your
own browser storage and stays there unless you connect a database you control.

---

## Does this work with my ring?

| Family | Sold as | Detected service | Status |
|---|---|---|---|
| **Jring / keeprapid "56ff"** | Anko (Kmart AU), Jring, KeepFit, JYouPro | `000056ff-…` | ✅ tested on hardware |
| **Colmi / Yawell RF03** | Colmi R02/R03/R06/R10, rings using the QRing app | `6e40fff0-…` | ✅ implemented from the documented protocol |

The app **detects which protocol your ring speaks** when it connects, so you
don't have to know in advance. If it finds neither, it tells you which services
it did see — open an issue with that line and the ring can likely be added.

### What each family can do

|  | Jring / 56ff (Anko) | Colmi / Yawell |
|---|---|---|
| Heart rate (history + live) | ✅ | ✅ |
| Steps / distance / calories | ✅ daily totals | ✅ per 15 min |
| Sleep stages | light / deep / awake | light / deep / **REM** / awake |
| Blood oxygen | spot measurements | ✅ hourly history |
| HRV, stress, blood pressure | ✅ | ✗ |
| Scheduled background measurement | ✅ | ✅ |

---

## Quick start

You need [Node.js](https://nodejs.org) 20+ and a browser with Web Bluetooth —
**Chrome or Edge** on desktop or Android. (Safari and Firefox don't support it;
see [iPhone](#iphone) below.)

```bash
git clone https://github.com/YOUR-USERNAME/smart-ring-dashboard.git
cd smart-ring-dashboard/web
npm install
npm run dev
```

Open <http://localhost:5173>. No hardware yet? Click **Demo mode** — it
simulates a ring so you can see the whole app working.

### Connecting your ring for the first time

This is the fiddly part. The ring only accepts a connection **while it is
actively advertising**, which it stops doing within seconds to save battery.

1. **Close the vendor app** on your phone, and turn the phone's Bluetooth
   **off**. A ring already connected to your phone is invisible to everything
   else — this is the single most common reason it won't connect.
2. Touch the ring to its charger for a second or two, then take it off. It now
   advertises for a short window.
3. Click **Connect ring** and pick it from the list. It'll be named something
   like `Anko12345678`, `R02_xxxx` or `COLMI…`.
4. If it doesn't connect immediately, **touch it to the charger again while the
   app retries** — the app keeps trying for about 30 seconds and will latch on
   the moment the ring wakes.

Then hit **Sync now**.

More failure modes and fixes: **[docs/troubleshooting.md](docs/troubleshooting.md)**.

---

## What you get

**Today** — Readiness, Sleep and Activity scores, each showing the contributors
behind it, then a card per metric with the day's detail and charts.

**Trends** — a weekly summary in plain language ("your shortest and longest
nights differed by 1h 22m"), plus 30-day charts.

**Settings** — scheduled measurements, optional cloud backup, JSON export, and
a live packet log showing every Bluetooth frame in hex.

### About the scores

The three scores are **transparent heuristics computed on your device**, written
out in [`web/src/scores.ts`](web/src/scores.ts) so any number can be traced back
to why. They are **not** Oura's algorithms, they are not validated against
sleep-lab data, and they are **not medical measurements**.

Wherever a judgement can be made against *your own* baseline it is. Absolute
reference bands appear only for sleep duration and efficiency, where general
sleep science gives a defensible range. A contributor with no data behind it
drops out rather than counting against you, and each score reports how much of
its usual input it actually had.

---

## Optional: sync across devices

By default everything is local to one browser. If you want your history on more
than one device, you can connect **your own** free Supabase project — the app
ships with no database attached.

See **[docs/cloud-setup.md](docs/cloud-setup.md)**. It takes about five minutes,
and the schema ([docs/supabase-schema.sql](docs/supabase-schema.sql)) sets up
row-level security so each account can only ever read its own rows.

## Optional: deploy it

The app is a static site, so any free host works — Vercel, Netlify, Cloudflare
Pages, GitHub Pages. Web Bluetooth requires **HTTPS**, which all of those give
you.

For Vercel, [`vercel.json`](vercel.json) is already set up: point the project at
this repo, and add your two `VITE_SUPABASE_*` values as environment variables if
you're using the cloud option. It also sets a strict Content-Security-Policy and
other security headers.

### iPhone

iOS has no Web Bluetooth in any browser, including Safari — Apple doesn't allow
it. To sync from an iPhone, use **[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)**,
a free browser that implements it. Open your deployed URL there and it works
normally.

You can also "Add to Home Screen" from Safari for the app icon, but that copy
runs on Safari's engine and **cannot** talk to the ring — it can only view data
that cloud sync brought in.

---

## How it works

The rings use **no pairing, no bonding and no encryption**. Anyone within
Bluetooth range can read them. That's the hardware's design, not this app's
choice, and it's what makes this project possible at all.

The wire protocols for both ring families are documented in
**[docs/protocol.md](docs/protocol.md)** — GATT services, packet layouts,
command bytes, and the quirks that matter (the Jring's 20-second idle timeout,
its local-wall-clock RTC, the bind handshake). That document is useful on its
own if you're writing your own client in another language.

```
web/src/ble/        protocol parsing + Web Bluetooth clients (one per family)
web/src/scores.ts   the scoring heuristics, fully commented
web/src/insights.ts weekly summaries and trends
web/src/cloud/      optional Supabase sync
docs/               protocol reference, setup guides, troubleshooting
```

### Credit

The protocol work stands on reverse engineering done by others:

- [tahnok/colmi_r02_client](https://github.com/tahnok/colmi_r02_client) — Colmi R02 Python client and lab notes
- [Gadgetbridge](https://codeberg.org/Freeyourgadget/Gadgetbridge) — Yawell/Colmi driver
- [PulseLoop](https://github.com/saksham2001/PulseLoopiOS) and [Saksham Bhutani's teardown](https://sakshambhutani.xyz/hacking/2_hacking/) — the Jring/56ff protocol
- [colmi.puxtril.com](https://colmi.puxtril.com/) — command reference

## Contributing

Ring variants are the most useful contribution: if yours isn't detected, open an
issue with the "Services:" line from the packet log. See
[CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

[MIT](LICENSE).

## Disclaimer

This is a hobby project for personal interest. It is not a medical device, and
nothing it displays should be used to diagnose, treat, or make decisions about
a health condition. The sensors in a $20 ring are not clinical instruments.

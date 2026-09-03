# Troubleshooting

Most problems are the ring being asleep or held by another app. These are the
failure modes we actually hit, and what fixed them.

## The ring doesn't appear in the chooser

The chooser only lists rings that are **advertising right now**, and a ring
stops advertising within seconds to save battery.

1. **Turn your phone's Bluetooth off.** A ring already connected to the vendor
   app is invisible to everything else. Force-closing the app is often not
   enough — the connection can linger.
2. Touch the ring to its charger for 1–2 seconds, then remove it.
3. Click **Connect ring** within the next ~30 seconds.

Still nothing? Open `chrome://bluetooth-internals/#devices`, click **Start
Scan**, and wake the ring. If it appears there, note the name and open an issue
— the app filters the chooser by name prefix, and yours may need adding.

## "Unsupported device." / NetworkError on connect

Chrome's unhelpful wording for *the GATT connection attempt failed*. Almost
always the ring stopped advertising between you picking it and the connection
starting.

The app retries for about 30 seconds. **Touch the ring to its charger while it
retries** — it will latch on the moment the ring wakes.

If it exhausts all attempts: phone Bluetooth off (see above), and check
**System Settings → Bluetooth** on macOS for a stale pairing to forget. These
rings don't need OS-level pairing at all; if macOS has grabbed one it can hold
the connection and block the browser.

Failing that, quit the browser entirely and reopen — its Bluetooth cache
occasionally wedges.

## "Doesn't expose a known ring service"

You connected to something that isn't a supported ring — either a different
device entirely, or a ring family not yet implemented.

The error names the services it found. Open an issue with that line. If it
shows `56FF` or `6E40FFF0` and still failed, that's a bug worth reporting.

## It connects but no data appears

- **Hit Sync now.** Connecting alone doesn't pull history.
- **Heart-rate history needs the ring's background logging enabled.** The app
  turns it on during sync (Settings → Automatic measurements), but the ring
  only records *from that point on* — it can't backfill. Wear it overnight and
  sync in the morning.
- Rings only store a few days of history. Sync regularly or you'll lose it.
- **Blood oxygen on the Jring/Anko family has no on-ring history.** Readings
  come from spot measurements, which the app takes on a schedule while it's
  connected, or on demand via Settings → Live measurement.

## iPhone can't connect

iOS has no Web Bluetooth in any browser, Safari included — it's an Apple
platform restriction, not a bug here.

Use **[Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055)**,
a free browser that implements Web Bluetooth. Open your deployed URL in it.

Note that a "Add to Home Screen" copy from Safari runs on Safari's engine and
**cannot** reach the ring — it can only display data that cloud sync brought in.
The two also have separate storage.

### Bluefy shows short UUIDs

Handled. Bluefy reports 16-bit UUIDs as `56FF` where Chrome reports the full
128-bit form; the app normalises both. If you're writing your own client, this
one costs an afternoon to find.

## The app shows an old version after an update

The service worker caches the app. It checks for updates every minute and shows
a **"A new version of the app is ready"** banner — click Reload.

To force it: hard-reload (`Cmd/Ctrl+Shift+R`), or on a phone close the app
completely and reopen it.

## The dashboard is empty even though I synced

If the app is open in **two places at once** (a desktop tab and an installed
app, say) a database schema upgrade can be blocked by the other copy. The app
now handles this, but if you're on an old build: close every copy, then open
one.

Check **Settings → Export data**. If the export contains your readings, the
data is there and it's a display problem worth reporting.

## Cloud sync restored nothing

- Confirm you're signed in with the **same account** on both devices.
- Cloud actions report counts (`Backed up 157 records`). If a device says
  *"Nothing to back up yet"*, that device holds no local data — the data is in
  a different browser or profile.
- Signing in syncs **both** directions, so signing in on the device that holds
  your history will upload it.
- Storage is per-browser and per-origin: `localhost` and your deployed URL are
  separate stores, and so are Safari and Bluefy on iOS.

## Everything is broken and I want to start over

**Settings → Clear local data** wipes this browser's copy. If you use cloud
sync, your data is still in your database and signing in will pull it back.

Export first if you're unsure — it's a one-click JSON download.

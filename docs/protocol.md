# Smart ring BLE protocols

The app auto-detects the ring's protocol from its GATT services
(`web/src/ble/connect.ts`):

- **Jring/keeprapid "56ff"** (service `000056ff-…`) — **the Anko ring** (Kmart)
  is this family. See the second half of this document.
- **Colmi/Yawell RF03** (service `6e40fff0-…`) — QRing-app rings, documented
  first below.

---

# Part 1 — Colmi/Yawell RF03 family

Generic rings with the BlueX RF03 SoC and the QRing companion app. The protocol
below was reverse engineered by the community and is implemented in
`web/src/ble/protocol.ts`.

Sources:

- <https://github.com/tahnok/colmi_r02_client> — Python client + lab notes
- Gadgetbridge `YawellRingDeviceSupport` / `YawellRingPacketHandler` (Codeberg)
- <https://colmi.puxtril.com/> — command reference

There is **no pairing, bonding, or encryption**. Anyone in BLE range can read
the ring's data.

## GATT layout

| Purpose | UUID |
|---|---|
| Service V1 (UART-style) | `6e40fff0-b5a3-f393-e0a9-e50e24dcca9e` |
| V1 write (commands) | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` |
| V1 notify (responses) | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` |
| Service V2 ("big data") | `de5bf728-d711-4e47-af26-65e3012a5dc7` |
| V2 write (commands) | `de5bf72a-d711-4e47-af26-65e3012a5dc7` |
| V2 notify (responses) | `de5bf729-d711-4e47-af26-65e3012a5dc7` |

## V1 packets — fixed 16 bytes

```
byte 0      command id
bytes 1–14  payload
byte 15     checksum = sum(bytes 0–14) & 0xFF
```

Responses echo the command id in byte 0. Multi-packet responses stream as
several notifications with the same command id.

### Commands used by this app

| Cmd | Meaning | Request payload | Response |
|---|---|---|---|
| `0x01` | Set time | BCD `yy mm dd hh mm ss` + `01` (lang EN) | capability flags (ignorable) |
| `0x03` | Battery | – | `[1]` level %, `[2]` charging |
| `0x15` | HR log for a day | u32 LE epoch seconds of **local midnight expressed as UTC** | multi-packet, see below |
| `0x16` | Auto-HR-log pref | read: `01`; write: `02, enabled(1/2), interval_min` | `[2]` enabled (1=on 2=off), `[3]` interval |
| `0x43` | Activity/steps log | `dayOffset, 0x0f, 0x00, 0x5f, 0x01` (0 = today) | multi-packet, see below |
| `0x69` | Real-time reading | `kind, action` (action 1=start 3=continue) | `[1]` kind, `[2]` error, `[3]` value |
| `0x6a` | Stop real-time | `kind, 0, 0` | – |

Real-time `kind`: 1 = heart rate, 3 = SpO2 (2=BP, 4=fatigue… exist but are
dubious on this hardware). Send *continue* every few seconds or the sensor
stops. Readings stream on `0x69` notifications; value `0` = still measuring.

### HR log response (`0x15`)

Byte 1 is a sub-type:

- `0xff` — no data for that day
- `0x00` — header: `[2]` = number of packets to follow, `[3]` = sample interval (minutes)
- `0x01` — `[2..5]` u32 LE UTC timestamp of the day, `[6..14]` first 9 samples
- `n` — 13 more samples in `[2..14]`; day is complete when `n == count-1`

A day is 288 samples at 5-minute intervals; `0` = no reading in that slot.

### Activity log response (`0x43`)

- First packet may be a header: `[1] == 0xf0`; `[3] == 1` means calories are ×10
- `[1] == 0xff` — no data
- Data packets: `[1..3]` BCD year/month/day, `[4]` time index (15-min slots,
  0–95), `[5]` packet index, `[6]` packet count, `[7..8]` u16 LE calories
  (small cal), `[9..10]` u16 LE steps, `[11..12]` u16 LE distance in meters.

## V2 "big data" packets — variable length

```
byte 0     0xBC
byte 1     sub-type (0x27 sleep, 0x2a SpO2)
bytes 2–3  payload length, u16 LE
bytes 4–5  CRC16/MODBUS of payload, u16 LE
bytes 6+   payload
```

Responses can span several notifications: concatenate until you have
`length + 6` bytes. Request payload for both history fetches is a single
`0xff` byte (the checksum bytes are then `ff 00`).

### Sleep response (`0x27`)

Payload: `[6]` = number of days, then per day:

```
daysAgo, dayBytes, sleepStart u16 LE, sleepEnd u16 LE, (stage, minutes)…
```

`sleepStart`/`sleepEnd` are minutes after midnight of that day; if
`start > end` the session began the previous evening (subtract 1440).
`(dayBytes - 4) / 2` stage pairs follow. Stage codes: 2 = light, 3 = deep,
4 = REM, 5 = awake.

### SpO2 response (`0x2a`)

Payload repeats per day until `daysAgo == 0`:

```
daysAgo, then 24 × (min, max)   — one pair per hour, 0 = no reading
```

## Notes for implementers

- The ring's clock must be set (`0x01`) or history timestamps drift.
- Enable periodic HR logging (`0x16`) or the HR history stays empty.
- Older firmwares lack the V2 service — sleep/SpO2 history is unavailable there.
- Web Bluetooth: Chrome/Edge only, HTTPS or localhost; the ring may not
  advertise its service UUID, so request with `acceptAllDevices` +
  `optionalServices`.

---

# Part 2 — Jring/keeprapid "56ff" family (the Anko ring)

The Anko smart ring is a white-label of the keeprapid (ShenXinRui) OEM ring —
sold as Jring, KeepFit, JYouPro, RWfit and others. SoC: Renesas DA14531.
Implemented in `web/src/ble/jring.ts`.

Protocol reverse engineered by:

- <https://github.com/saksham2001/PulseLoopiOS> (`RingProtocol.swift` — full driver)
- <https://sakshambhutani.xyz/hacking/2_hacking/> — the original teardown

## GATT layout

| Purpose | UUID |
|---|---|
| Main service | `000056ff-0000-1000-8000-00805f9b34fb` |
| Write (commands) | `000033f3-…` |
| Notify (responses) | `000033f4-…` |
| Battery | standard `0x180F` / `0x2A19` |
| Secondary service | `000057ff-…` (purpose unknown) |

## Framing

Fixed **20-byte** frames, no checksum, no encryption. Byte 0 = command id,
rest is payload + zero padding. Multi-byte integers are little-endian.

**Quirks that matter:**

- The ring drops the link after ~20 s idle — send a `0x3A` keepalive on a timer.
- The ring's RTC holds **local wall-clock** epoch seconds (`utc + tz offset`).
  Every ring-stamped history timestamp must have the same offset subtracted.
- The ring runs a `0x4B` bind handshake: reply INIT(0)→APP_START(1),
  ACK(2)→SUCCESS(4). Send action 5 (UNBOND) to release it.
- Claim the ring with `0x48` + ASCII app id on connect, or it may stay mute
  after another app has used it.
- `0x19` (auto heart-rate schedule) must be sent or the ring records almost no
  background data: `19 startHH startMM endHH endMM enable cadenceMin 01`.

## Commands used by this app

| Cmd | Meaning | Notes |
|---|---|---|
| `0x01` | Time sync | `[1..4]` u32 LE local-wall-clock epoch, `[5]` offset hours |
| `0x02` | User profile | `[1]=(age&0x7F)\|(male?0x80)`, `[2]` height cm, `[3]` weight kg |
| `0x03` | Current activity | reply: `[1..4]` ts, `[5..8]` steps, `[9..12]` distance m, `[13..16]` calories (all u32 LE, cumulative today) |
| `0x0b` | Battery percent notify | `[1]` = % |
| `0x0c` | Status | firmware + MAC embedded |
| `0x10` | History query | triggers a stream of `0x11` sleep frames |
| `0x11` | Sleep timeline frame | `[1..4]` ts, `[5..19]` = 15 one-minute stage bytes: `0x28` light, `0x63` deep, `0x00` awake (no REM on this hardware) |
| `0x14` | Live HR start | `14 b4` (180 s window); samples arrive as `0x14` frames, bpm at `[5]` |
| `0x15` | Live HR stop | |
| `0x16` | Measurement history | sub `0xF0` header, `0xA0` data (`[2..5]` ts, 12 one-minute HR samples at `[8..19]`), `0xFF` end |
| `0x19` | Auto-HR schedule | see quirks |
| `0x20` | Capability bitmask | |
| `0x23` | Spot measurement | `[1]` mode: 1 = blood pressure, 2 = SpO2, 3 = blood sugar, 4 = stress; 0 = off |
| `0x24` | Combined result | `[1]` HR, `[2]` sys, `[3]` dia, `[4]` SpO2, `[5]` fatigue, `[6]` stress, `[7]` sugar (mmol/L×10), `[8]` HRV ms |
| `0x27` | HR measurement complete | |
| `0x3a` | Keepalive | |
| `0x3f` | SpO2 result | `[1]` = % |
| `0x48` | App identifier | up to 18 ASCII bytes |
| `0x4b` | Bind handshake | see quirks |

## Capabilities vs the Colmi family

- Sleep stages: light/deep/awake only — **no REM**.
- No on-ring SpO2 hourly history (spot + live measurements only).
- Steps: cumulative daily totals only (no 15-minute buckets, no past days).
- Extras this family has: blood pressure, stress, fatigue, HRV, profile-derived
  blood-sugar estimate (all via `0x23`/`0x24`).

/**
 * Driver for "Jring"/56ff-protocol rings (keeprapid OEM — Anko, Jring, KeepFit,
 * JYouPro and other white-labels). Renesas DA14531 SoC.
 *
 * Protocol reverse engineered by the PulseLoop project
 * (https://github.com/saksham2001/PulseLoopiOS) and
 * https://sakshambhutani.xyz/hacking/2_hacking/
 *
 * Fixed 20-byte cleartext frames, no checksum. The ring's RTC stores LOCAL
 * wall-clock epoch seconds (utc + tz offset), and it drops the link after ~20s
 * idle unless we ping it (0x3A).
 */

import type {
  ActivityBucket,
  BatteryInfo,
  LogEntry,
  RealtimeKind,
  SleepPhase,
  SleepSession,
  SleepStage,
  Spo2Hour,
  VitalSample,
} from "../types";
import { hex, localDateKey } from "./protocol";
import type { HeartRateLogResult } from "./protocol";
import type { RingEvents, RingLike } from "./ring";

export const JRING_SERVICE = "000056ff-0000-1000-8000-00805f9b34fb";
export const JRING_WRITE = "000033f3-0000-1000-8000-00805f9b34fb";
export const JRING_NOTIFY = "000033f4-0000-1000-8000-00805f9b34fb";
export const BATTERY_SERVICE = "0000180f-0000-1000-8000-00805f9b34fb";
export const BATTERY_CHAR = "00002a19-0000-1000-8000-00805f9b34fb";

const JCMD = {
  TIME_SYNC: 0x01,
  USER_INFO: 0x02,
  CURRENT_ACTIVITY: 0x03,
  BATTERY_PCT: 0x0b,
  STATUS: 0x0c,
  HISTORY_QUERY: 0x10,
  SLEEP_TIMELINE: 0x11,
  HR_START: 0x14,
  HR_STOP: 0x15,
  HISTORY_MEASUREMENT: 0x16,
  AUTO_HR: 0x19,
  LOCALE: 0x21,
  COMBINED_START_STOP: 0x23,
  COMBINED_RESULT: 0x24,
  HR_COMPLETE: 0x27,
  KEEPALIVE: 0x3a,
  SPO2_RESULT: 0x3f,
  APP_ID: 0x48,
  BIND: 0x4b,
} as const;

function frame(bytes: number[]): Uint8Array {
  const out = new Uint8Array(20);
  out.set(bytes.slice(0, 20));
  return out;
}

function u32le(b: Uint8Array, offset: number): number {
  return (b[offset] | (b[offset + 1] << 8) | (b[offset + 2] << 16) | (b[offset + 3] << 24)) >>> 0;
}

/** Sleep stage byte → stage. 0x28 light, 0x63 deep, 0x00 awake (per PulseLoop). */
function stageFor(byte: number): SleepStage {
  if (byte === 0x63) return "deep";
  if (byte === 0x00) return "awake";
  return "light";
}

interface HistoryData {
  /** minute-timestamp (ms) → bpm */
  minuteHr: Map<number, number>;
  /** minute-timestamp (ms) → stage */
  sleepMinutes: Map<number, SleepStage>;
}

export class JringClient implements RingLike {
  private device: BluetoothDevice | null = null;
  private gatt: BluetoothRemoteGATTServer | null = null;
  private writeChar: BluetoothRemoteGATTCharacteristic | null = null;
  private batteryChar: BluetoothRemoteGATTCharacteristic | null = null;
  private events: RingEvents;

  /** Ring RTC offset from UTC in seconds — latched when we send 0x01. */
  private clockOffsetSec = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private realtimeKind: RealtimeKind | null = null;

  private history: HistoryData | null = null;
  private historyPromise: Promise<HistoryData> | null = null;
  private historyCollector: HistoryData | null = null;
  private historyQuietTimer: ReturnType<typeof setTimeout> | null = null;
  private historyResolve: (() => void) | null = null;

  /** Cumulative today activity from 0x03 frames. */
  private latestActivity: { ts: number; steps: number; distanceM: number; calories: number } | null =
    null;
  private activityWaiter: (() => void) | null = null;

  /** Spot SpO2 readings observed this session (ts → value). */
  private spo2Spots: { ts: number; value: number }[] = [];
  /** HRV / stress / blood-pressure spot readings observed this session. */
  private vitalSpots: VitalSample[] = [];
  private latestBattery: BatteryInfo | null = null;

  constructor(events: RingEvents = {}) {
    this.events = events;
  }

  get name(): string {
    return this.device?.name ?? "ring";
  }

  get connected(): boolean {
    return this.gatt?.connected ?? false;
  }

  private log(dir: LogEntry["dir"], text: string): void {
    this.events.onLog?.({ ts: Date.now(), dir, text });
  }

  /** Attach to an already-connected GATT server (see connectRing factory). */
  async attach(device: BluetoothDevice, gatt: BluetoothRemoteGATTServer): Promise<void> {
    this.device = device;
    this.gatt = gatt;
    device.addEventListener("gattserverdisconnected", () => {
      this.log("info", "Ring disconnected");
      this.teardown();
      this.events.onDisconnect?.();
    });

    // Some Web Bluetooth implementations (Bluefy on iOS) are picky about UUID
    // form — try the canonical 128-bit string, fall back to the 16-bit alias.
    const getService = async (full: string, short: number) => {
      try {
        return await gatt.getPrimaryService(full);
      } catch {
        return await gatt.getPrimaryService(short);
      }
    };
    const getChar = async (
      service: BluetoothRemoteGATTService,
      full: string,
      short: number,
    ) => {
      try {
        return await service.getCharacteristic(full);
      } catch {
        return await service.getCharacteristic(short);
      }
    };

    const service = await getService(JRING_SERVICE, 0x56ff);
    this.writeChar = await getChar(service, JRING_WRITE, 0x33f3);
    const notify = await getChar(service, JRING_NOTIFY, 0x33f4);
    await notify.startNotifications();
    notify.addEventListener("characteristicvaluechanged", (e) => {
      const dv = (e.target as BluetoothRemoteGATTCharacteristic).value!;
      this.handleFrame(new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength));
    });

    try {
      const batteryService = await getService(BATTERY_SERVICE, 0x180f);
      this.batteryChar = await getChar(batteryService, BATTERY_CHAR, 0x2a19);
    } catch {
      this.batteryChar = null;
    }

    // Startup sequence mirroring the vendor app (via PulseLoop): claim the
    // ring, push a profile, sync clock, arm background HR logging.
    await this.write(this.appIdFrame());
    await this.write(frame([JCMD.USER_INFO, 30 | 0x80, 175, 75, 0x00])); // neutral profile
    await this.write(frame([JCMD.STATUS]));
    await this.sendTimeSync();
    await this.write(frame([JCMD.LOCALE, 0x65, 0x6e, 0x2d, 0x55, 0x53])); // "en-US"

    // Keepalive defeats the ring's ~20s idle disconnect.
    this.keepaliveTimer = setInterval(() => {
      this.write(frame([JCMD.KEEPALIVE])).catch(() => {});
    }, 10_000);

    this.log("info", `Connected to ${this.name} (Jring/56ff protocol)`);
  }

  private teardown(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
    this.realtimeKind = null;
  }

  disconnect(): void {
    this.teardown();
    this.gatt?.disconnect();
  }

  private appIdFrame(): Uint8Array {
    const bytes: number[] = [JCMD.APP_ID];
    for (const ch of "SmartRing") bytes.push(ch.charCodeAt(0));
    return frame(bytes);
  }

  private async write(packet: Uint8Array): Promise<void> {
    if (!this.writeChar) throw new Error("not connected");
    this.log("tx", hex(packet));
    // Serialized with-response writes, matching the vendor app's queue.
    await this.writeChar.writeValueWithResponse(packet.buffer as ArrayBuffer);
  }

  /** Ring-stamped local wall-clock epoch (seconds) → epoch millis. */
  private ringDate(raw: number): number {
    return (raw - this.clockOffsetSec) * 1000;
  }

  // ------------------------------------------------------------ inbound

  private handleFrame(value: Uint8Array): void {
    this.log("rx", hex(value));
    if (value.length < 20) return;
    const cmd = value[0];
    switch (cmd) {
      case JCMD.CURRENT_ACTIVITY: {
        this.latestActivity = {
          ts: this.ringDate(u32le(value, 1)),
          steps: u32le(value, 5),
          distanceM: u32le(value, 9),
          calories: u32le(value, 13),
        };
        this.activityWaiter?.();
        break;
      }
      case JCMD.BATTERY_PCT:
        this.latestBattery = { level: value[1], charging: false };
        break;
      case JCMD.SLEEP_TIMELINE: {
        const base = this.ringDate(u32le(value, 1));
        const target = this.historyCollector ?? this.ensureHistoryStore();
        for (let i = 0; i < 15; i++) {
          target.sleepMinutes.set(base + i * 60_000, stageFor(value[5 + i]));
        }
        this.bumpHistoryQuiet();
        break;
      }
      case JCMD.HISTORY_MEASUREMENT: {
        const subType = value[1];
        if (subType === 0xa0) {
          // 12 one-minute HR samples: base ts at [2..5], samples at [8..19]
          const base = this.ringDate(u32le(value, 2));
          const target = this.historyCollector ?? this.ensureHistoryStore();
          for (let i = 0; i < 12; i++) {
            const bpm = value[8 + i];
            if (bpm > 0) target.minuteHr.set(base + i * 60_000, bpm);
          }
          this.bumpHistoryQuiet();
        } else if (subType === 0xff) {
          this.finishHistory();
        } else {
          this.bumpHistoryQuiet();
        }
        break;
      }
      case JCMD.HR_START: {
        // Live HR sample: bpm at [5]
        const bpm = value[5];
        if (bpm > 0 && this.realtimeKind === "heartRate") {
          this.events.onRealtimeReading?.("heartRate", bpm);
        }
        break;
      }
      case JCMD.COMBINED_RESULT: {
        // One PPG sweep reports several vitals at once:
        // [1]=HR [2]=systolic [3]=diastolic [4]=SpO2 [5]=fatigue [6]=stress [7]=sugar [8]=HRV
        const ts = Date.now();
        const spo2 = value[4];
        if (spo2 >= 80 && spo2 <= 100) {
          this.spo2Spots.push({ ts, value: spo2 });
          if (this.realtimeKind === "spo2") this.events.onRealtimeReading?.("spo2", spo2);
        }
        const bpm = value[1];
        if (bpm > 0 && this.realtimeKind === "heartRate") {
          this.events.onRealtimeReading?.("heartRate", bpm);
        }
        const sample: VitalSample = { ts };
        if (value[8] > 0) sample.hrv = value[8];
        if (value[6] > 0) sample.stress = value[6];
        if (value[5] > 0) sample.fatigue = value[5];
        if (value[2] > 0 && value[3] > 0) {
          sample.systolic = value[2];
          sample.diastolic = value[3];
        }
        if (Object.keys(sample).length > 1) {
          this.vitalSpots.push(sample);
          this.log(
            "info",
            `Vitals: ${sample.hrv ? `HRV ${sample.hrv}ms ` : ""}${sample.stress ? `stress ${sample.stress} ` : ""}${sample.systolic ? `BP ${sample.systolic}/${sample.diastolic}` : ""}`.trim(),
          );
        }
        break;
      }
      case JCMD.SPO2_RESULT: {
        const spo2 = value[1];
        if (spo2 >= 80 && spo2 <= 100) {
          this.spo2Spots.push({ ts: Date.now(), value: spo2 });
          if (this.realtimeKind === "spo2") this.events.onRealtimeReading?.("spo2", spo2);
        }
        break;
      }
      case JCMD.BIND: {
        // Ring-driven bind handshake: INIT(0) → APP_START(1); ACK(2) → SUCCESS(4)
        const action = value[1];
        if (action === 0) this.write(frame([JCMD.BIND, 1, 0, 1])).catch(() => {});
        else if (action === 2) this.write(frame([JCMD.BIND, 4, 0, 1])).catch(() => {});
        break;
      }
      default:
        break;
    }
  }

  // ------------------------------------------------------------ API

  async setTime(): Promise<void> {
    await this.sendTimeSync();
    this.log("info", "Ring clock synced (local wall-clock epoch)");
  }

  private async sendTimeSync(): Promise<void> {
    const now = new Date();
    // The ring's RTC runs on local wall-clock time.
    this.clockOffsetSec = -now.getTimezoneOffset() * 60;
    const ts = Math.floor(now.getTime() / 1000) + this.clockOffsetSec;
    await this.write(
      frame([
        JCMD.TIME_SYNC,
        ts & 0xff,
        (ts >>> 8) & 0xff,
        (ts >>> 16) & 0xff,
        (ts >>> 24) & 0xff,
        Math.trunc(this.clockOffsetSec / 3600) & 0xff,
      ]),
    );
  }

  async getBattery(): Promise<BatteryInfo> {
    if (this.batteryChar) {
      try {
        const dv = await this.batteryChar.readValue();
        return { level: dv.getUint8(0), charging: false };
      } catch {
        // fall through to notify-based value
      }
    }
    if (this.latestBattery) return this.latestBattery;
    return { level: 0, charging: false };
  }

  /** Arm the ring's automatic background HR logging (0x19). */
  async ensureHrLogging(intervalMinutes = 15): Promise<void> {
    await this.write(
      frame([JCMD.AUTO_HR, 0x00, 0x00, 0x17, 0x3b, 0x01, Math.max(1, intervalMinutes), 0x01]),
    );
    this.log("info", `Background HR logging armed at ${intervalMinutes} minute cadence`);
  }

  /**
   * On-ring background SpO2 (0x3e). Only honored by firmware with the
   * "separate blood-oxygen mode" capability — harmless no-op otherwise.
   */
  async setAutoSpo2(enabled: boolean): Promise<void> {
    await this.write(frame([0x3e, enabled ? 1 : 0]));
    this.log("info", `Background SpO2 request sent (${enabled ? "on" : "off"}) — firmware support varies`);
  }

  /** Jring reports cumulative today totals only (no intraday buckets). */
  async getActivity(dayOffset: number): Promise<ActivityBucket[]> {
    if (dayOffset !== 0) return [];
    // Query current activity; the ring also pushes 0x03 on its own.
    const waited = new Promise<void>((resolve) => {
      this.activityWaiter = resolve;
      setTimeout(resolve, 4000);
    });
    await this.write(frame([JCMD.CURRENT_ACTIVITY]));
    await waited;
    this.activityWaiter = null;
    const a = this.latestActivity;
    if (!a || a.steps === 0) return [];
    const now = new Date();
    return [
      {
        date: localDateKey(now),
        timeIndex: Math.min(95, Math.floor((now.getHours() * 60 + now.getMinutes()) / 15)),
        steps: a.steps,
        calories: Math.round(a.calories),
        distanceM: a.distanceM,
      },
    ];
  }

  // ------------------------------------------------------------ history sync (0x10 + 0x16)

  private ensureHistoryStore(): HistoryData {
    this.history ??= { minuteHr: new Map(), sleepMinutes: new Map() };
    return this.history;
  }

  private bumpHistoryQuiet(): void {
    if (!this.historyResolve) return;
    if (this.historyQuietTimer) clearTimeout(this.historyQuietTimer);
    this.historyQuietTimer = setTimeout(() => this.finishHistory(), 3000);
  }

  private finishHistory(): void {
    if (this.historyQuietTimer) clearTimeout(this.historyQuietTimer);
    this.historyQuietTimer = null;
    this.historyResolve?.();
    this.historyResolve = null;
  }

  /** Run the history sync once per session; sleep + HR share the same stream. */
  private collectHistory(): Promise<HistoryData> {
    this.historyPromise ??= (async () => {
      const collector = this.ensureHistoryStore();
      this.historyCollector = collector;
      const done = new Promise<void>((resolve) => {
        this.historyResolve = resolve;
        // Hard cap even if the ring keeps chattering
        setTimeout(resolve, 30_000);
      });
      this.log("info", "Requesting sleep + measurement history…");
      await this.write(frame([JCMD.HISTORY_QUERY]));
      await this.write(frame([JCMD.HISTORY_MEASUREMENT]));
      this.bumpHistoryQuiet();
      await done;
      this.historyCollector = null;
      this.log(
        "info",
        `History sync done: ${collector.minuteHr.size} HR minutes, ${collector.sleepMinutes.size} sleep minutes`,
      );
      return collector;
    })();
    return this.historyPromise;
  }

  async getHeartRateLog(date: Date): Promise<HeartRateLogResult | null> {
    const history = await this.collectHistory();
    const dayStart = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
    const samples = new Array(288).fill(0);
    const sums = new Array(288).fill(0);
    const counts = new Array(288).fill(0);
    let any = false;
    for (const [ts, bpm] of history.minuteHr) {
      if (ts < dayStart || ts >= dayStart + 86_400_000) continue;
      const slot = Math.floor((ts - dayStart) / 300_000);
      sums[slot] += bpm;
      counts[slot]++;
      any = true;
    }
    if (!any) return null;
    for (let i = 0; i < 288; i++) {
      if (counts[i] > 0) samples[i] = Math.round(sums[i] / counts[i]);
    }
    return { timestamp: dayStart, intervalMinutes: 5, samples };
  }

  async getSleep(): Promise<SleepSession[]> {
    const history = await this.collectHistory();
    const minutes = [...history.sleepMinutes.entries()].sort((a, b) => a[0] - b[0]);
    if (minutes.length === 0) return [];

    const sessions: SleepSession[] = [];
    let current: { start: number; entries: [number, SleepStage][] } | null = null;
    for (const [ts, stage] of minutes) {
      if (!current || ts - current.entries[current.entries.length - 1][0] > 60 * 60_000) {
        if (current) sessions.push(this.buildSession(current.entries));
        current = { start: ts, entries: [] };
      }
      current.entries.push([ts, stage]);
    }
    if (current) sessions.push(this.buildSession(current.entries));
    // Ignore fragments shorter than an hour — they're naps/noise
    return sessions.filter((s) => s.end - s.start >= 60 * 60_000);
  }

  private buildSession(entries: [number, SleepStage][]): SleepSession {
    const phases: SleepPhase[] = [];
    for (const [ts, stage] of entries) {
      const last = phases[phases.length - 1];
      if (last && last.stage === stage && ts - (last.start + last.minutes * 60_000) <= 60_000) {
        last.minutes++;
      } else {
        phases.push({ stage, start: ts, minutes: 1 });
      }
    }
    return {
      start: entries[0][0],
      end: entries[entries.length - 1][0] + 60_000,
      phases,
      syncedAt: Date.now(),
    };
  }

  /** No on-ring SpO2 history — report the spot readings taken this session, hourly. */
  async getSpo2(): Promise<Spo2Hour[]> {
    const byHour = new Map<number, Spo2Hour>();
    for (const { ts, value } of this.spo2Spots) {
      const d = new Date(ts);
      const hourTs = new Date(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()).getTime();
      const existing = byHour.get(hourTs);
      if (existing) {
        existing.min = Math.min(existing.min, value);
        existing.max = Math.max(existing.max, value);
      } else {
        byHour.set(hourTs, { ts: hourTs, min: value, max: value });
      }
    }
    return [...byHour.values()].sort((a, b) => a.ts - b.ts);
  }

  /** Spot vitals captured since connecting (HRV, stress, blood pressure). */
  async getVitals(): Promise<VitalSample[]> {
    return this.vitalSpots;
  }

  async startRealtime(kind: RealtimeKind): Promise<void> {
    await this.stopRealtime();
    this.realtimeKind = kind;
    if (kind === "heartRate") {
      await this.write(frame([JCMD.HR_START, 0xb4])); // 180s window, as vendor app
    } else {
      await this.write(frame([JCMD.COMBINED_START_STOP, 0x02])); // mode 2 = SpO2
    }
  }

  async stopRealtime(): Promise<void> {
    const kind = this.realtimeKind;
    this.realtimeKind = null;
    if (!kind || !this.writeChar) return;
    try {
      if (kind === "heartRate") await this.write(frame([JCMD.HR_STOP]));
      else await this.write(frame([JCMD.COMBINED_START_STOP, 0x00]));
    } catch {
      // disconnecting; ignore
    }
  }
}

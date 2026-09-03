/**
 * Simulated ring implementing the same interface as RingClient.
 * Lets the dashboard be developed and demoed without hardware.
 */

import type {
  ActivityBucket,
  BatteryInfo,
  LogEntry,
  RealtimeKind,
  SleepPhase,
  SleepSession,
  Spo2Hour,
  VitalSample,
} from "../types";
import { localDateKey } from "./protocol";
import type { RingEvents, RingLike } from "./ring";
import type { HeartRateLogResult } from "./protocol";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Deterministic pseudo-random per (seed, i). */
function noise(seed: number, i: number): number {
  const x = Math.sin(seed * 374761 + i * 668265) * 43758.5453;
  return x - Math.floor(x);
}

export class DemoRing implements RingLike {
  readonly name = "Demo Ring (simulated)";
  connected = false;
  private events: RingEvents;
  private realtimeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(events: RingEvents = {}) {
    this.events = events;
  }

  private log(dir: LogEntry["dir"], text: string): void {
    this.events.onLog?.({ ts: Date.now(), dir, text });
  }

  async connect(): Promise<void> {
    await delay(400);
    this.connected = true;
    this.log("info", "Connected to simulated ring");
  }

  disconnect(): void {
    this.connected = false;
    if (this.realtimeTimer) clearInterval(this.realtimeTimer);
    this.events.onDisconnect?.();
  }

  async setTime(): Promise<void> {
    await delay(100);
    this.log("info", "Ring clock synced (simulated)");
  }

  async getBattery(): Promise<BatteryInfo> {
    await delay(150);
    return { level: 68, charging: false };
  }

  async ensureHrLogging(): Promise<void> {
    await delay(100);
  }

  async getActivity(dayOffset: number): Promise<ActivityBucket[]> {
    await delay(250);
    const day = new Date();
    day.setDate(day.getDate() - dayOffset);
    const date = localDateKey(day);
    const seed = day.getDate() + day.getMonth() * 31;
    const nowIndex =
      dayOffset === 0 ? Math.floor((day.getHours() * 60 + day.getMinutes()) / 15) : 96;
    const buckets: ActivityBucket[] = [];
    for (let i = 0; i < nowIndex; i++) {
      const hour = i / 4;
      // asleep at night, bursts through the day
      let base = 0;
      if (hour >= 7 && hour < 22) {
        base = 40 + 500 * Math.pow(noise(seed, i), 3);
        if (hour >= 12 && hour < 13) base += 300 * noise(seed, i + 96);
        if (hour >= 17.5 && hour < 19) base += 700 * noise(seed, i + 200);
      }
      const steps = Math.round(base);
      if (steps > 0) {
        buckets.push({
          date,
          timeIndex: i,
          steps,
          calories: Math.round(steps * 0.04),
          distanceM: Math.round(steps * 0.7),
        });
      }
    }
    return buckets;
  }

  async getHeartRateLog(date: Date): Promise<HeartRateLogResult | null> {
    await delay(300);
    const seed = date.getDate() + date.getMonth() * 31 + 7;
    const midnight = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const isToday = localDateKey(date) === localDateKey(new Date());
    const now = new Date();
    const lastSlot = isToday ? Math.floor((now.getHours() * 60 + now.getMinutes()) / 5) : 288;
    const samples = new Array(288).fill(0);
    for (let i = 0; i < lastSlot; i++) {
      const hour = (i * 5) / 60;
      let hr: number;
      if (hour < 7) hr = 52 + 6 * Math.sin(i / 9) + 4 * noise(seed, i);
      else if (hour >= 17.5 && hour < 19) hr = 95 + 35 * noise(seed, i); // workout
      else hr = 68 + 10 * Math.sin(i / 14) + 8 * noise(seed, i);
      if (noise(seed, i + 500) < 0.06) hr = 0; // occasional missed reading
      samples[i] = Math.round(hr);
    }
    return { timestamp: midnight.getTime(), intervalMinutes: 5, samples };
  }

  async getSleep(): Promise<SleepSession[]> {
    await delay(350);
    const sessions: SleepSession[] = [];
    for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
      const midnight = new Date();
      midnight.setHours(0, 0, 0, 0);
      midnight.setDate(midnight.getDate() - daysAgo);
      const seed = midnight.getDate() * 3 + 11;
      const startMin = -75 + Math.round(noise(seed, 1) * 60); // ~22:45–23:45
      const start = midnight.getTime() + startMin * 60_000;
      const phases: SleepPhase[] = [];
      let cursor = start;
      const cycle: { stage: SleepPhase["stage"]; len: number }[] = [
        { stage: "light", len: 20 },
        { stage: "deep", len: 40 },
        { stage: "light", len: 25 },
        { stage: "rem", len: 20 },
      ];
      const totalMin = 420 + Math.round(noise(seed, 2) * 90);
      let elapsed = 0;
      let c = 0;
      while (elapsed < totalMin) {
        const { stage, len } = cycle[c % cycle.length];
        const jitter = Math.round(noise(seed, c) * 14) - 7;
        let minutes = Math.max(8, len + jitter);
        if (noise(seed, c + 40) < 0.12) {
          phases.push({ stage: "awake", start: cursor, minutes: 3 });
          cursor += 3 * 60_000;
          elapsed += 3;
        }
        minutes = Math.min(minutes, totalMin - elapsed);
        if (minutes <= 0) break;
        phases.push({ stage, start: cursor, minutes });
        cursor += minutes * 60_000;
        elapsed += minutes;
        c++;
      }
      sessions.push({ start, end: cursor, phases, syncedAt: Date.now() });
    }
    return sessions;
  }

  async getSpo2(): Promise<Spo2Hour[]> {
    await delay(300);
    const out: Spo2Hour[] = [];
    const now = new Date();
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
      const seed = midnight.getDate() + 17;
      const lastHour = daysAgo === 0 ? now.getHours() : 23;
      for (let hour = 0; hour <= lastHour; hour++) {
        if (noise(seed, hour) < 0.25 && !(hour < 8)) continue; // sparse daytime readings
        const base = 97 - (hour < 6 ? 1 : 0) - Math.round(noise(seed, hour + 24) * 2);
        out.push({
          ts: midnight.getTime() + hour * 3_600_000,
          min: base - 1 - Math.round(noise(seed, hour + 48)),
          max: Math.min(100, base + 1),
        });
      }
    }
    return out;
  }

  async getVitals(): Promise<VitalSample[]> {
    await delay(150);
    const out: VitalSample[] = [];
    const now = new Date();
    for (let daysAgo = 6; daysAgo >= 0; daysAgo--) {
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
      const seed = midnight.getDate() + 41;
      const lastHour = daysAgo === 0 ? now.getHours() : 22;
      for (let hour = 6; hour <= lastHour; hour += 2) {
        out.push({
          ts: midnight.getTime() + hour * 3_600_000,
          hrv: Math.round(38 + noise(seed, hour) * 22),
          stress: Math.round(25 + noise(seed, hour + 12) * 40),
          fatigue: Math.round(20 + noise(seed, hour + 30) * 35),
          systolic: Math.round(115 + noise(seed, hour + 50) * 12),
          diastolic: Math.round(74 + noise(seed, hour + 70) * 8),
        });
      }
    }
    return out;
  }

  async startRealtime(kind: RealtimeKind): Promise<void> {
    await this.stopRealtime();
    let i = 0;
    this.realtimeTimer = setInterval(() => {
      i++;
      const value =
        kind === "spo2"
          ? 96 + Math.round(noise(9, i) * 3)
          : 66 + Math.round(8 * Math.sin(i / 4) + noise(3, i) * 6);
      this.events.onRealtimeReading?.(kind, value);
    }, 1_000);
  }

  async stopRealtime(): Promise<void> {
    if (this.realtimeTimer) {
      clearInterval(this.realtimeTimer);
      this.realtimeTimer = null;
    }
  }
}

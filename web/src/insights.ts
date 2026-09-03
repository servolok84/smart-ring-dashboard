/**
 * Weekly summary derived from synced data.
 *
 * Everything here is measured against the user's own recent history — there
 * are no goals or targets anywhere in this module, by design. The question it
 * answers is "how does this week compare with my last one", not "did I win".
 */

import { localDateKey } from "./ble/protocol";
import type { HeartRateDay, SleepSession, Spo2Hour, StepsDay } from "./types";

export type MetricKey = "sleep" | "restingHr" | "steps" | "spo2";

export interface MetricWeek {
  key: MetricKey;
  label: string;
  /** 7 entries, oldest first; index 6 is today. null = no data that day. */
  daily: (number | null)[];
  /** All 14 days (newest first) — a steadier baseline for the dials. */
  history: (number | null)[];
  /** Mean of the days that have data, or null if none do. */
  average: number | null;
  /** Same for the 7 days before this week. */
  previousAverage: number | null;
  /** Formats a value for display, e.g. 7.4 → "7h 24m". */
  format: (value: number) => string;
  /** Formats a difference, e.g. 0.4 → "24 min". Sign is handled by the caller. */
  formatDelta: (value: number) => string;
  /** How many of the 7 days have data. */
  count: number;
}

export interface WeekSummary {
  metrics: MetricWeek[];
  observations: string[];
  /** Day labels aligned with `daily`, e.g. ["Thu", … "Today"]. */
  dayLabels: string[];
}

const DAY_MS = 86_400_000;

function dateKeyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return localDateKey(d);
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function defined(values: (number | null)[]): number[] {
  return values.filter((v): v is number => v !== null);
}

// ---------------------------------------------------------------- formatters

export function formatHours(hours: number): string {
  const total = Math.round(hours * 60);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function formatMinutesDelta(hours: number): string {
  const minutes = Math.round(Math.abs(hours) * 60);
  if (minutes >= 60) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h}h` : `${h}h ${m}m`;
  }
  return `${minutes} min`;
}

const formatBpm = (v: number) => `${Math.round(v)} bpm`;
const formatSteps = (v: number) => Math.round(v).toLocaleString();
const formatPercent = (v: number) => `${v.toFixed(1)}%`;

// ---------------------------------------------------------------- per-day values

/**
 * Resting heart rate for a day: the 5th percentile of valid samples, which
 * tracks the sustained overnight low without being thrown by a single dip.
 * Needs a reasonable number of samples to mean anything.
 */
export function restingHrForDay(day: HeartRateDay | undefined): number | null {
  if (!day) return null;
  const valid = day.samples.filter((v) => v > 0).sort((a, b) => a - b);
  if (valid.length < 12) return null;
  const index = Math.floor(valid.length * 0.05);
  return valid[index];
}

/** Total sleep for the night that ended on `dateKey`, in hours. */
function sleepHoursForDay(sessions: SleepSession[], dateKey: string): number | null {
  const night = sessions
    .filter((s) => localDateKey(new Date(s.end)) === dateKey)
    .sort((a, b) => b.end - b.start - (a.end - a.start))[0];
  if (!night) return null;
  // Count actual sleep, excluding time awake in bed.
  const asleepMinutes = night.phases
    .filter((p) => p.stage !== "awake")
    .reduce((sum, p) => sum + p.minutes, 0);
  const minutes = asleepMinutes > 0 ? asleepMinutes : (night.end - night.start) / 60_000;
  return minutes / 60;
}

/** Mean blood oxygen across the hours that have readings. */
function spo2ForDay(hours: Spo2Hour[], dateKey: string): number | null {
  const dayHours = hours.filter((h) => localDateKey(new Date(h.ts)) === dateKey);
  return mean(dayHours.map((h) => (h.min + h.max) / 2));
}

/**
 * How this value compares with the user's own typical recent value, as 0..1
 * where 1 means "at or above your usual".
 *
 * The reference is the 75th percentile of their own history — not a goal, not
 * a population norm, and nothing the user set. A normal day lands close to
 * full; a quiet day sits visibly lower. Min/max scaling was tried first and
 * is wrong here: it pins whichever day happens to be the lowest at zero, so
 * an ordinary night could render as an empty ring.
 *
 * Returns null when there isn't enough history to compare against.
 */
export function positionInRange(
  value: number | null,
  history: (number | null)[],
): number | null {
  if (value === null) return null;
  const values = defined(history).sort((a, b) => a - b);
  if (values.length < 2) return null;
  const reference = values[Math.min(values.length - 1, Math.floor(values.length * 0.75))];
  if (Math.abs(reference) < 1e-9) return 0.5;
  // Floor keeps a visible arc: an empty ring reads as broken, and a low
  // reading is still a reading.
  return Math.max(0.1, Math.min(1, value / reference));
}

/** Low/high of the user's recent values, for a "typical range" caption. */
export function typicalRange(history: (number | null)[]): [number, number] | null {
  const values = defined(history);
  if (values.length < 2) return null;
  return [Math.min(...values), Math.max(...values)];
}

// ---------------------------------------------------------------- summary

export function buildWeekSummary(
  stepsDays: Map<string, StepsDay>,
  hrDays: Map<string, HeartRateDay>,
  sleepSessions: SleepSession[],
  spo2Hours: Spo2Hour[],
): WeekSummary {
  // offsets 0..6 = this week (6 = today), 7..13 = the week before
  const keys = Array.from({ length: 14 }, (_, i) => dateKeyDaysAgo(i));

  const sleepByOffset = keys.map((k) => sleepHoursForDay(sleepSessions, k));
  const hrByOffset = keys.map((k) => restingHrForDay(hrDays.get(k)));
  const stepsByOffset = keys.map((k) => stepsDays.get(k)?.totalSteps ?? null);
  const spo2ByOffset = keys.map((k) => spo2ForDay(spo2Hours, k));

  // `daily` runs oldest → newest, so reverse the first seven offsets.
  const thisWeek = <T,>(byOffset: T[]) => byOffset.slice(0, 7).reverse();
  const lastWeek = <T,>(byOffset: T[]) => byOffset.slice(7, 14);

  const build = (
    key: MetricKey,
    label: string,
    byOffset: (number | null)[],
    format: (v: number) => string,
    formatDelta: (v: number) => string,
  ): MetricWeek => {
    const daily = thisWeek(byOffset);
    return {
      key,
      label,
      daily,
      history: byOffset,
      average: mean(defined(daily)),
      previousAverage: mean(defined(lastWeek(byOffset))),
      format,
      formatDelta,
      count: defined(daily).length,
    };
  };

  const metrics: MetricWeek[] = [
    build("sleep", "Sleep", sleepByOffset, formatHours, formatMinutesDelta),
    build("restingHr", "Resting heart rate", hrByOffset, formatBpm, (v) =>
      `${Math.round(Math.abs(v))} bpm`,
    ),
    build("steps", "Steps", stepsByOffset, formatSteps, (v) =>
      Math.round(Math.abs(v)).toLocaleString(),
    ),
    build("spo2", "Blood oxygen", spo2ByOffset, formatPercent, (v) => `${Math.abs(v).toFixed(1)}%`),
  ];

  const dayLabels = Array.from({ length: 7 }, (_, i) => {
    const daysAgo = 6 - i;
    if (daysAgo === 0) return "Today";
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return d.toLocaleDateString([], { weekday: "short" });
  });

  return {
    metrics,
    observations: buildObservations(metrics, stepsDays, sleepSessions),
    dayLabels,
  };
}

export interface TrendSeries {
  key: MetricKey;
  label: string;
  points: { label: string; value: number | null }[];
  /** Full value, used in the hover readout. */
  format: (v: number) => string;
  /** Short form for axis ticks, which have little room. */
  formatAxis: (v: number) => string;
  zeroBased: boolean;
}

/** Daily series over a longer window, for the trends view. */
export function buildTrends(
  stepsDays: Map<string, StepsDay>,
  hrDays: Map<string, HeartRateDay>,
  sleepSessions: SleepSession[],
  spo2Hours: Spo2Hour[],
  days = 30,
): TrendSeries[] {
  const entries = Array.from({ length: days }, (_, i) => {
    const daysAgo = days - 1 - i;
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return {
      key: localDateKey(d),
      label:
        daysAgo === 0
          ? "Today"
          : d.toLocaleDateString([], { day: "numeric", month: "short" }),
    };
  });

  const series = (
    key: MetricKey,
    label: string,
    valueFor: (dateKey: string) => number | null,
    format: (v: number) => string,
    formatAxis: (v: number) => string,
    zeroBased: boolean,
  ): TrendSeries => ({
    key,
    label,
    points: entries.map((e) => ({ label: e.label, value: valueFor(e.key) })),
    format,
    formatAxis,
    zeroBased,
  });

  const compactSteps = (v: number) =>
    v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`;

  return [
    series(
      "sleep",
      "Sleep",
      (k) => sleepHoursForDay(sleepSessions, k),
      formatHours,
      (v) => `${v.toFixed(1)}h`,
      false,
    ),
    series(
      "restingHr",
      "Resting heart rate",
      (k) => restingHrForDay(hrDays.get(k)),
      (v) => `${Math.round(v)} bpm`,
      (v) => `${Math.round(v)}`,
      false,
    ),
    series(
      "steps",
      "Steps",
      (k) => stepsDays.get(k)?.totalSteps ?? null,
      (v) => Math.round(v).toLocaleString(),
      compactSteps,
      true,
    ),
    series(
      "spo2",
      "Blood oxygen",
      (k) => spo2ForDay(spo2Hours, k),
      (v) => `${v.toFixed(1)}%`,
      (v) => `${v.toFixed(0)}%`,
      false,
    ),
  ];
}

/**
 * Plain-language notes about the week. Descriptive only — these say what
 * happened, never what the user should do about it.
 */
function buildObservations(
  metrics: MetricWeek[],
  stepsDays: Map<string, StepsDay>,
  sleepSessions: SleepSession[],
): string[] {
  const notes: string[] = [];
  const byKey = new Map(metrics.map((m) => [m.key, m]));

  const describeChange = (m: MetricWeek, noun: string, unitPhrase: string): string | null => {
    if (m.average === null || m.previousAverage === null) return null;
    const diff = m.average - m.previousAverage;
    const magnitude = m.formatDelta(diff);
    // Ignore changes too small to be meaningful.
    const relative = Math.abs(diff) / Math.max(Math.abs(m.previousAverage), 0.001);
    if (relative < 0.02) return `${noun} held steady at ${m.format(m.average)}.`;
    const direction = diff > 0 ? "higher" : "lower";
    return `${noun} averaged ${m.format(m.average)}, ${magnitude} ${direction} than last week${unitPhrase}.`;
  };

  const sleep = byKey.get("sleep");
  if (sleep?.average !== null && sleep !== undefined) {
    const change = describeChange(sleep, "Sleep", "");
    if (change) notes.push(change);
    else notes.push(`You slept ${sleep.format(sleep.average!)} a night on average.`);

    // Consistency: spread between the longest and shortest night.
    const nights = defined(sleep.daily);
    if (nights.length >= 3) {
      const spread = Math.max(...nights) - Math.min(...nights);
      notes.push(
        spread < 1
          ? "Your nights were close to the same length all week."
          : `Your shortest and longest nights differed by ${formatMinutesDelta(spread)}.`,
      );
    }
  }

  const hr = byKey.get("restingHr");
  const hrChange = hr ? describeChange(hr, "Resting heart rate", "") : null;
  if (hrChange) notes.push(hrChange);

  const steps = byKey.get("steps");
  if (steps && steps.count > 0) {
    const best = steps.daily.reduce<{ value: number; index: number } | null>(
      (acc, value, index) =>
        value !== null && (acc === null || value > acc.value) ? { value, index } : acc,
      null,
    );
    if (best) {
      const daysAgo = 6 - best.index;
      const when =
        daysAgo === 0
          ? "today"
          : daysAgo === 1
            ? "yesterday"
            : new Date(Date.now() - daysAgo * DAY_MS).toLocaleDateString([], { weekday: "long" });
      notes.push(`Your most active day was ${when}, at ${formatSteps(best.value)} steps.`);
    }
  }

  const spo2 = byKey.get("spo2");
  if (spo2?.average != null) {
    notes.push(`Blood oxygen averaged ${spo2.format(spo2.average)} across ${spo2.count} day${spo2.count === 1 ? "" : "s"}.`);
  }

  if (notes.length === 0) {
    notes.push(
      sleepSessions.length === 0 && stepsDays.size === 0
        ? "Sync your ring to start building a picture of your week."
        : "Keep syncing — a few more days will fill this out.",
    );
  }
  return notes;
}

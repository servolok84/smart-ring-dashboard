/**
 * Sleep / Readiness / Activity scores.
 *
 * IMPORTANT, and stated in the UI too: these are transparent heuristics
 * computed on this device from the ring's own readings. They are not Oura's
 * algorithms, they are not validated against sleep-lab data, and they are not
 * medical advice. Every rule below is written out in plain sight so a number
 * can always be traced back to why.
 *
 * Design rules:
 *  - Anything that can be judged against the user's own baseline is. Absolute
 *    bands are used only where general sleep/activity science gives a defensible
 *    reference (sleep duration, sleep efficiency), and the UI names them.
 *  - A contributor whose input is missing scores `null` and drops out; the
 *    overall score renormalises over what's left and reports its coverage, so a
 *    partial night never silently reads as a bad one.
 */

import { localDateKey } from "./ble/protocol";
import { restingHrForDay } from "./insights";
import type { HeartRateDay, SleepSession, StepsDay } from "./types";

export interface Contributor {
  key: string;
  label: string;
  /** 0..100, or null when the data needed isn't there. */
  score: number | null;
  /** Plain-language line explaining this contributor's value. */
  detail: string;
  weight: number;
}

export interface Score {
  /** 0..100, or null when nothing could be computed. */
  value: number | null;
  contributors: Contributor[];
  /** Share of the intended weight that had data behind it, 0..1. */
  coverage: number;
}

export interface Baseline {
  restingHr: number | null;
  sleepHours: number | null;
  steps: number | null;
  /** Median bedtime as minutes from midnight; negative means before midnight. */
  bedtimeMinutes: number | null;
  hrv: number | null;
}

const clamp = (v: number, lo = 0, hi = 100) => Math.max(lo, Math.min(hi, v));

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Piecewise-linear map through labelled points, e.g. `curve(x, [[4,20],[7,100]])`.
 * Points must be ascending in x. Values outside the range clamp to the ends.
 */
function curve(x: number, points: [number, number][]): number {
  if (x <= points[0][0]) return points[0][1];
  const last = points[points.length - 1];
  if (x >= last[0]) return last[1];
  for (let i = 1; i < points.length; i++) {
    const [x0, y0] = points[i - 1];
    const [x1, y1] = points[i];
    if (x <= x1) return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
  }
  return last[1];
}

function combine(contributors: Contributor[]): Score {
  const scored = contributors.filter((c) => c.score !== null);
  const totalWeight = contributors.reduce((s, c) => s + c.weight, 0);
  const usedWeight = scored.reduce((s, c) => s + c.weight, 0);
  if (usedWeight === 0) return { value: null, contributors, coverage: 0 };
  const value =
    scored.reduce((s, c) => s + (c.score as number) * c.weight, 0) / usedWeight;
  return {
    value: Math.round(clamp(value)),
    contributors,
    coverage: usedWeight / totalWeight,
  };
}

// ---------------------------------------------------------------- baseline

/** Median of the user's recent history, used as the personal reference. */
export function buildBaseline(
  stepsDays: Map<string, StepsDay>,
  hrDays: Map<string, HeartRateDay>,
  sleepSessions: SleepSession[],
  hrvSamples: { ts: number; value: number }[],
  days = 21,
): Baseline {
  const since = Date.now() - days * 86_400_000;

  const restingValues: number[] = [];
  for (const day of hrDays.values()) {
    if (Date.parse(`${day.date}T00:00:00`) < since) continue;
    const resting = restingHrForDay(day);
    if (resting !== null) restingValues.push(resting);
  }

  const sleepValues: number[] = [];
  const bedtimes: number[] = [];
  for (const session of sleepSessions) {
    if (session.end < since) continue;
    sleepValues.push(asleepMinutes(session) / 60);
    bedtimes.push(bedtimeMinutes(session));
  }

  const stepValues: number[] = [];
  for (const day of stepsDays.values()) {
    if (Date.parse(`${day.date}T00:00:00`) < since) continue;
    if (day.totalSteps > 0) stepValues.push(day.totalSteps);
  }

  return {
    restingHr: median(restingValues),
    sleepHours: median(sleepValues),
    steps: median(stepValues),
    bedtimeMinutes: median(bedtimes),
    hrv: median(hrvSamples.filter((s) => s.ts >= since).map((s) => s.value)),
  };
}

/** Minutes actually asleep (every stage except awake). */
export function asleepMinutes(session: SleepSession): number {
  const asleep = session.phases
    .filter((p) => p.stage !== "awake")
    .reduce((sum, p) => sum + p.minutes, 0);
  return asleep > 0 ? asleep : (session.end - session.start) / 60_000;
}

/** Bedtime as minutes from midnight; negative = before midnight. */
function bedtimeMinutes(session: SleepSession): number {
  const start = new Date(session.start);
  const minutes = start.getHours() * 60 + start.getMinutes();
  // Anything after 6pm counts as "the night before" so the median behaves.
  return minutes > 18 * 60 ? minutes - 1440 : minutes;
}

// ---------------------------------------------------------------- sleep

export interface SleepDetail {
  asleepMinutes: number;
  inBedMinutes: number;
  /** asleep / in bed, 0..1 */
  efficiency: number;
  awakeMinutes: number;
  wakeEpisodes: number;
  deepMinutes: number;
  remMinutes: number;
  lightMinutes: number;
  /** Minutes from the session start to the first non-awake phase. */
  latencyMinutes: number;
  start: number;
  end: number;
}

export function sleepDetail(session: SleepSession): SleepDetail {
  const asleep = asleepMinutes(session);
  const inBed = Math.max((session.end - session.start) / 60_000, asleep);
  const byStage = { light: 0, deep: 0, rem: 0, awake: 0 };
  for (const phase of session.phases) byStage[phase.stage] += phase.minutes;

  let wakeEpisodes = 0;
  for (let i = 0; i < session.phases.length; i++) {
    // Count wake episodes after sleep has actually begun.
    if (session.phases[i].stage === "awake" && i > 0) wakeEpisodes++;
  }

  let latency = 0;
  for (const phase of session.phases) {
    if (phase.stage === "awake") latency += phase.minutes;
    else break;
  }

  return {
    asleepMinutes: asleep,
    inBedMinutes: inBed,
    efficiency: inBed > 0 ? asleep / inBed : 0,
    awakeMinutes: byStage.awake,
    wakeEpisodes,
    deepMinutes: byStage.deep,
    remMinutes: byStage.rem,
    lightMinutes: byStage.light,
    latencyMinutes: latency,
    start: session.start,
    end: session.end,
  };
}

export function sleepScore(
  session: SleepSession | null,
  baseline: Baseline,
): Score {
  if (!session) {
    return {
      value: null,
      contributors: [],
      coverage: 0,
    };
  }
  const d = sleepDetail(session);
  const hours = d.asleepMinutes / 60;

  // Duration: general adult reference (7–9 h), softened at the edges rather
  // than treated as a pass/fail line.
  const duration = curve(hours, [
    [3, 15],
    [5, 42],
    [6, 62],
    [7, 82],
    [7.5, 92],
    [8, 100],
    [9, 97],
    [10.5, 85],
  ]);

  // Efficiency: share of time in bed actually spent asleep.
  const efficiency = curve(d.efficiency * 100, [
    [60, 20],
    [75, 55],
    [85, 80],
    [92, 95],
    [97, 100],
  ]);

  // Restfulness: fewer, shorter wakes score higher.
  const restfulness = clamp(
    100 - d.wakeEpisodes * 7 - Math.max(0, d.awakeMinutes - 10) * 1.2,
  );

  // Deep sleep: typically 13–23% of a night in healthy adults.
  const deepShare = d.asleepMinutes > 0 ? (d.deepMinutes / d.asleepMinutes) * 100 : 0;
  const deep = d.deepMinutes > 0
    ? curve(deepShare, [
        [3, 30],
        [8, 65],
        [13, 95],
        [20, 100],
        [30, 90],
      ])
    : null;

  // Timing: how far bedtime drifted from this user's own usual bedtime.
  let timing: number | null = null;
  let timingDetail = "Not enough nights yet to know your usual bedtime";
  if (baseline.bedtimeMinutes !== null) {
    const drift = Math.abs(bedtimeMinutes(session) - baseline.bedtimeMinutes);
    timing = curve(drift, [
      [15, 100],
      [45, 85],
      [90, 60],
      [150, 35],
    ]);
    timingDetail =
      drift < 20
        ? "Right around your usual bedtime"
        : `${Math.round(drift)} min from your usual bedtime`;
  }

  return combine([
    {
      key: "duration",
      label: "Total sleep",
      score: duration,
      detail: `${formatHm(d.asleepMinutes)} asleep`,
      weight: 3,
    },
    {
      key: "efficiency",
      label: "Efficiency",
      score: efficiency,
      detail: `${Math.round(d.efficiency * 100)}% of time in bed asleep`,
      weight: 2,
    },
    {
      key: "restfulness",
      label: "Restfulness",
      score: restfulness,
      detail:
        d.wakeEpisodes === 0
          ? "No wake-ups detected"
          : `${d.wakeEpisodes} wake-up${d.wakeEpisodes === 1 ? "" : "s"}, ${formatHm(d.awakeMinutes)} awake`,
      weight: 1.5,
    },
    {
      key: "deep",
      label: "Deep sleep",
      score: deep,
      detail:
        d.deepMinutes > 0
          ? `${formatHm(d.deepMinutes)} (${Math.round(deepShare)}% of the night)`
          : "No deep sleep recorded",
      weight: 1.5,
    },
    {
      key: "timing",
      label: "Timing",
      score: timing,
      detail: timingDetail,
      weight: 1,
    },
  ]);
}

// ---------------------------------------------------------------- readiness

export function readinessScore(args: {
  restingHr: number | null;
  hrv: number | null;
  lastNight: Score;
  sleepLastWeekHours: number[];
  stepsLastWeek: number[];
  baseline: Baseline;
}): Score {
  const { restingHr, hrv, lastNight, sleepLastWeekHours, stepsLastWeek, baseline } = args;

  // Resting heart rate against the user's own median: at or below is a good
  // sign; elevated is the classic "not fully recovered" signal.
  let restingScore: number | null = null;
  let restingDetail = "No resting heart rate for last night";
  if (restingHr !== null && baseline.restingHr !== null) {
    const delta = restingHr - baseline.restingHr;
    restingScore = curve(delta, [
      [-6, 100],
      [0, 92],
      [3, 72],
      [6, 48],
      [12, 20],
    ]);
    restingDetail =
      Math.abs(delta) < 1
        ? `${Math.round(restingHr)} bpm, right at your usual`
        : `${Math.round(restingHr)} bpm, ${Math.abs(Math.round(delta))} ${delta > 0 ? "above" : "below"} your usual`;
  } else if (restingHr !== null) {
    restingDetail = `${Math.round(restingHr)} bpm — building your baseline`;
  }

  // HRV against the user's own median. Higher than usual generally tracks
  // better recovery; this is a ratio, never an absolute target.
  let hrvScore: number | null = null;
  let hrvDetail = "No HRV readings yet — take a measurement to start";
  if (hrv !== null && baseline.hrv !== null && baseline.hrv > 0) {
    const ratio = hrv / baseline.hrv;
    hrvScore = curve(ratio, [
      [0.6, 25],
      [0.8, 55],
      [1, 88],
      [1.2, 100],
    ]);
    hrvDetail = `${Math.round(hrv)} ms vs your usual ${Math.round(baseline.hrv)} ms`;
  } else if (hrv !== null) {
    hrvDetail = `${Math.round(hrv)} ms — building your baseline`;
  }

  // Sleep balance: has the week as a whole given you enough sleep?
  let balanceScore: number | null = null;
  let balanceDetail = "Not enough nights recorded";
  if (sleepLastWeekHours.length >= 3) {
    const avg = sleepLastWeekHours.reduce((s, v) => s + v, 0) / sleepLastWeekHours.length;
    balanceScore = curve(avg, [
      [4.5, 30],
      [6, 65],
      [7, 92],
      [8, 100],
    ]);
    balanceDetail = `${formatHm(avg * 60)} a night across ${sleepLastWeekHours.length} nights`;
  }

  // Activity balance: a big jump above your usual load costs recovery.
  let activityScoreValue: number | null = null;
  let activityDetail = "Not enough activity history";
  if (stepsLastWeek.length >= 3 && baseline.steps) {
    const recent = stepsLastWeek.slice(-3);
    const avg = recent.reduce((s, v) => s + v, 0) / recent.length;
    const ratio = avg / baseline.steps;
    activityScoreValue = curve(ratio, [
      [0.3, 70],
      [0.8, 95],
      [1.1, 100],
      [1.6, 75],
      [2.2, 55],
    ]);
    activityDetail =
      ratio > 1.4
        ? "Recent days were busier than usual"
        : ratio < 0.6
          ? "Recent days were quieter than usual"
          : "Recent activity is in your usual range";
  }

  return combine([
    {
      key: "restingHr",
      label: "Resting heart rate",
      score: restingScore,
      detail: restingDetail,
      weight: 3,
    },
    {
      key: "sleep",
      label: "Last night's sleep",
      score: lastNight.value,
      detail: lastNight.value === null ? "No sleep recorded" : `Sleep score ${lastNight.value}`,
      weight: 2.5,
    },
    { key: "hrv", label: "HRV", score: hrvScore, detail: hrvDetail, weight: 2 },
    {
      key: "sleepBalance",
      label: "Sleep balance",
      score: balanceScore,
      detail: balanceDetail,
      weight: 1.5,
    },
    {
      key: "activityBalance",
      label: "Activity balance",
      score: activityScoreValue,
      detail: activityDetail,
      weight: 1,
    },
  ]);
}

// ---------------------------------------------------------------- activity

export function activityScore(args: {
  day: StepsDay | undefined;
  stepsLastWeek: number[];
  baseline: Baseline;
  /** True when the day is still in progress, so it isn't judged as finished. */
  partial: boolean;
}): Score {
  const { day, stepsLastWeek, baseline, partial } = args;
  if (!day || day.totalSteps === 0) {
    return { value: null, contributors: [], coverage: 0 };
  }

  // Compare against the user's own median day, pro-rated when today is still
  // running so a morning isn't scored as if it were a whole day.
  let volume: number | null = null;
  let volumeDetail = `${day.totalSteps.toLocaleString()} steps`;
  if (baseline.steps) {
    const now = new Date();
    const elapsed = partial
      ? Math.max(0.25, (now.getHours() * 60 + now.getMinutes()) / (18 * 60))
      : 1;
    const expected = baseline.steps * Math.min(1, elapsed);
    const ratio = day.totalSteps / Math.max(expected, 1);
    volume = curve(ratio, [
      [0.2, 25],
      [0.6, 60],
      [0.9, 88],
      [1.1, 100],
      [2, 100],
    ]);
    volumeDetail = partial
      ? `${day.totalSteps.toLocaleString()} steps so far, vs your usual pace`
      : `${day.totalSteps.toLocaleString()} steps vs your usual ${Math.round(baseline.steps).toLocaleString()}`;
  }

  // How spread out the movement was: many active quarter-hours beats one burst.
  const activeBuckets = day.buckets.filter((b) => b.steps >= 250).length;
  const frequency = day.buckets.length
    ? curve(activeBuckets, [
        [0, 20],
        [4, 55],
        [8, 80],
        [14, 100],
      ])
    : null;

  // Longest inactive stretch during the waking day.
  let inactivity: number | null = null;
  let inactivityDetail = "Not enough detail to measure sedentary time";
  if (day.buckets.length > 0) {
    const active = new Set(day.buckets.filter((b) => b.steps >= 100).map((b) => b.timeIndex));
    let longest = 0;
    let run = 0;
    // 07:00–22:00 → quarter-hour indices 28..88
    for (let i = 28; i <= 88; i++) {
      if (active.has(i)) run = 0;
      else run++;
      longest = Math.max(longest, run);
    }
    const hoursIdle = (longest * 15) / 60;
    inactivity = curve(hoursIdle, [
      [1, 100],
      [2, 85],
      [4, 55],
      [6, 30],
    ]);
    inactivityDetail = `Longest still stretch ${formatHm(longest * 15)}`;
  }

  let consistency: number | null = null;
  let consistencyDetail = "Not enough days yet";
  if (stepsLastWeek.length >= 3) {
    const daysMoving = stepsLastWeek.filter((s) => s > (baseline.steps ?? 1000) * 0.5).length;
    consistency = curve(daysMoving / stepsLastWeek.length, [
      [0.2, 35],
      [0.5, 70],
      [0.8, 95],
      [1, 100],
    ]);
    consistencyDetail = `${daysMoving} of ${stepsLastWeek.length} days near your usual`;
  }

  return combine([
    { key: "volume", label: "Steps", score: volume, detail: volumeDetail, weight: 3 },
    {
      key: "frequency",
      label: "Movement spread",
      score: frequency,
      detail:
        activeBuckets > 0
          ? `${activeBuckets} active quarter-hours`
          : "No sustained activity recorded",
      weight: 1.5,
    },
    {
      key: "inactivity",
      label: "Sedentary time",
      score: inactivity,
      detail: inactivityDetail,
      weight: 1.5,
    },
    {
      key: "consistency",
      label: "Weekly consistency",
      score: consistency,
      detail: consistencyDetail,
      weight: 1,
    },
  ]);
}

// ---------------------------------------------------------------- helpers

export function formatHm(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

/** Descriptive band for a score. Wording is neutral, never congratulatory. */
export function scoreBand(value: number | null): string {
  if (value === null) return "No data";
  if (value >= 85) return "Well recovered";
  if (value >= 70) return "Good";
  if (value >= 55) return "Fair";
  return "Take it easy";
}

export function sleepBand(value: number | null): string {
  if (value === null) return "No data";
  if (value >= 85) return "Restful night";
  if (value >= 70) return "Good night";
  if (value >= 55) return "Fair night";
  return "Restless night";
}

export function activityBand(value: number | null): string {
  if (value === null) return "No data";
  if (value >= 85) return "Active day";
  if (value >= 70) return "Steady day";
  if (value >= 55) return "Light day";
  return "Quiet day";
}

/** The sleep session belonging to the night that ended on `dateKey`. */
export function sessionForDate(
  sessions: SleepSession[],
  dateKey: string,
): SleepSession | null {
  return (
    sessions
      .filter((s) => localDateKey(new Date(s.end)) === dateKey)
      .sort((a, b) => b.end - b.start - (a.end - a.start))[0] ?? null
  );
}

import { describe, expect, it } from "vitest";
import {
  activityScore,
  buildBaseline,
  formatHm,
  readinessScore,
  sessionForDate,
  sleepDetail,
  sleepScore,
  type Baseline,
} from "../scores";
import type { HeartRateDay, SleepPhase, SleepSession, StepsDay } from "../types";

const EMPTY_BASELINE: Baseline = {
  restingHr: null,
  sleepHours: null,
  steps: null,
  bedtimeMinutes: null,
  hrv: null,
};

/** A night built from [stage, minutes] pairs, starting at 23:00 the day before. */
function night(
  pairs: [SleepPhase["stage"], number][],
  startHour = 23,
  dayOffset = -1,
): SleepSession {
  const start = new Date(2026, 8, 3 + dayOffset, startHour, 0, 0).getTime();
  let cursor = start;
  const phases: SleepPhase[] = pairs.map(([stage, minutes]) => {
    const phase = { stage, start: cursor, minutes };
    cursor += minutes * 60_000;
    return phase;
  });
  return { start, end: cursor, phases, syncedAt: Date.now() };
}

const GOOD_NIGHT = night([
  ["light", 200],
  ["deep", 90],
  ["rem", 90],
  ["light", 100],
]);

describe("sleepDetail", () => {
  it("separates time asleep from time in bed", () => {
    const d = sleepDetail(
      night([
        ["awake", 20],
        ["light", 180],
        ["deep", 60],
      ]),
    );
    expect(d.asleepMinutes).toBe(240);
    expect(d.inBedMinutes).toBe(260);
    expect(d.efficiency).toBeCloseTo(240 / 260, 3);
  });

  it("counts leading awake time as sleep latency", () => {
    expect(sleepDetail(night([["awake", 25], ["light", 300]])).latencyMinutes).toBe(25);
  });

  it("reports no latency when sleep starts immediately", () => {
    expect(sleepDetail(night([["light", 300]])).latencyMinutes).toBe(0);
  });

  it("counts wake episodes only after sleep has begun", () => {
    const d = sleepDetail(
      night([
        ["awake", 10], // falling asleep, not a wake-up
        ["light", 120],
        ["awake", 15], // a real wake-up
        ["light", 120],
      ]),
    );
    expect(d.wakeEpisodes).toBe(1);
  });

  it("totals each stage", () => {
    const d = sleepDetail(GOOD_NIGHT);
    expect(d.deepMinutes).toBe(90);
    expect(d.remMinutes).toBe(90);
    expect(d.lightMinutes).toBe(300);
  });
});

describe("sleepScore", () => {
  it("has no value at all without a night", () => {
    const s = sleepScore(null, EMPTY_BASELINE);
    expect(s.value).toBeNull();
    expect(s.coverage).toBe(0);
  });

  it("scores a solid night well above a short broken one", () => {
    const good = sleepScore(GOOD_NIGHT, EMPTY_BASELINE).value!;
    const poor = sleepScore(
      night([
        ["awake", 40],
        ["light", 90],
        ["awake", 30],
        ["light", 60],
      ]),
      EMPTY_BASELINE,
    ).value!;
    expect(good).toBeGreaterThan(poor + 20);
  });

  it("stays within 0..100", () => {
    for (const s of [
      sleepScore(night([["deep", 700]]), EMPTY_BASELINE),
      sleepScore(night([["awake", 600]]), EMPTY_BASELINE),
      sleepScore(GOOD_NIGHT, EMPTY_BASELINE),
    ]) {
      expect(s.value).toBeGreaterThanOrEqual(0);
      expect(s.value).toBeLessThanOrEqual(100);
    }
  });

  it("drops the timing contributor when no bedtime baseline exists", () => {
    const s = sleepScore(GOOD_NIGHT, EMPTY_BASELINE);
    const timing = s.contributors.find((c) => c.key === "timing")!;
    expect(timing.score).toBeNull();
    // and says so, rather than silently counting it as zero
    expect(s.coverage).toBeLessThan(1);
  });

  it("does not punish a night that merely lacks a contributor", () => {
    // no deep sleep recorded at all -> that contributor drops out
    const noDeep = sleepScore(night([["light", 260], ["rem", 200]]), EMPTY_BASELINE);
    const deepContributor = noDeep.contributors.find((c) => c.key === "deep")!;
    expect(deepContributor.score).toBeNull();
    expect(noDeep.value).toBeGreaterThan(60);
  });
});

describe("readinessScore", () => {
  const baseline: Baseline = { ...EMPTY_BASELINE, restingHr: 60, hrv: 50, steps: 8000 };
  const base = {
    lastNight: sleepScore(GOOD_NIGHT, baseline),
    sleepLastWeekHours: [7.5, 8, 7, 7.5, 8, 7, 7.5],
    stepsLastWeek: [8000, 8200, 7800, 8100, 8000, 7900, 8050],
    baseline,
  };

  it("rates an elevated resting heart rate lower than a normal one", () => {
    const normal = readinessScore({ ...base, restingHr: 60, hrv: 50 }).value!;
    const elevated = readinessScore({ ...base, restingHr: 70, hrv: 50 }).value!;
    expect(elevated).toBeLessThan(normal);
  });

  it("rates suppressed HRV lower than typical HRV", () => {
    const typical = readinessScore({ ...base, restingHr: 60, hrv: 50 }).value!;
    const low = readinessScore({ ...base, restingHr: 60, hrv: 30 }).value!;
    expect(low).toBeLessThan(typical);
  });

  it("still produces a score when HRV is missing, and marks reduced coverage", () => {
    const s = readinessScore({ ...base, restingHr: 60, hrv: null });
    expect(s.value).not.toBeNull();
    expect(s.contributors.find((c) => c.key === "hrv")!.score).toBeNull();
    expect(s.coverage).toBeLessThan(1);
  });

  it("returns null only when nothing at all is known", () => {
    const s = readinessScore({
      restingHr: null,
      hrv: null,
      lastNight: sleepScore(null, EMPTY_BASELINE),
      sleepLastWeekHours: [],
      stepsLastWeek: [],
      baseline: EMPTY_BASELINE,
    });
    expect(s.value).toBeNull();
  });
});

describe("activityScore", () => {
  const baseline: Baseline = { ...EMPTY_BASELINE, steps: 8000 };
  const day = (steps: number): StepsDay => ({
    date: "2026-09-03",
    buckets: Array.from({ length: 96 }, (_, i) => ({
      date: "2026-09-03",
      timeIndex: i,
      steps: i >= 32 && i < 80 && i % 3 === 0 ? Math.round(steps / 16) : 0,
      calories: 0,
      distanceM: 0,
    })),
    totalSteps: steps,
    totalCalories: 300,
    totalDistanceM: steps * 0.7,
    syncedAt: Date.now(),
  });

  it("has no score for a day with no steps", () => {
    expect(activityScore({ day: day(0), stepsLastWeek: [], baseline, partial: false }).value).toBeNull();
    expect(activityScore({ day: undefined, stepsLastWeek: [], baseline, partial: false }).value).toBeNull();
  });

  it("scores a typical day above a very quiet one", () => {
    const busy = activityScore({ day: day(9000), stepsLastWeek: [8000], baseline, partial: false }).value!;
    const quiet = activityScore({ day: day(1200), stepsLastWeek: [8000], baseline, partial: false }).value!;
    expect(busy).toBeGreaterThan(quiet);
  });

  it("does not judge a part-finished day as if it were over", () => {
    const partial = activityScore({ day: day(3000), stepsLastWeek: [8000], baseline, partial: true }).value!;
    const finished = activityScore({ day: day(3000), stepsLastWeek: [8000], baseline, partial: false }).value!;
    expect(partial).toBeGreaterThan(finished);
  });
});

describe("buildBaseline", () => {
  it("uses the median so one odd day cannot move it much", () => {
    const hrDays = new Map<string, HeartRateDay>();
    for (let i = 0; i < 5; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      // resting HR is derived from the lowest sustained samples
      const samples = new Array(288).fill(0).map(() => (i === 0 ? 120 : 60));
      hrDays.set(key, { date: key, intervalMinutes: 5, samples, syncedAt: Date.now() });
    }
    const b = buildBaseline(new Map(), hrDays, [], []);
    expect(b.restingHr).not.toBeNull();
    // the single 120 bpm day must not drag the median up to it
    expect(b.restingHr!).toBeLessThan(90);
  });

  it("returns nulls when there is no history", () => {
    expect(buildBaseline(new Map(), new Map(), [], [])).toEqual(EMPTY_BASELINE);
  });

  it("takes the median HRV of recent samples", () => {
    const now = Date.now();
    const hrv = [40, 50, 60].map((value, i) => ({ ts: now - i * 86_400_000, value }));
    expect(buildBaseline(new Map(), new Map(), [], hrv).hrv).toBe(50);
  });
});

describe("sessionForDate", () => {
  it("picks the night that ended on the given day", () => {
    const a = night([["light", 300]], 23, -1); // ends 2026-09-03
    const b = night([["light", 300]], 23, -2); // ends 2026-09-02
    expect(sessionForDate([a, b], "2026-09-03")).toBe(a);
    expect(sessionForDate([a, b], "2026-09-01")).toBeNull();
  });
});

describe("formatHm", () => {
  it("reads naturally either side of an hour", () => {
    expect(formatHm(45)).toBe("45m");
    expect(formatHm(60)).toBe("1h 0m");
    expect(formatHm(455)).toBe("7h 35m");
  });
});

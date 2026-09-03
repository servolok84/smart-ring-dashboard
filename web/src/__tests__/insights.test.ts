import { describe, expect, it } from "vitest";
import {
  buildWeekSummary,
  formatHours,
  positionInRange,
  restingHrForDay,
  typicalRange,
} from "../insights";
import type { HeartRateDay } from "../types";

function hrDay(samples: number[], date = "2026-09-03"): HeartRateDay {
  return { date, intervalMinutes: 5, samples, syncedAt: Date.now() };
}

describe("restingHrForDay", () => {
  it("returns null without enough samples to mean anything", () => {
    expect(restingHrForDay(undefined)).toBeNull();
    expect(restingHrForDay(hrDay([60, 61, 62]))).toBeNull();
  });

  it("tracks the sustained low, not the single lowest reading", () => {
    // 100 samples around 70, with one freak 35
    const samples = [35, ...new Array(99).fill(70)];
    expect(restingHrForDay(hrDay(samples))).toBe(70);
  });

  it("ignores zero-filled gaps where the ring recorded nothing", () => {
    const samples = [...new Array(200).fill(0), ...new Array(50).fill(58)];
    expect(restingHrForDay(hrDay(samples))).toBe(58);
  });

  it("finds a lower resting rate for a lower night", () => {
    const high = restingHrForDay(hrDay(new Array(100).fill(75)))!;
    const low = restingHrForDay(hrDay(new Array(100).fill(55)))!;
    expect(low).toBeLessThan(high);
  });
});

describe("positionInRange", () => {
  it("needs at least two points of history", () => {
    expect(positionInRange(5, [])).toBeNull();
    expect(positionInRange(5, [4])).toBeNull();
    expect(positionInRange(null, [1, 2, 3])).toBeNull();
  });

  it("never returns an invisible zero-length arc", () => {
    const p = positionInRange(1, [100, 200, 300, 400])!;
    expect(p).toBeGreaterThanOrEqual(0.1);
  });

  it("caps at 1 for a value above the usual reference", () => {
    expect(positionInRange(10_000, [10, 20, 30, 40])).toBe(1);
  });

  it("places a typical value near the top of the range", () => {
    expect(positionInRange(30, [10, 20, 30, 40])!).toBeGreaterThan(0.7);
  });
});

describe("typicalRange", () => {
  it("spans the low and high of what is known", () => {
    expect(typicalRange([7, null, 5, 9])).toEqual([5, 9]);
  });
  it("is null without enough history", () => {
    expect(typicalRange([7])).toBeNull();
  });
});

describe("formatHours", () => {
  it("reads naturally either side of an hour", () => {
    expect(formatHours(7.5)).toBe("7h 30m");
    expect(formatHours(0.75)).toBe("45m");
  });
});

describe("buildWeekSummary", () => {
  it("produces the four metrics even with no data at all", () => {
    const s = buildWeekSummary(new Map(), new Map(), [], []);
    expect(s.metrics.map((m) => m.key).sort()).toEqual(
      ["restingHr", "sleep", "spo2", "steps"].sort(),
    );
    for (const m of s.metrics) {
      expect(m.average).toBeNull();
      expect(m.daily).toHaveLength(7);
    }
  });

  it("always offers a readable observation", () => {
    const s = buildWeekSummary(new Map(), new Map(), [], []);
    expect(s.observations.length).toBeGreaterThan(0);
    for (const note of s.observations) expect(typeof note).toBe("string");
  });

  it("labels seven days", () => {
    expect(buildWeekSummary(new Map(), new Map(), [], []).dayLabels).toHaveLength(7);
  });
});

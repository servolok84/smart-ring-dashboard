/** Shared data types for ring data, storage and UI. */

export interface BatteryInfo {
  level: number;
  charging: boolean;
}

/** One 15-minute activity bucket from the ring. */
export interface ActivityBucket {
  /** Local date "YYYY-MM-DD" */
  date: string;
  /** 0..95, each = 15 minutes from midnight */
  timeIndex: number;
  steps: number;
  /** kilocalories */
  calories: number;
  /** meters */
  distanceM: number;
}

export interface StepsDay {
  date: string; // "YYYY-MM-DD"
  buckets: ActivityBucket[];
  totalSteps: number;
  totalCalories: number;
  totalDistanceM: number;
  syncedAt: number;
}

export interface HeartRateDay {
  date: string; // "YYYY-MM-DD"
  /** minutes between samples (usually 5) */
  intervalMinutes: number;
  /** 288 samples for a 5-minute interval; 0 = no reading */
  samples: number[];
  syncedAt: number;
}

export type SleepStage = "light" | "deep" | "rem" | "awake";

export interface SleepPhase {
  stage: SleepStage;
  /** epoch millis */
  start: number;
  minutes: number;
}

export interface SleepSession {
  /** epoch millis */
  start: number;
  end: number;
  phases: SleepPhase[];
  syncedAt: number;
}

export interface Spo2Hour {
  /** epoch millis at the top of the hour */
  ts: number;
  min: number;
  max: number;
}

/**
 * A spot reading from the ring's combined-sensor measurement. Which fields are
 * present depends on the ring: the Jring/56ff family reports all of them, the
 * Colmi family reports none.
 */
export interface VitalSample {
  /** epoch millis */
  ts: number;
  hrv?: number;
  stress?: number;
  fatigue?: number;
  systolic?: number;
  diastolic?: number;
}

export type RealtimeKind = "heartRate" | "spo2";

export interface LogEntry {
  ts: number;
  dir: "tx" | "rx" | "info" | "error";
  text: string;
}

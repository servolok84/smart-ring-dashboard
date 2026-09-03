/**
 * Cloud backup/sync via Supabase. Local-first: IndexedDB stays the source of
 * truth for the UI; the cloud holds a per-account copy that merges across
 * devices (row-level security keeps each user's data private).
 */

import { createClient, type Session } from "@supabase/supabase-js";
import { SUPABASE_ANON_KEY, SUPABASE_URL, cloudConfigured } from "./config";
import { loadAll, saveHrDay, saveSleepSessions, saveSpo2Hours, saveStepsDay } from "../db";
import type { HeartRateDay, SleepSession, Spo2Hour, StepsDay } from "../types";

export const supabase = cloudConfigured
  ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  : null;

export { cloudConfigured };

export async function currentSession(): Promise<Session | null> {
  if (!supabase) return null;
  const { data } = await supabase.auth.getSession();
  return data.session;
}

export async function signIn(email: string, password: string): Promise<void> {
  if (!supabase) throw new Error("cloud not configured");
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

export async function signUp(email: string, password: string): Promise<string | null> {
  if (!supabase) throw new Error("cloud not configured");
  const { data, error } = await supabase.auth.signUp({ email, password });
  if (error) throw new Error(error.message);
  // If email confirmation is enabled, there's no session yet.
  return data.session ? null : "Account created — check your email to confirm, then sign in.";
}

export async function signOut(): Promise<void> {
  await supabase?.auth.signOut();
}

/** How many records moved, so the UI can say what actually happened. */
export interface TransferCounts {
  stepsDays: number;
  hrDays: number;
  sleepSessions: number;
  spo2Hours: number;
}

export function totalRecords(counts: TransferCounts): number {
  return counts.stepsDays + counts.hrDays + counts.sleepSessions + counts.spo2Hours;
}

/** Push everything in IndexedDB up to the user's account (upsert). */
export async function pushAllToCloud(): Promise<TransferCounts> {
  const empty = { stepsDays: 0, hrDays: 0, sleepSessions: 0, spo2Hours: 0 };
  if (!supabase) return empty;
  const session = await currentSession();
  if (!session) return empty;
  const uid = session.user.id;
  const data = await loadAll();

  const results = await Promise.all([
    data.stepsDays.length
      ? supabase.from("steps_days").upsert(
          data.stepsDays.map((d) => ({
            user_id: uid,
            date: d.date,
            total_steps: d.totalSteps,
            total_calories: d.totalCalories,
            total_distance_m: d.totalDistanceM,
            buckets: d.buckets,
            synced_at: new Date(d.syncedAt).toISOString(),
          })),
        )
      : null,
    data.hrDays.length
      ? supabase.from("hr_days").upsert(
          data.hrDays.map((d) => ({
            user_id: uid,
            date: d.date,
            interval_minutes: d.intervalMinutes,
            samples: d.samples,
            synced_at: new Date(d.syncedAt).toISOString(),
          })),
        )
      : null,
    data.sleepSessions.length
      ? supabase.from("sleep_sessions").upsert(
          data.sleepSessions.map((s) => ({
            user_id: uid,
            start_ts: s.start,
            end_ts: s.end,
            phases: s.phases,
            synced_at: new Date(s.syncedAt).toISOString(),
          })),
        )
      : null,
    data.spo2Hours.length
      ? supabase.from("spo2_hours").upsert(
          data.spo2Hours.map((h) => ({ user_id: uid, ts: h.ts, min: h.min, max: h.max })),
        )
      : null,
  ]);
  for (const r of results) {
    if (r?.error) throw new Error(`cloud push failed: ${r.error.message}`);
  }
  return {
    stepsDays: data.stepsDays.length,
    hrDays: data.hrDays.length,
    sleepSessions: data.sleepSessions.length,
    spo2Hours: data.spo2Hours.length,
  };
}

/** Pull the account's data down and merge it into IndexedDB. */
export async function pullAllFromCloud(): Promise<TransferCounts> {
  const empty = { stepsDays: 0, hrDays: 0, sleepSessions: 0, spo2Hours: 0 };
  if (!supabase) return empty;
  const session = await currentSession();
  if (!session) return empty;

  const [steps, hr, sleep, spo2] = await Promise.all([
    supabase.from("steps_days").select("*"),
    supabase.from("hr_days").select("*"),
    supabase.from("sleep_sessions").select("*"),
    supabase.from("spo2_hours").select("*"),
  ]);
  const firstError = steps.error ?? hr.error ?? sleep.error ?? spo2.error;
  if (firstError) throw new Error(`cloud pull failed: ${firstError.message}`);

  for (const row of steps.data ?? []) {
    const day: StepsDay = {
      date: row.date,
      buckets: row.buckets ?? [],
      totalSteps: row.total_steps,
      totalCalories: row.total_calories,
      totalDistanceM: row.total_distance_m,
      syncedAt: Date.parse(row.synced_at) || Date.now(),
    };
    await saveStepsDay(day);
  }
  for (const row of hr.data ?? []) {
    const day: HeartRateDay = {
      date: row.date,
      intervalMinutes: row.interval_minutes,
      samples: row.samples ?? [],
      syncedAt: Date.parse(row.synced_at) || Date.now(),
    };
    await saveHrDay(day);
  }
  const sessions: SleepSession[] = (sleep.data ?? []).map((row) => ({
    start: Number(row.start_ts),
    end: Number(row.end_ts),
    phases: row.phases ?? [],
    syncedAt: Date.parse(row.synced_at) || Date.now(),
  }));
  if (sessions.length) await saveSleepSessions(sessions);
  const hours: Spo2Hour[] = (spo2.data ?? []).map((row) => ({
    ts: Number(row.ts),
    min: row.min,
    max: row.max,
  }));
  if (hours.length) await saveSpo2Hours(hours);

  return {
    stepsDays: steps.data?.length ?? 0,
    hrDays: hr.data?.length ?? 0,
    sleepSessions: sessions.length,
    spo2Hours: hours.length,
  };
}

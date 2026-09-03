/** IndexedDB persistence for synced ring data. */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { HeartRateDay, SleepSession, Spo2Hour, StepsDay, VitalSample } from "./types";

interface RingDB extends DBSchema {
  stepsDays: { key: string; value: StepsDay };
  hrDays: { key: string; value: HeartRateDay };
  sleepSessions: { key: number; value: SleepSession };
  spo2Hours: { key: number; value: Spo2Hour };
  vitals: { key: number; value: VitalSample };
  meta: { key: string; value: { key: string; value: string | number } };
}

let dbPromise: Promise<IDBPDatabase<RingDB>> | null = null;

function db(): Promise<IDBPDatabase<RingDB>> {
  dbPromise ??= openDB<RingDB>("smart-ring", 2, {
    upgrade(database, oldVersion) {
      if (oldVersion < 1) {
        database.createObjectStore("stepsDays", { keyPath: "date" });
        database.createObjectStore("hrDays", { keyPath: "date" });
        database.createObjectStore("sleepSessions", { keyPath: "start" });
        database.createObjectStore("spo2Hours", { keyPath: "ts" });
        database.createObjectStore("meta", { keyPath: "key" });
      }
      if (oldVersion < 2) {
        database.createObjectStore("vitals", { keyPath: "ts" });
      }
    },
    /**
     * Another tab (or the installed PWA) still holds an older version open, so
     * the upgrade can't proceed. Without this the open promise never settles
     * and every read silently hangs — which looks exactly like "the app has no
     * data".
     */
    blocked() {
      console.warn(
        "[db] Upgrade blocked by another open copy of this app. Close other tabs or the installed app, then reload.",
      );
    },
    /** We're the old connection in the way — step aside so the new one can upgrade. */
    blocking(_current, _blocked, event) {
      (event.target as IDBDatabase | null)?.close();
      dbPromise = null;
    },
    terminated() {
      dbPromise = null;
    },
  });
  return dbPromise;
}

export async function saveStepsDay(day: StepsDay): Promise<void> {
  await (await db()).put("stepsDays", day);
}

export async function saveHrDay(day: HeartRateDay): Promise<void> {
  await (await db()).put("hrDays", day);
}

export async function saveSleepSessions(sessions: SleepSession[]): Promise<void> {
  const tx = (await db()).transaction("sleepSessions", "readwrite");
  await Promise.all(sessions.map((s) => tx.store.put(s)));
  await tx.done;
}

export async function saveSpo2Hours(hours: Spo2Hour[]): Promise<void> {
  const tx = (await db()).transaction("spo2Hours", "readwrite");
  await Promise.all(hours.map((h) => tx.store.put(h)));
  await tx.done;
}

export async function saveVitals(samples: VitalSample[]): Promise<void> {
  if (samples.length === 0) return;
  const tx = (await db()).transaction("vitals", "readwrite");
  await Promise.all(samples.map((s) => tx.store.put(s)));
  await tx.done;
}

export async function loadAll(): Promise<{
  stepsDays: StepsDay[];
  hrDays: HeartRateDay[];
  sleepSessions: SleepSession[];
  spo2Hours: Spo2Hour[];
  vitals: VitalSample[];
  lastSync: number | null;
}> {
  const d = await db();
  const [stepsDays, hrDays, sleepSessions, spo2Hours, vitals, lastSyncRow] = await Promise.all([
    d.getAll("stepsDays"),
    d.getAll("hrDays"),
    d.getAll("sleepSessions"),
    d.getAll("spo2Hours"),
    d.getAll("vitals"),
    d.get("meta", "lastSync"),
  ]);
  return {
    stepsDays,
    hrDays,
    sleepSessions,
    spo2Hours,
    vitals,
    lastSync: lastSyncRow ? Number(lastSyncRow.value) : null,
  };
}

export async function setLastSync(ts: number): Promise<void> {
  await (await db()).put("meta", { key: "lastSync", value: ts });
}

export async function clearAllData(): Promise<void> {
  const d = await db();
  await Promise.all([
    d.clear("stepsDays"),
    d.clear("hrDays"),
    d.clear("sleepSessions"),
    d.clear("spo2Hours"),
    d.clear("vitals"),
    d.clear("meta"),
  ]);
}

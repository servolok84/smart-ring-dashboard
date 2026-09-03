import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DemoRing } from "./ble/demo";
import { connectRing } from "./ble/connect";
import { localDateKey } from "./ble/protocol";
import { RingClient, type RingLike } from "./ble/ring";
import {
  cloudConfigured,
  currentSession,
  pullAllFromCloud,
  pushAllToCloud,
  totalRecords,
  signIn,
  signOut,
  signUp,
} from "./cloud/sync";
import {
  clearAllData,
  loadAll,
  saveHrDay,
  saveSleepSessions,
  saveSpo2Hours,
  saveStepsDay,
  saveVitals,
  setLastSync,
} from "./db";
import type {
  BatteryInfo,
  HeartRateDay,
  LogEntry,
  RealtimeKind,
  SleepSession,
  SleepStage,
  Spo2Hour,
  StepsDay,
  VitalSample,
} from "./types";
import {
  HrChart,
  Hypnogram,
  Spo2Chart,
  StepsChart,
  TrendChart,
  WeekBars,
} from "./components/charts";
import { Contributors, ScoreRing, type ScoreTone } from "./components/scoreviews";
import { setupServiceWorker } from "./pwa";
import {
  buildTrends,
  buildWeekSummary,
  restingHrForDay,
  type MetricWeek,
} from "./insights";
import {
  activityBand,
  activityScore,
  buildBaseline,
  formatHm,
  readinessScore,
  scoreBand,
  sessionForDate,
  sleepBand,
  sleepDetail,
  sleepScore,
} from "./scores";

const DAYS_TO_SYNC = 7;

type TabKey = "today" | "trends" | "settings";

const TABS: { key: TabKey; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "trends", label: "Trends" },
  { key: "settings", label: "Settings" },
];

/** A small labelled figure used in the metric rows. */
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value}</span>
    </div>
  );
}

const TONE_BY_METRIC = {
  sleep: "sleep",
  restingHr: "hr",
  steps: "accent",
  spo2: "spo2",
} as const;

/**
 * Week-over-week change. Deliberately neutral in color: this app has no goals,
 * so a change is reported as a direction and a size, not as good or bad news.
 */
function WeekDelta({ metric }: { metric: MetricWeek }) {
  if (metric.average === null || metric.previousAverage === null) {
    return <span className="week-delta week-delta-muted">no comparison yet</span>;
  }
  const diff = metric.average - metric.previousAverage;
  const relative = Math.abs(diff) / Math.max(Math.abs(metric.previousAverage), 0.001);
  if (relative < 0.02) {
    return <span className="week-delta week-delta-muted">about the same</span>;
  }
  return (
    <span className="week-delta">
      <span aria-hidden>{diff > 0 ? "↑" : "↓"}</span> {metric.formatDelta(diff)}
      <span className="week-delta-period"> vs last week</span>
    </span>
  );
}

function CloudPanel({
  email,
  status,
  onSignedIn,
  onSignOut,
  onBackup,
  onRestore,
  setStatus,
}: {
  email: string | null;
  status: string | null;
  onSignedIn: (email: string) => void;
  onSignOut: () => void;
  onBackup: () => void;
  onRestore: () => void;
  setStatus: (s: string | null) => void;
}) {
  const [formEmail, setFormEmail] = useState("");
  const [formPassword, setFormPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);

  const submit = async (mode: "in" | "up") => {
    if (!formEmail || !formPassword) {
      setStatus("Enter an email and a password");
      return;
    }
    setBusy(true);
    setStatus(null);
    try {
      if (mode === "in") {
        await signIn(formEmail, formPassword);
        onSignedIn(formEmail);
      } else {
        const note = await signUp(formEmail, formPassword);
        if (note) {
          setStatus(note);
        } else {
          onSignedIn(formEmail);
        }
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (email) {
    return (
      <section className="card cloud-card">
        <div className="card-head">
          <h2>Cloud backup</h2>
          <span className="card-sub">{email}</span>
        </div>
        <div className="cloud-row">
          <button className="btn" onClick={onBackup}>
            Back up now
          </button>
          <button className="btn" onClick={onRestore}>
            Restore from cloud
          </button>
          <button className="btn subtle" onClick={onSignOut}>
            Sign out
          </button>
          {status && <span className="cloud-status">{status}</span>}
        </div>
      </section>
    );
  }

  if (!open) {
    return (
      <section className="card cloud-card">
        <div className="cloud-row">
          <span className="cloud-status">
            Cloud backup: sync your data across devices with a free account.
          </span>
          <button className="btn" onClick={() => setOpen(true)}>
            Sign in
          </button>
        </div>
      </section>
    );
  }

  return (
    <section className="card cloud-card">
      <div className="card-head">
        <h2>Cloud backup</h2>
        <span className="card-sub">sign in or create an account</span>
      </div>
      <div className="cloud-row">
        <input
          className="cloud-input"
          type="email"
          placeholder="email"
          autoComplete="email"
          value={formEmail}
          onChange={(e) => setFormEmail(e.target.value)}
        />
        <input
          className="cloud-input"
          type="password"
          placeholder="password"
          autoComplete="current-password"
          value={formPassword}
          onChange={(e) => setFormPassword(e.target.value)}
        />
        <button className="btn primary" disabled={busy} onClick={() => submit("in")}>
          Sign in
        </button>
        <button className="btn" disabled={busy} onClick={() => submit("up")}>
          Create account
        </button>
      </div>
      {status && <div className="cloud-status">{status}</div>}
    </section>
  );
}

function dateKeyDaysAgo(daysAgo: number): string {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  return localDateKey(d);
}

/** Compact step count for the day strip, so seven fit across a phone. */
function compactSteps(steps: number): string {
  if (steps <= 0) return "–";
  return steps >= 1000 ? `${(steps / 1000).toFixed(1)}k` : String(steps);
}

function fmtDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export default function App() {
  const clientRef = useRef<RingLike | null>(null);
  const [connected, setConnected] = useState(false);
  const [ringName, setRingName] = useState<string | null>(null);
  const [battery, setBattery] = useState<BatteryInfo | null>(null);
  const [isDemo, setIsDemo] = useState(false);

  const [stepsDays, setStepsDays] = useState<Map<string, StepsDay>>(new Map());
  const [hrDays, setHrDays] = useState<Map<string, HeartRateDay>>(new Map());
  const [sleepSessions, setSleepSessions] = useState<SleepSession[]>([]);
  const [spo2Hours, setSpo2Hours] = useState<Spo2Hour[]>([]);
  const [vitals, setVitals] = useState<VitalSample[]>([]);
  const [lastSync, setLastSyncState] = useState<number | null>(null);

  const [tab, setTab] = useState<TabKey>("today");
  const [openScore, setOpenScore] = useState<ScoreTone>("readiness");

  // Service worker: announce a new build rather than reloading mid-sync.
  const [updateReady, setUpdateReady] = useState(false);
  const applyUpdateRef = useRef<((reload?: boolean) => void) | null>(null);
  useEffect(() => {
    applyUpdateRef.current = setupServiceWorker(() => setUpdateReady(true));
  }, []);

  const [selectedDate, setSelectedDate] = useState(dateKeyDaysAgo(0));
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [liveKind, setLiveKind] = useState<RealtimeKind | null>(null);
  const [liveValue, setLiveValue] = useState<number | null>(null);
  const [liveHistory, setLiveHistory] = useState<number[]>([]);
  const liveKindRef = useRef<RealtimeKind | null>(null);

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [granted, setGranted] = useState<BluetoothDevice[]>([]);

  // Automatic measurement settings (persisted per device)
  const [hrIntervalMin, setHrIntervalMin] = useState(() => {
    try {
      return Number(localStorage.getItem("autoHrMin")) || 60;
    } catch {
      return 60;
    }
  });
  const [spo2IntervalH, setSpo2IntervalH] = useState(() => {
    try {
      const v = localStorage.getItem("autoSpo2H");
      return v === null ? 2 : Number(v);
    } catch {
      return 2;
    }
  });
  const [autoMeasureStatus, setAutoMeasureStatus] = useState<string | null>(null);
  const busyRef = useRef(false);

  const refreshGranted = useCallback(() => {
    RingClient.grantedDevices().then(setGranted);
  }, []);

  useEffect(refreshGranted, [refreshGranted]);

  const pushLog = useCallback((entry: LogEntry) => {
    setLogs((prev) => [...prev.slice(-499), entry]);
  }, []);

  const refreshFromDb = useCallback(async () => {
    const data = await loadAll();
    setStepsDays(new Map(data.stepsDays.map((d) => [d.date, d])));
    setHrDays(new Map(data.hrDays.map((d) => [d.date, d])));
    setSleepSessions(data.sleepSessions);
    setSpo2Hours(data.spo2Hours);
    setVitals(data.vitals);
    setLastSyncState(data.lastSync);
  }, []);

  // Load persisted data on startup
  useEffect(() => {
    refreshFromDb();
  }, [refreshFromDb]);

  // Cloud account state
  const [cloudEmail, setCloudEmail] = useState<string | null>(null);
  const [cloudStatus, setCloudStatus] = useState<string | null>(null);

  const cloudBackup = useCallback(async () => {
    setCloudStatus("Backing up…");
    try {
      const sent = totalRecords(await pushAllToCloud());
      setCloudStatus(
        sent === 0
          ? "Nothing to back up yet — sync the ring first"
          : `Backed up ${sent} records`,
      );
    } catch (err) {
      setCloudStatus(String(err instanceof Error ? err.message : err));
    }
  }, []);

  const cloudRestore = useCallback(async () => {
    setCloudStatus("Restoring…");
    try {
      const got = totalRecords(await pullAllFromCloud());
      await refreshFromDb();
      setCloudStatus(
        got === 0
          ? "This account has no data in the cloud yet"
          : `Restored ${got} records from the cloud`,
      );
    } catch (err) {
      setCloudStatus(String(err instanceof Error ? err.message : err));
    }
  }, [refreshFromDb]);

  /**
   * Both directions. Signing in used to only pull, so signing in on the device
   * that actually held the data uploaded nothing, and other devices then found
   * an empty account.
   */
  const cloudSyncBoth = useCallback(async () => {
    setCloudStatus("Syncing with cloud…");
    try {
      const got = totalRecords(await pullAllFromCloud());
      await refreshFromDb();
      const sent = totalRecords(await pushAllToCloud());
      setCloudStatus(
        got === 0 && sent === 0
          ? "Signed in — nothing stored yet, sync the ring to start"
          : `Cloud in sync — ${got} restored, ${sent} uploaded`,
      );
    } catch (err) {
      setCloudStatus(String(err instanceof Error ? err.message : err));
    }
  }, [refreshFromDb]);

  useEffect(() => {
    if (!cloudConfigured) return;
    currentSession().then((session) => {
      if (session) {
        setCloudEmail(session.user.email ?? "account");
        cloudSyncBoth();
      }
    });
  }, [cloudSyncBoth]);

  const events = useMemo(
    () => ({
      onLog: pushLog,
      onDisconnect: () => {
        setConnected(false);
        setLiveKind(null);
        liveKindRef.current = null;
      },
      onRealtimeReading: (kind: RealtimeKind, value: number) => {
        if (liveKindRef.current !== kind) return;
        setLiveValue(value);
        setLiveHistory((prev) => [...prev.slice(-59), value]);
      },
    }),
    [pushLog],
  );

  const connect = async (demo: boolean, device?: BluetoothDevice) => {
    setError(null);
    try {
      clientRef.current?.disconnect();
      let client: RingLike;
      if (demo) {
        const demoRing = new DemoRing(events);
        await demoRing.connect();
        client = demoRing;
      } else {
        client = await connectRing(events, device);
      }
      refreshGranted();
      clientRef.current = client;
      setIsDemo(demo);
      setConnected(true);
      setRingName(client.name);
      const bat = await client.getBattery();
      setBattery(bat);
      await client.setTime();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // User closing the device chooser is not an error worth showing
      if (!message.includes("cancelled") && !message.includes("chooser")) {
        setError(message);
      }
      pushLog({ ts: Date.now(), dir: "error", text: message });
    }
  };

  const disconnect = () => {
    clientRef.current?.disconnect();
    clientRef.current = null;
    setConnected(false);
    setBattery(null);
    setRingName(null);
    setLiveKind(null);
    liveKindRef.current = null;
  };

  const mergeSpo2Hours = useCallback(async (hours: Spo2Hour[]) => {
    if (hours.length === 0) return;
    await saveSpo2Hours(hours);
    setSpo2Hours((prev) => {
      const byTs = new Map(prev.map((h) => [h.ts, h]));
      for (const h of hours) byTs.set(h.ts, h);
      return [...byTs.values()].sort((a, b) => a.ts - b.ts);
    });
  }, []);

  const sync = async () => {
    const client = clientRef.current;
    if (!client || syncing) return;
    busyRef.current = true;
    setSyncing(true);
    setError(null);
    try {
      setSyncStatus("Syncing clock…");
      await client.setTime();
      setSyncStatus("Reading battery…");
      setBattery(await client.getBattery());
      setSyncStatus("Checking heart-rate logging…");
      await client.ensureHrLogging(hrIntervalMin).catch(() => {});
      if (spo2IntervalH > 0) {
        await client.setAutoSpo2?.(true).catch(() => {});
      }

      for (let offset = 0; offset < DAYS_TO_SYNC; offset++) {
        const date = dateKeyDaysAgo(offset);
        setSyncStatus(`Steps · ${date}…`);
        try {
          const buckets = await client.getActivity(offset);
          if (buckets.length > 0) {
            const day: StepsDay = {
              date,
              buckets,
              totalSteps: buckets.reduce((s, b) => s + b.steps, 0),
              totalCalories: buckets.reduce((s, b) => s + b.calories, 0),
              totalDistanceM: buckets.reduce((s, b) => s + b.distanceM, 0),
              syncedAt: Date.now(),
            };
            await saveStepsDay(day);
            setStepsDays((prev) => new Map(prev).set(date, day));
          }
        } catch (err) {
          pushLog({ ts: Date.now(), dir: "error", text: `steps ${date}: ${err}` });
        }

        setSyncStatus(`Heart rate · ${date}…`);
        try {
          const d = new Date();
          d.setDate(d.getDate() - offset);
          const log = await client.getHeartRateLog(d);
          if (log) {
            const day: HeartRateDay = {
              date,
              intervalMinutes: log.intervalMinutes,
              samples: log.samples,
              syncedAt: Date.now(),
            };
            await saveHrDay(day);
            setHrDays((prev) => new Map(prev).set(date, day));
          }
        } catch (err) {
          pushLog({ ts: Date.now(), dir: "error", text: `hr ${date}: ${err}` });
        }
      }

      setSyncStatus("Blood oxygen history…");
      try {
        await mergeSpo2Hours(await client.getSpo2());
      } catch (err) {
        pushLog({ ts: Date.now(), dir: "error", text: `spo2: ${err}` });
      }

      setSyncStatus("HRV and stress readings…");
      try {
        const samples = (await client.getVitals?.()) ?? [];
        if (samples.length > 0) {
          await saveVitals(samples);
          setVitals((prev) => {
            const byTs = new Map(prev.map((v) => [v.ts, v]));
            for (const s of samples) byTs.set(s.ts, s);
            return [...byTs.values()].sort((a, b) => a.ts - b.ts);
          });
        }
      } catch (err) {
        pushLog({ ts: Date.now(), dir: "error", text: `vitals: ${err}` });
      }

      setSyncStatus("Sleep history…");
      try {
        const sessions = await client.getSleep();
        if (sessions.length > 0) {
          await saveSleepSessions(sessions);
          setSleepSessions((prev) => {
            const byStart = new Map(prev.map((s) => [s.start, s]));
            for (const s of sessions) byStart.set(s.start, s);
            return [...byStart.values()].sort((a, b) => a.start - b.start);
          });
        }
      } catch (err) {
        pushLog({ ts: Date.now(), dir: "error", text: `sleep: ${err}` });
      }

      const now = Date.now();
      await setLastSync(now);
      setLastSyncState(now);
      setSyncStatus(null);

      // Back up the fresh data to the cloud account, if signed in
      if (cloudEmail) {
        pushAllToCloud().catch((err) =>
          pushLog({ ts: Date.now(), dir: "error", text: `cloud push: ${err}` }),
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSyncStatus(null);
    } finally {
      busyRef.current = false;
      setSyncing(false);
    }
  };

  // Persist auto-measure settings and apply them to the ring when they change
  useEffect(() => {
    try {
      localStorage.setItem("autoHrMin", String(hrIntervalMin));
      localStorage.setItem("autoSpo2H", String(spo2IntervalH));
    } catch {
      // storage unavailable; settings just won't persist
    }
    const client = clientRef.current;
    if (!client || !connected) return;
    client.ensureHrLogging(hrIntervalMin).catch(() => {});
    client.setAutoSpo2?.(spo2IntervalH > 0).catch(() => {});
  }, [hrIntervalMin, spo2IntervalH, connected]);

  // App-driven SpO2 schedule: while connected, run a spot measurement on the
  // chosen cadence (the ring itself can't be relied on to schedule SpO2).
  useEffect(() => {
    if (!connected || spo2IntervalH <= 0) return;
    const timer = setInterval(async () => {
      const client = clientRef.current;
      if (!client || busyRef.current || liveKindRef.current) return;
      busyRef.current = true;
      setAutoMeasureStatus("Measuring SpO2…");
      try {
        await client.startRealtime("spo2");
        await new Promise((r) => setTimeout(r, 50_000));
        await client.stopRealtime();
        await mergeSpo2Hours(await client.getSpo2());
        setAutoMeasureStatus(
          `Last automatic SpO2: ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`,
        );
      } catch (err) {
        setAutoMeasureStatus(`Automatic SpO2 failed: ${err}`);
      } finally {
        busyRef.current = false;
      }
    }, spo2IntervalH * 3_600_000);
    return () => clearInterval(timer);
  }, [connected, spo2IntervalH, mergeSpo2Hours]);

  const toggleLive = async (kind: RealtimeKind) => {
    const client = clientRef.current;
    if (!client) return;
    if (liveKind === kind) {
      liveKindRef.current = null;
      setLiveKind(null);
      setLiveValue(null);
      await client.stopRealtime();
      return;
    }
    setLiveHistory([]);
    setLiveValue(null);
    liveKindRef.current = kind;
    setLiveKind(kind);
    try {
      await client.startRealtime(kind);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      liveKindRef.current = null;
      setLiveKind(null);
    }
  };

  // ---------------------------------------------------------- derived data

  const daySteps = stepsDays.get(selectedDate);
  const dayHr = hrDays.get(selectedDate);
  const daySpo2 = useMemo(
    () => spo2Hours.filter((h) => localDateKey(new Date(h.ts)) === selectedDate),
    [spo2Hours, selectedDate],
  );
  const stepsByBucket = useMemo(() => {
    const arr = new Array(96).fill(0);
    daySteps?.buckets.forEach((b) => {
      if (b.timeIndex >= 0 && b.timeIndex < 96) arr[b.timeIndex] += b.steps;
    });
    return arr;
  }, [daySteps]);

  const hrStats = useMemo(() => {
    const valid = (dayHr?.samples ?? []).filter((v) => v > 0);
    if (valid.length === 0) return null;
    return {
      min: Math.min(...valid),
      max: Math.max(...valid),
      avg: Math.round(valid.reduce((s, v) => s + v, 0) / valid.length),
    };
  }, [dayHr]);

  const spo2Stats = useMemo(() => {
    if (daySpo2.length === 0) return null;
    return {
      min: Math.min(...daySpo2.map((h) => h.min)),
      max: Math.max(...daySpo2.map((h) => h.max)),
    };
  }, [daySpo2]);

  const week = useMemo(
    () => buildWeekSummary(stepsDays, hrDays, sleepSessions, spo2Hours),
    [stepsDays, hrDays, sleepSessions, spo2Hours],
  );

  /** The selected day's headline numbers. */
  const today = useMemo(
    () => ({
      resting: restingHrForDay(dayHr),
      steps: daySteps?.totalSteps ?? null,
      spo2: daySpo2.length
        ? daySpo2.reduce((s, h) => s + (h.min + h.max) / 2, 0) / daySpo2.length
        : null,
    }),
    [dayHr, daySteps, daySpo2],
  );

  /** HRV, stress and blood pressure recorded on the selected day. */
  const dayVitals = useMemo(() => {
    const day = vitals.filter((v) => localDateKey(new Date(v.ts)) === selectedDate);
    const avg = (pick: (v: VitalSample) => number | undefined) => {
      const values = day.map(pick).filter((n): n is number => typeof n === "number");
      return values.length ? values.reduce((s, v) => s + v, 0) / values.length : null;
    };
    const systolic = avg((v) => v.systolic);
    const diastolic = avg((v) => v.diastolic);
    return {
      hrv: avg((v) => v.hrv),
      stress: avg((v) => v.stress),
      bp:
        systolic !== null && diastolic !== null
          ? `${Math.round(systolic)}/${Math.round(diastolic)}`
          : null,
    };
  }, [vitals, selectedDate]);

  const hrvSamples = useMemo(
    () =>
      vitals
        .filter((v): v is VitalSample & { hrv: number } => typeof v.hrv === "number")
        .map((v) => ({ ts: v.ts, value: v.hrv })),
    [vitals],
  );

  const baseline = useMemo(
    () => buildBaseline(stepsDays, hrDays, sleepSessions, hrvSamples),
    [stepsDays, hrDays, sleepSessions, hrvSamples],
  );

  /** Sleep / Readiness / Activity for the selected day. */
  const scores = useMemo(() => {
    const session = sessionForDate(sleepSessions, selectedDate);
    const sleep = sleepScore(session, baseline);

    const sleepLastWeekHours = week.metrics
      .find((m) => m.key === "sleep")!
      .daily.filter((v): v is number => v !== null);
    const stepsLastWeek = week.metrics
      .find((m) => m.key === "steps")!
      .daily.filter((v): v is number => v !== null);

    // HRV for the selected day: the mean of that day's spot readings.
    const dayHrv = hrvSamples.filter((s) => localDateKey(new Date(s.ts)) === selectedDate);
    const hrv = dayHrv.length
      ? dayHrv.reduce((s, v) => s + v.value, 0) / dayHrv.length
      : null;

    const readiness = readinessScore({
      restingHr: restingHrForDay(dayHr),
      hrv,
      lastNight: sleep,
      sleepLastWeekHours,
      stepsLastWeek,
      baseline,
    });

    const activity = activityScore({
      day: daySteps,
      stepsLastWeek,
      baseline,
      partial: selectedDate === dateKeyDaysAgo(0),
    });

    return { sleep, readiness, activity, session };
  }, [sleepSessions, selectedDate, baseline, week, hrvSamples, dayHr, daySteps]);

  const sleepInfo = useMemo(
    () => (scores.session ? sleepDetail(scores.session) : null),
    [scores.session],
  );

  const trends = useMemo(
    () => buildTrends(stepsDays, hrDays, sleepSessions, spo2Hours),
    [stepsDays, hrDays, sleepSessions, spo2Hours],
  );

  const weekChips = useMemo(
    () =>
      Array.from({ length: 7 }, (_, i) => {
        const key = dateKeyDaysAgo(6 - i);
        const d = new Date();
        d.setDate(d.getDate() - (6 - i));
        return {
          key,
          label: 6 - i === 0 ? "Today" : d.toLocaleDateString([], { weekday: "short" }),
          steps: stepsDays.get(key)?.totalSteps ?? 0,
        };
      }),
    [stepsDays],
  );

  const hasAnyData =
    stepsDays.size > 0 || hrDays.size > 0 || sleepSessions.length > 0 || spo2Hours.length > 0;

  // ---------------------------------------------------------- render

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-dot" aria-hidden />
          <h1>Ring Dashboard</h1>
        </div>
        <div className="topbar-actions">
          {connected && (
            <span className="status-chip" title={ringName ?? ""}>
              <span className={`dot ${isDemo ? "dot-demo" : "dot-live"}`} />
              {ringName}
              {battery && (
                <span className="battery">
                  {battery.level}%{battery.charging ? " ⚡" : ""}
                </span>
              )}
            </span>
          )}
          {connected ? (
            <>
              <button className="btn primary" onClick={sync} disabled={syncing}>
                {syncing ? "Syncing…" : "Sync now"}
              </button>
              <button className="btn" onClick={disconnect}>
                Disconnect
              </button>
            </>
          ) : (
            <>
              <button className="btn primary" onClick={() => connect(false)}>
                Connect ring
              </button>
              <button className="btn" onClick={() => connect(true)}>
                Demo mode
              </button>
            </>
          )}
        </div>
      </header>

      {error && (
        <div className="banner error" role="alert">
          {error}
          <button className="banner-close" onClick={() => setError(null)}>
            ✕
          </button>
        </div>
      )}
      {updateReady && (
        <div className="banner update-banner">
          A new version of the app is ready.
          <button
            className="btn primary"
            onClick={() => applyUpdateRef.current?.(true)}
            disabled={syncing || liveKind !== null}
            title={
              syncing || liveKind !== null
                ? "Finish the current measurement first"
                : undefined
            }
          >
            Reload
          </button>
        </div>
      )}
      {syncStatus && <div className="banner info">{syncStatus}</div>}
      {!connected && !hasAnyData && (
        <div className="banner info">
          Put the ring on its charger for a second to wake it, then hit <b>Connect ring</b> and
          pick it from the list (usually named like <code>R02_xxxx</code> or similar). Works in
          Chrome/Edge. No hardware handy? Try <b>Demo mode</b>.
        </div>
      )}

      {!connected && granted.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h2>Known devices</h2>
            <span className="card-sub">already allowed in Chrome for this site</span>
          </div>
          <div className="device-list">
            {granted.map((device) => (
              <div key={device.id} className="device-row">
                <span className="device-name">{device.name ?? "(unnamed device)"}</span>
                <button className="btn primary" onClick={() => connect(false, device)}>
                  Connect
                </button>
                <button
                  className="btn"
                  onClick={async () => {
                    await device.forget();
                    refreshGranted();
                    pushLog({ ts: Date.now(), dir: "info", text: `Forgot ${device.name ?? device.id}` });
                  }}
                >
                  Forget
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <nav className="tabs" role="tablist" aria-label="Sections">
        {TABS.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={`tab ${tab === t.key ? "tab-active" : ""}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </nav>

      {tab === "today" && (
        <>
          <nav className="day-chips" aria-label="Select day">
            {weekChips.map((chip) => (
              <button
                key={chip.key}
                className={`chip ${chip.key === selectedDate ? "chip-active" : ""}`}
                onClick={() => setSelectedDate(chip.key)}
              >
                <span className="chip-label">{chip.label}</span>
                <span className="chip-value">{compactSteps(chip.steps)}</span>
              </button>
            ))}
          </nav>

          <section className="card scores-card">
            <div className="card-head">
              <h2>
                {selectedDate === dateKeyDaysAgo(0)
                  ? "Today"
                  : new Date(`${selectedDate}T00:00:00`).toLocaleDateString([], {
                      weekday: "long",
                      day: "numeric",
                      month: "long",
                    })}
              </h2>
              <span className="card-sub">tap a ring for the breakdown</span>
            </div>
            <div className="scores-row">
              <ScoreRing
                tone="readiness"
                score={scores.readiness.value}
                label="Readiness"
                band={scoreBand(scores.readiness.value)}
                selected={openScore === "readiness"}
                onClick={() => setOpenScore("readiness")}
              />
              <ScoreRing
                tone="sleep"
                score={scores.sleep.value}
                label="Sleep"
                band={sleepBand(scores.sleep.value)}
                selected={openScore === "sleep"}
                onClick={() => setOpenScore("sleep")}
              />
              <ScoreRing
                tone="activity"
                score={scores.activity.value}
                label="Activity"
                band={activityBand(scores.activity.value)}
                selected={openScore === "activity"}
                onClick={() => setOpenScore("activity")}
              />
            </div>
            <div className="scores-detail">
              <h3 className="scores-detail-title">
                What went into {openScore === "readiness" ? "Readiness" : openScore === "sleep" ? "Sleep" : "Activity"}
              </h3>
              <Contributors score={scores[openScore]} tone={openScore} />
            </div>
            <p className="scores-note">
              Scores are computed on this device from your ring's readings using simple,
              documented rules — they are not medical measurements.
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Sleep</h2>
              <span className="card-sub">
                {sleepInfo
                  ? `${new Date(sleepInfo.start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })} – ${new Date(sleepInfo.end).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                  : "night ending this day"}
              </span>
            </div>
            {sleepInfo && scores.session ? (
              <>
                <div className="metric-row">
                  <Stat label="Asleep" value={formatHm(sleepInfo.asleepMinutes)} />
                  <Stat label="In bed" value={formatHm(sleepInfo.inBedMinutes)} />
                  <Stat label="Efficiency" value={`${Math.round(sleepInfo.efficiency * 100)}%`} />
                  <Stat
                    label="Fell asleep in"
                    value={sleepInfo.latencyMinutes > 0 ? formatHm(sleepInfo.latencyMinutes) : "—"}
                  />
                  <Stat
                    label="Wake-ups"
                    value={`${sleepInfo.wakeEpisodes}`}
                  />
                </div>
                <Hypnogram session={scores.session} />
                <div className="sleep-legend">
                  {(["deep", "light", "rem", "awake"] as SleepStage[]).map((stage) => {
                    const minutes =
                      stage === "deep"
                        ? sleepInfo.deepMinutes
                        : stage === "light"
                          ? sleepInfo.lightMinutes
                          : stage === "rem"
                            ? sleepInfo.remMinutes
                            : sleepInfo.awakeMinutes;
                    return (
                      <span key={stage} className="legend-item">
                        <span className={`legend-swatch sleep-${stage}`} />
                        {stage === "rem" ? "REM" : stage[0].toUpperCase() + stage.slice(1)}{" "}
                        {fmtDuration(minutes)}
                      </span>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="empty-block">No sleep recorded for this night — sync the ring</div>
            )}
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Heart rate</h2>
              <span className="card-sub">5-minute samples</span>
            </div>
            <div className="metric-row">
              <Stat
                label="Resting"
                value={today.resting === null ? "–" : `${today.resting} bpm`}
              />
              <Stat label="Average" value={hrStats ? `${hrStats.avg} bpm` : "–"} />
              <Stat
                label="Range"
                value={hrStats ? `${hrStats.min}–${hrStats.max}` : "–"}
              />
              <Stat label="HRV" value={dayVitals.hrv === null ? "–" : `${Math.round(dayVitals.hrv)} ms`} />
            </div>
            <HrChart samples={dayHr?.samples ?? new Array(288).fill(0)} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Activity</h2>
              <span className="card-sub">per 15 minutes</span>
            </div>
            <div className="metric-row">
              <Stat
                label="Steps"
                value={daySteps ? daySteps.totalSteps.toLocaleString() : "–"}
              />
              <Stat
                label="Distance"
                value={daySteps ? `${(daySteps.totalDistanceM / 1000).toFixed(1)} km` : "–"}
              />
              <Stat
                label="Calories"
                value={daySteps ? `${daySteps.totalCalories.toLocaleString()} kcal` : "–"}
              />
            </div>
            <StepsChart stepsByBucket={stepsByBucket} />
          </section>

          <section className="card">
            <div className="card-head">
              <h2>Blood oxygen</h2>
              <span className="card-sub">hourly min–max</span>
            </div>
            <div className="metric-row">
              <Stat
                label="Average"
                value={today.spo2 === null ? "–" : `${today.spo2.toFixed(1)}%`}
              />
              <Stat
                label="Range"
                value={spo2Stats ? `${spo2Stats.min}–${spo2Stats.max}%` : "–"}
              />
              <Stat
                label="Stress"
                value={dayVitals.stress === null ? "–" : `${Math.round(dayVitals.stress)}`}
              />
              <Stat
                label="Blood pressure"
                value={dayVitals.bp ?? "–"}
              />
            </div>
            <Spo2Chart hours={daySpo2} />
          </section>
        </>
      )}

      {tab === "trends" && (
        <>
      <section className="card week-card">
        <div className="card-head">
          <h2>Your week</h2>
          <span className="card-sub">compared with the 7 days before</span>
        </div>
        <ul className="week-notes">
          {week.observations.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
        <div className="week-metrics">
          {week.metrics.map((metric) => (
            <div key={metric.key} className="week-metric">
              <div className="week-metric-head">
                <span className="week-metric-label">{metric.label}</span>
                <span className="week-metric-line">
                  <span className="week-metric-avg">
                    {metric.average === null ? "–" : metric.format(metric.average)}
                  </span>
                  <WeekDelta metric={metric} />
                </span>
              </div>
              <WeekBars
                values={metric.daily}
                labels={week.dayLabels}
                tone={TONE_BY_METRIC[metric.key]}
                format={metric.format}
              />
            </div>
          ))}
        </div>
      </section>

          {trends.map((series) => (
            <section key={series.key} className="card">
              <div className="card-head">
                <h2>{series.label}</h2>
                <span className="card-sub">last 30 days</span>
              </div>
              <TrendChart
                points={series.points}
                tone={TONE_BY_METRIC[series.key]}
                format={series.format}
                formatAxis={series.formatAxis}
                zeroBased={series.zeroBased}
              />
            </section>
          ))}
        </>
      )}

      {tab === "settings" && (
        <>
      {connected && (
        <section className="card live-card">
          <div className="card-head">
            <h2>Live measurement</h2>
            <div className="live-actions">
              <button
                className={`btn ${liveKind === "heartRate" ? "primary" : ""}`}
                onClick={() => toggleLive("heartRate")}
              >
                {liveKind === "heartRate" ? "Stop heart rate" : "Heart rate"}
              </button>
              <button
                className={`btn ${liveKind === "spo2" ? "primary" : ""}`}
                onClick={() => toggleLive("spo2")}
              >
                {liveKind === "spo2" ? "Stop SpO2" : "SpO2"}
              </button>
            </div>
          </div>
          {liveKind && (
            <div className="live-reading">
              <span className={`live-value ${liveKind === "spo2" ? "spo2-ink" : "hr-ink"}`}>
                {liveValue ?? "…"}
              </span>
              <span className="live-unit">{liveKind === "spo2" ? "% SpO2" : "bpm"}</span>
              {liveValue === null && <span className="live-hint">measuring — keep still…</span>}
              <svg viewBox="0 0 240 48" className="sparkline" aria-hidden>
                {liveHistory.length > 1 && (
                  <polyline
                    fill="none"
                    className={liveKind === "spo2" ? "spo2-line" : "hr-line"}
                    points={liveHistory
                      .map((v, i) => {
                        const lo = Math.min(...liveHistory) - 2;
                        const hi = Math.max(...liveHistory) + 2;
                        const x = (i / (liveHistory.length - 1)) * 240;
                        const y = 46 - ((v - lo) / (hi - lo)) * 44;
                        return `${x.toFixed(1)},${y.toFixed(1)}`;
                      })
                      .join(" ")}
                  />
                )}
              </svg>
            </div>
          )}
        </section>
      )}

      {connected && (
        <section className="card">
          <div className="card-head">
            <h2>Automatic measurements</h2>
            <span className="card-sub">applied to the ring on every connect</span>
          </div>
          <div className="auto-row">
            <label className="auto-field">
              Heart rate
              <select
                className="auto-select"
                value={hrIntervalMin}
                onChange={(e) => setHrIntervalMin(Number(e.target.value))}
              >
                <option value={15}>every 15 min</option>
                <option value={30}>every 30 min</option>
                <option value={60}>every hour</option>
                <option value={120}>every 2 hours</option>
              </select>
            </label>
            <label className="auto-field">
              Blood oxygen
              <select
                className="auto-select"
                value={spo2IntervalH}
                onChange={(e) => setSpo2IntervalH(Number(e.target.value))}
              >
                <option value={0}>off</option>
                <option value={1}>every hour</option>
                <option value={2}>every 2 hours</option>
                <option value={4}>every 4 hours</option>
              </select>
            </label>
            <span className="auto-note">
              Heart rate is measured by the ring itself, even while disconnected. SpO2 runs
              on schedule while this app is connected{autoMeasureStatus ? ` · ${autoMeasureStatus}` : ""}.
            </span>
          </div>
        </section>
      )}

      {cloudConfigured && (
        <CloudPanel
          email={cloudEmail}
          status={cloudStatus}
          onSignedIn={(email) => {
            setCloudEmail(email);
            cloudSyncBoth();
          }}
          onSignOut={async () => {
            await signOut();
            setCloudEmail(null);
            setCloudStatus(null);
          }}
          onBackup={cloudBackup}
          onRestore={cloudRestore}
          setStatus={setCloudStatus}
        />
      )}

      <footer className="footer">
        <span>
          {lastSync
            ? `Last sync ${new Date(lastSync).toLocaleString()}`
            : "Never synced"}
        </span>
        <button
          className="btn subtle"
          onClick={async () => {
            const data = await loadAll();
            const blob = new Blob(
              [JSON.stringify({ exportedAt: new Date().toISOString(), ...data }, null, 2)],
              { type: "application/json" },
            );
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `smartring-export-${localDateKey(new Date())}.json`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Export data
        </button>
        <button
          className="btn subtle"
          onClick={async () => {
            if (confirm("Delete all locally stored ring data?")) {
              await clearAllData();
              setStepsDays(new Map());
              setHrDays(new Map());
              setSleepSessions([]);
              setSpo2Hours([]);
              setLastSyncState(null);
            }
          }}
        >
          Clear local data
        </button>
      </footer>

      <details className="log-panel">
        <summary>Packet log ({logs.length})</summary>
        <div className="log-body">
          {logs.map((entry, i) => (
            <div key={i} className={`log-line log-${entry.dir}`}>
              <span className="log-ts">
                {new Date(entry.ts).toLocaleTimeString([], { hour12: false })}
              </span>
              <span className="log-dir">{entry.dir.toUpperCase()}</span>
              <span className="log-text">{entry.text}</span>
            </div>
          ))}
          {logs.length === 0 && <div className="log-line">No packets yet</div>}
        </div>
      </details>
        </>
      )}
    </div>
  );
}

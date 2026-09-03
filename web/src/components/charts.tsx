/**
 * Lightweight SVG charts for the dashboard. No chart library — each chart is
 * a few dozen lines and uses the CSS custom properties defined in index.css.
 */

import { useMemo, useRef, useState } from "react";
import type { SleepSession, SleepStage, Spo2Hour } from "../types";

const W = 720;
const H = 180;
const PAD = { left: 34, right: 8, top: 12, bottom: 20 };
const plotW = W - PAD.left - PAD.right;
const plotH = H - PAD.top - PAD.bottom;

function hourLabel(h: number): string {
  if (h === 0 || h === 24) return "12am";
  if (h === 12) return "12pm";
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

interface TooltipState {
  x: number;
  y: number;
  lines: string[];
}

function useTooltip() {
  const [tip, setTip] = useState<TooltipState | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  /** Convert a client event position into SVG viewBox coordinates. */
  const toSvgX = (clientX: number): number => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return 0;
    return ((clientX - rect.left) / rect.width) * W;
  };
  return { tip, setTip, ref, toSvgX };
}

function Tooltip({ tip }: { tip: TooltipState | null }) {
  if (!tip) return null;
  const width = 8 + Math.max(...tip.lines.map((l) => l.length)) * 6.6;
  const height = 8 + tip.lines.length * 15;
  const x = Math.min(Math.max(tip.x - width / 2, PAD.left), W - PAD.right - width);
  const y = Math.max(tip.y - height - 10, 2);
  return (
    <g pointerEvents="none">
      <rect x={x} y={y} width={width} height={height} rx={5} className="tip-box" />
      {tip.lines.map((line, i) => (
        <text key={i} x={x + width / 2} y={y + 15 + i * 15} textAnchor="middle" className="tip-text">
          {line}
        </text>
      ))}
    </g>
  );
}

function XAxisHours() {
  return (
    <>
      {[0, 6, 12, 18, 24].map((h) => (
        <text
          key={h}
          x={PAD.left + (h / 24) * plotW}
          y={H - 5}
          textAnchor="middle"
          className="axis-text"
        >
          {hourLabel(h)}
        </text>
      ))}
    </>
  );
}

// ---------------------------------------------------------------- dial

/**
 * Circular gauge. `fraction` is where the value sits inside the user's own
 * recent range — not progress toward a goal, since the app deliberately has
 * none. Pass null when there's nothing to place.
 */
export function Dial({
  fraction,
  value,
  caption,
  tone,
  size = 132,
  hero = false,
  label,
}: {
  fraction: number | null;
  value: React.ReactNode;
  caption: string;
  tone: "accent" | "hr" | "spo2" | "sleep";
  size?: number;
  /** Renders the value at hero scale. At most one per view. */
  hero?: boolean;
  /** Accessible text for the value when it's rich markup. */
  label?: string;
}) {
  const stroke = 8;
  const r = (size - stroke) / 2 - 2;
  const cx = size / 2;
  const cy = size / 2;
  // 270° sweep starting at the lower-left (135°) going clockwise.
  const sweep = 270;
  const start = 135;
  const circumference = 2 * Math.PI * r;
  const trackLength = (circumference * sweep) / 360;
  const filled = fraction === null ? 0 : Math.max(0.02, Math.min(1, fraction)) * trackLength;

  return (
    <div className={`dial ${hero ? "dial-hero" : ""}`} style={{ width: size }}>
      <svg
        viewBox={`0 0 ${size} ${size}`}
        width={size}
        height={size}
        role="img"
        aria-label={`${caption}: ${label ?? (typeof value === "string" ? value : "")}`}
      >
        <circle
          cx={cx}
          cy={cy}
          r={r}
          className="dial-track"
          strokeWidth={stroke}
          strokeDasharray={`${trackLength} ${circumference}`}
          transform={`rotate(${start} ${cx} ${cy})`}
        />
        {fraction !== null && (
          <circle
            cx={cx}
            cy={cy}
            r={r}
            className={`dial-fill dial-${tone}`}
            strokeWidth={stroke}
            strokeDasharray={`${filled} ${circumference}`}
            transform={`rotate(${start} ${cx} ${cy})`}
          />
        )}
      </svg>
      <div className="dial-text">
        <span className="dial-value">{value}</span>
        <span className="dial-caption">{caption}</span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sparkline

/** Seven-day mini bars for the weekly summary. Missing days show as a faint tick. */
export function WeekBars({
  values,
  labels,
  tone,
  format,
}: {
  values: (number | null)[];
  labels: string[];
  tone: "accent" | "hr" | "spo2" | "sleep";
  format: (v: number) => string;
}) {
  const present = values.filter((v): v is number => v !== null);
  const max = present.length ? Math.max(...present) : 1;
  // Start the scale a little below the lowest value so differences stay visible
  // on metrics like resting heart rate that never approach zero.
  const min = present.length ? Math.min(...present) : 0;
  const floor = min - (max - min) * 0.6 - (max === min ? max * 0.1 || 1 : 0);
  const span = Math.max(max - floor, 0.0001);

  return (
    <div className="week-bars">
      {values.map((v, i) => (
        <div
          key={i}
          className="week-bar-slot"
          title={v === null ? `${labels[i]}: no data` : `${labels[i]}: ${format(v)}`}
        >
          <span className="week-bar-track">
            {v === null ? (
              <span className="week-bar-empty" />
            ) : (
              <span
                className={`week-bar week-bar-${tone}`}
                style={{ height: `${Math.max(8, ((v - floor) / span) * 100)}%` }}
              />
            )}
          </span>
          <span className="week-bar-label">{labels[i]}</span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- trend

/** Longer-range daily trend: one bar per day with a hover readout. */
export function TrendChart({
  points,
  tone,
  format,
  formatAxis,
  zeroBased = false,
}: {
  points: { label: string; value: number | null }[];
  tone: "accent" | "hr" | "spo2" | "sleep";
  format: (v: number) => string;
  /** Short form for axis ticks; falls back to `format`. */
  formatAxis?: (v: number) => string;
  /** Steps start at zero; heart rate and SpO2 read better on a tight scale. */
  zeroBased?: boolean;
}) {
  const axisLabel = formatAxis ?? format;
  const { tip, setTip, ref, toSvgX } = useTooltip();
  const present = points
    .map((p) => p.value)
    .filter((v): v is number => v !== null);

  if (present.length === 0) {
    return (
      <div className="empty-block">Not enough history yet — keep syncing for a few days.</div>
    );
  }

  const high = Math.max(...present);
  const low = Math.min(...present);
  const floor = zeroBased ? 0 : Math.max(0, low - (high - low) * 0.35 - 0.001);
  const ceiling = high + (high - floor) * 0.08;
  const span = Math.max(ceiling - floor, 1e-6);

  const slot = plotW / points.length;
  const barW = Math.min(22, slot - 3);
  const yFor = (v: number) => PAD.top + plotH - ((v - floor) / span) * plotH;

  const onMove = (e: React.MouseEvent) => {
    const i = Math.floor((toSvgX(e.clientX) - PAD.left) / slot);
    const point = i >= 0 && i < points.length ? points[i] : null;
    if (!point || point.value === null) {
      setTip(null);
      return;
    }
    setTip({
      x: PAD.left + i * slot + slot / 2,
      y: yFor(point.value),
      lines: [point.label, format(point.value)],
    });
  };

  return (
    <svg
      ref={ref}
      viewBox={`0 0 ${W} ${H}`}
      className="chart"
      role="img"
      aria-label="Daily trend"
      onMouseMove={onMove}
      onMouseLeave={() => setTip(null)}
    >
      {[floor, (floor + ceiling) / 2, ceiling].map((v, i) => (
        <g key={i}>
          <line x1={PAD.left} x2={W - PAD.right} y1={yFor(v)} y2={yFor(v)} className="gridline" />
          <text x={PAD.left - 6} y={yFor(v) + 4} textAnchor="end" className="axis-text">
            {axisLabel(v)}
          </text>
        </g>
      ))}
      {points.map((p, i) =>
        p.value === null ? null : (
          <rect
            key={i}
            x={PAD.left + i * slot + (slot - barW) / 2}
            y={yFor(p.value)}
            width={Math.max(1.5, barW)}
            height={Math.max(2, PAD.top + plotH - yFor(p.value))}
            rx={3}
            className={`trend-bar trend-${tone}`}
          />
        ),
      )}
      {/* Label only the ends, so the axis stays quiet. */}
      <text x={PAD.left} y={H - 5} textAnchor="start" className="axis-text">
        {points[0]?.label}
      </text>
      <text x={W - PAD.right} y={H - 5} textAnchor="end" className="axis-text">
        {points[points.length - 1]?.label}
      </text>
      <Tooltip tip={tip} />
    </svg>
  );
}

// ---------------------------------------------------------------- heart rate

export function HrChart({ samples }: { samples: number[] }) {
  const { tip, setTip, ref, toSvgX } = useTooltip();

  const { segments, min, max } = useMemo(() => {
    const valid = samples.filter((v) => v > 0);
    const lo = valid.length ? Math.min(...valid) : 40;
    const hi = valid.length ? Math.max(...valid) : 120;
    const min = Math.max(30, Math.floor((lo - 5) / 10) * 10);
    const max = Math.ceil((hi + 5) / 10) * 10;
    const x = (i: number) => PAD.left + (i / 287) * plotW;
    const y = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;
    const segments: string[] = [];
    let path = "";
    samples.forEach((v, i) => {
      if (v > 0) {
        path += `${path ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      } else if (path) {
        segments.push(path);
        path = "";
      }
    });
    if (path) segments.push(path);
    return { segments, min, max };
  }, [samples]);

  const yFor = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;

  const onMove = (e: React.MouseEvent) => {
    const sx = toSvgX(e.clientX);
    const i = Math.round(((sx - PAD.left) / plotW) * 287);
    if (i < 0 || i > 287 || samples[i] <= 0) {
      setTip(null);
      return;
    }
    const minutes = i * 5;
    const hh = Math.floor(minutes / 60);
    const mm = `${minutes % 60}`.padStart(2, "0");
    setTip({
      x: PAD.left + (i / 287) * plotW,
      y: yFor(samples[i]),
      lines: [`${hh}:${mm}`, `${samples[i]} bpm`],
    });
  };

  const hasData = segments.length > 0;
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Heart rate through the day" onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      {[min, Math.round((min + max) / 2), max].map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={yFor(v)} y2={yFor(v)} className="gridline" />
          <text x={PAD.left - 6} y={yFor(v) + 4} textAnchor="end" className="axis-text">
            {v}
          </text>
        </g>
      ))}
      <XAxisHours />
      {segments.map((d, i) => (
        <path key={i} d={d} fill="none" className="hr-line" />
      ))}
      {!hasData && (
        <text x={W / 2} y={H / 2} textAnchor="middle" className="empty-text">
          No heart-rate data for this day — sync the ring
        </text>
      )}
      {tip && <circle cx={tip.x} cy={tip.y} r={4} className="hr-dot" />}
      <Tooltip tip={tip} />
    </svg>
  );
}

// ---------------------------------------------------------------- steps

export function StepsChart({ stepsByBucket }: { stepsByBucket: number[] }) {
  const { tip, setTip, ref, toSvgX } = useTooltip();
  const max = Math.max(100, ...stepsByBucket);
  const barW = plotW / 96;
  const yFor = (v: number) => PAD.top + plotH - (v / max) * plotH;

  const onMove = (e: React.MouseEvent) => {
    const sx = toSvgX(e.clientX);
    const i = Math.floor((sx - PAD.left) / barW);
    if (i < 0 || i > 95 || !stepsByBucket[i]) {
      setTip(null);
      return;
    }
    const startMin = i * 15;
    const hh = Math.floor(startMin / 60);
    const mm = `${startMin % 60}`.padStart(2, "0");
    setTip({
      x: PAD.left + i * barW + barW / 2,
      y: yFor(stepsByBucket[i]),
      lines: [`${hh}:${mm}`, `${stepsByBucket[i].toLocaleString()} steps`],
    });
  };

  const hasData = stepsByBucket.some((v) => v > 0);
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Steps per 15 minutes" onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      {[0, max].map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={yFor(v)} y2={yFor(v)} className="gridline" />
          <text x={PAD.left - 6} y={yFor(v) + 4} textAnchor="end" className="axis-text">
            {v >= 1000 ? `${(v / 1000).toFixed(1)}k` : v}
          </text>
        </g>
      ))}
      <XAxisHours />
      {stepsByBucket.map((v, i) =>
        v > 0 ? (
          <rect
            key={i}
            x={PAD.left + i * barW + 1}
            y={yFor(v)}
            width={Math.max(1, barW - 2)}
            height={PAD.top + plotH - yFor(v)}
            rx={2}
            className="steps-bar"
          />
        ) : null,
      )}
      {!hasData && (
        <text x={W / 2} y={H / 2} textAnchor="middle" className="empty-text">
          No step data for this day — sync the ring
        </text>
      )}
      <Tooltip tip={tip} />
    </svg>
  );
}

// ---------------------------------------------------------------- SpO2

export function Spo2Chart({ hours }: { hours: Spo2Hour[] }) {
  const { tip, setTip, ref, toSvgX } = useTooltip();
  const min = 88;
  const max = 100;
  const barW = plotW / 24;
  const yFor = (v: number) => PAD.top + plotH - ((v - min) / (max - min)) * plotH;
  const byHour = useMemo(() => {
    const arr: (Spo2Hour | null)[] = new Array(24).fill(null);
    for (const h of hours) arr[new Date(h.ts).getHours()] = h;
    return arr;
  }, [hours]);

  const onMove = (e: React.MouseEvent) => {
    const sx = toSvgX(e.clientX);
    const i = Math.floor((sx - PAD.left) / barW);
    const h = i >= 0 && i < 24 ? byHour[i] : null;
    if (!h) {
      setTip(null);
      return;
    }
    setTip({
      x: PAD.left + i * barW + barW / 2,
      y: yFor(h.max),
      lines: [`${hourLabel(i)}`, h.min === h.max ? `${h.min}%` : `${h.min}–${h.max}%`],
    });
  };

  const hasData = byHour.some(Boolean);
  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Blood oxygen range per hour" onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      {[90, 95, 100].map((v) => (
        <g key={v}>
          <line x1={PAD.left} x2={W - PAD.right} y1={yFor(v)} y2={yFor(v)} className="gridline" />
          <text x={PAD.left - 6} y={yFor(v) + 4} textAnchor="end" className="axis-text">
            {v}%
          </text>
        </g>
      ))}
      <XAxisHours />
      {byHour.map((h, i) => {
        if (!h) return null;
        const top = yFor(h.max);
        const height = Math.max(4, yFor(h.min) - top);
        return (
          <rect
            key={i}
            x={PAD.left + i * barW + barW * 0.25}
            y={top}
            width={barW * 0.5}
            height={height}
            rx={2}
            className="spo2-bar"
          />
        );
      })}
      {!hasData && (
        <text x={W / 2} y={H / 2} textAnchor="middle" className="empty-text">
          No SpO2 data for this day — sync the ring
        </text>
      )}
      <Tooltip tip={tip} />
    </svg>
  );
}

// ---------------------------------------------------------------- sleep

const STAGE_ROW: Record<SleepStage, number> = { awake: 0, rem: 1, light: 2, deep: 3 };
const STAGE_LABEL: Record<SleepStage, string> = {
  awake: "Awake",
  rem: "REM",
  light: "Light",
  deep: "Deep",
};

export function Hypnogram({ session }: { session: SleepSession }) {
  const { tip, setTip, ref, toSvgX } = useTooltip();
  const left = 50;
  const rowH = plotH / 4;
  const span = session.end - session.start;
  const xFor = (ts: number) => left + ((ts - session.start) / span) * (W - left - PAD.right);

  const fmt = (ts: number) =>
    new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  const onMove = (e: React.MouseEvent) => {
    const sx = toSvgX(e.clientX);
    const ts = session.start + ((sx - left) / (W - left - PAD.right)) * span;
    const phase = session.phases.find((p) => ts >= p.start && ts < p.start + p.minutes * 60_000);
    if (!phase) {
      setTip(null);
      return;
    }
    setTip({
      x: (xFor(phase.start) + xFor(phase.start + phase.minutes * 60_000)) / 2,
      y: PAD.top + STAGE_ROW[phase.stage] * rowH,
      lines: [
        `${STAGE_LABEL[phase.stage]} · ${phase.minutes} min`,
        `${fmt(phase.start)} – ${fmt(phase.start + phase.minutes * 60_000)}`,
      ],
    });
  };

  return (
    <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="chart" role="img" aria-label="Sleep stages through the night" onMouseMove={onMove} onMouseLeave={() => setTip(null)}>
      {(Object.keys(STAGE_ROW) as SleepStage[]).map((stage) => (
        <text
          key={stage}
          x={left - 6}
          y={PAD.top + STAGE_ROW[stage] * rowH + rowH / 2 + 4}
          textAnchor="end"
          className="axis-text"
        >
          {STAGE_LABEL[stage]}
        </text>
      ))}
      {session.phases.map((p, i) => {
        const x = xFor(p.start);
        const width = Math.max(1.5, xFor(p.start + p.minutes * 60_000) - x - 1);
        const y = PAD.top + STAGE_ROW[p.stage] * rowH + 4;
        return (
          <rect
            key={i}
            x={x}
            y={y}
            width={width}
            height={rowH - 8}
            rx={3}
            className={`sleep-${p.stage}`}
          />
        );
      })}
      {[session.start, session.start + span / 2, session.end].map((ts, i) => (
        <text
          key={i}
          x={i === 0 ? left : i === 1 ? left + (W - left - PAD.right) / 2 : W - PAD.right}
          y={H - 5}
          textAnchor={i === 0 ? "start" : i === 1 ? "middle" : "end"}
          className="axis-text"
        >
          {fmt(ts)}
        </text>
      ))}
      <Tooltip tip={tip} />
    </svg>
  );
}

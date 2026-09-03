/** Score rings and their contributor breakdowns. */

import type { Contributor, Score } from "../scores";

export type ScoreTone = "readiness" | "sleep" | "activity";

/**
 * A full-circle score ring. Unlike the range dials on the day view, a score
 * genuinely runs 0–100, so a full sweep is the honest shape here.
 */
export function ScoreRing({
  score,
  label,
  band,
  tone,
  size = 116,
  selected = false,
  onClick,
}: {
  score: number | null;
  label: string;
  band: string;
  tone: ScoreTone;
  size?: number;
  selected?: boolean;
  onClick?: () => void;
}) {
  const stroke = 9;
  const r = (size - stroke) / 2 - 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const filled = score === null ? 0 : (Math.max(2, score) / 100) * circumference;

  const content = (
    <>
      <div className="score-ring-graphic" style={{ width: size, height: size }}>
        <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden>
          <circle cx={c} cy={c} r={r} className="score-track" strokeWidth={stroke} />
          {score !== null && (
            <circle
              cx={c}
              cy={c}
              r={r}
              className={`score-fill score-${tone}`}
              strokeWidth={stroke}
              strokeDasharray={`${filled} ${circumference}`}
              transform={`rotate(-90 ${c} ${c})`}
            />
          )}
        </svg>
        <span className="score-number">{score ?? "–"}</span>
      </div>
      <span className="score-label">{label}</span>
      <span className="score-band">{band}</span>
    </>
  );

  if (!onClick) {
    return <div className="score-ring">{content}</div>;
  }
  return (
    <button
      type="button"
      className={`score-ring score-ring-button ${selected ? "score-ring-selected" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${label} score ${score ?? "unavailable"}, ${band}`}
    >
      {content}
    </button>
  );
}

/** The list of what fed a score, each with its own sub-score bar. */
export function Contributors({ score, tone }: { score: Score; tone: ScoreTone }) {
  const shown = score.contributors.filter((c) => c.detail);
  if (shown.length === 0) {
    return <p className="contrib-empty">Nothing recorded for this day yet.</p>;
  }
  return (
    <div className="contrib-list">
      {shown.map((c) => (
        <ContributorRow key={c.key} contributor={c} tone={tone} />
      ))}
      {score.coverage < 0.999 && (
        <p className="contrib-note">
          Based on {Math.round(score.coverage * 100)}% of the usual inputs — the rest had no
          data, so they were left out rather than counted against you.
        </p>
      )}
    </div>
  );
}

function ContributorRow({
  contributor,
  tone,
}: {
  contributor: Contributor;
  tone: ScoreTone;
}) {
  const { label, score, detail } = contributor;
  return (
    <div className="contrib-row">
      <div className="contrib-head">
        <span className="contrib-label">{label}</span>
        <span className="contrib-detail">{detail}</span>
      </div>
      <div className="contrib-meter" role="img" aria-label={score === null ? "no data" : `${Math.round(score)} out of 100`}>
        {score !== null && (
          <span className={`contrib-fill contrib-${tone}`} style={{ width: `${score}%` }} />
        )}
      </div>
    </div>
  );
}

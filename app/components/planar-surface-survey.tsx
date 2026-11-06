"use client";

import { useState } from "react";
import {
  buildPlanarSurfaceSurveyEntry,
  inspectPlanarBoundary,
  metadataIssue,
  normalizePreviewPoint,
  PLANAR_CORNER_LABELS,
  type PlanarSurfaceSurveyEntry,
  type PlanarSurveyFrame,
  type PlanarSurveyPoint,
} from "./planar-surface-survey-model";

export type PlanarSurfaceSurveyProps = {
  previewUrl: string;
  frame: PlanarSurveyFrame;
  surveyId: string;
  wallId: string;
  cameraViewId: string;
  lensProfileSha256: string;
  disabled?: boolean;
  onBoundaryChange?: (boundary: readonly PlanarSurveyPoint[]) => void;
  onSurveyChange?: (survey: PlanarSurfaceSurveyEntry | null) => void;
  onConfirm: (survey: PlanarSurfaceSurveyEntry) => void | Promise<void>;
};

type SurveyDraft = {
  scope: string;
  points: PlanarSurveyPoint[];
  error: string | null;
  confirming: boolean;
};

function percent(value: number) {
  return `${Math.max(0, Math.min(100, value * 100))}%`;
}

export function PlanarSurfaceSurvey({
  previewUrl,
  frame,
  surveyId,
  wallId,
  cameraViewId,
  lensProfileSha256,
  disabled = false,
  onBoundaryChange,
  onSurveyChange,
  onConfirm,
}: PlanarSurfaceSurveyProps) {
  const metadata = { id: surveyId, wallId, cameraViewId, frame, lensProfileSha256 };
  const scope = [previewUrl, frame.width, frame.height, surveyId, wallId, cameraViewId, lensProfileSha256].join("\u0000");
  const [draft, setDraft] = useState<SurveyDraft>({ scope, points: [], error: null, confirming: false });
  const active = draft.scope === scope
    ? draft
    : { scope, points: [], error: null, confirming: false };
  const issue = metadataIssue(metadata) || (previewUrl.trim() ? null : "A survey preview frame is required.");
  const inspection = inspectPlanarBoundary(active.points);
  const complete = inspection.valid;
  const nextCorner = PLANAR_CORNER_LABELS[active.points.length];
  const survey = complete ? buildPlanarSurfaceSurveyEntry(metadata, active.points) : null;

  const publish = (points: PlanarSurveyPoint[], error: string | null = null) => {
    setDraft({ scope, points, error, confirming: false });
    onBoundaryChange?.(points);
    onSurveyChange?.(points.length === PLANAR_CORNER_LABELS.length
      && inspectPlanarBoundary(points).valid
      ? buildPlanarSurfaceSurveyEntry(metadata, points)
      : null);
  };

  const selectCorner = (event: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || issue || active.points.length >= PLANAR_CORNER_LABELS.length) return;
    if (event.detail === 0) {
      setDraft({ ...active, error: "Corner selection requires a pointer on the survey image." });
      return;
    }
    const rectangle = event.currentTarget.getBoundingClientRect();
    const point = normalizePreviewPoint(event.clientX, event.clientY, rectangle);
    if (!point) {
      setDraft({ ...active, error: "The preview dimensions are invalid; no corner was recorded." });
      return;
    }
    const candidate = [...active.points, point];
    if (candidate.length === PLANAR_CORNER_LABELS.length) {
      const candidateInspection = inspectPlanarBoundary(candidate);
      if (!candidateInspection.valid) {
        setDraft({ ...active, error: candidateInspection.reason });
        return;
      }
    }
    publish(candidate);
  };

  const undo = () => {
    if (active.confirming || active.points.length === 0) return;
    publish(active.points.slice(0, -1));
  };

  const reset = () => {
    if (active.confirming) return;
    publish([]);
  };

  const confirm = async () => {
    if (!survey || disabled || active.confirming) return;
    setDraft({ ...active, error: null, confirming: true });
    try {
      await onConfirm(survey);
      setDraft((current) => current.scope === scope ? { ...current, confirming: false } : current);
    } catch (error) {
      setDraft((current) => current.scope === scope ? {
        ...current,
        confirming: false,
        error: error instanceof Error ? error.message : "The wall boundary was not accepted.",
      } : current);
    }
  };

  const linePoints = active.points.map((point) => `${point.x * 100},${point.y * 100}`).join(" ");

  return (
    <section className="planar-survey panel" aria-labelledby="planar-survey-title">
      <header className="planar-survey-head">
        <div>
          <p className="eyebrow">MARKERLESS PLANAR-WALL SURVEY</p>
          <h2 id="planar-survey-title">Choose the intended wall boundary</h2>
          <p>Click exactly four visible corners in <b>TL → TR → BR → BL</b> order. No physical marker is required at the venue.</p>
        </div>
        <span className={complete ? "ready" : "pending"}>
          {complete ? "BOUNDARY READY" : nextCorner ? `NEXT · ${nextCorner}` : "WAITING"}
        </span>
      </header>

      <div className="planar-survey-facts" aria-label="Survey constraints">
        <span><b>WALL</b>{wallId || "—"}</span>
        <span><b>CAMERA VIEW</b>{cameraViewId || "—"}</span>
        <span><b>FRAME</b>{frame.width} × {frame.height}</span>
        <span><b>LENS PROFILE</b>{/^[a-f0-9]{64}$/i.test(lensProfileSha256) ? "VERIFIED DIGEST" : "REQUIRED"}</span>
      </div>

      <div className="planar-survey-stage-shell" style={{ aspectRatio: `${Math.max(1, frame.width)} / ${Math.max(1, frame.height)}` }}>
        <button
          type="button"
          className={`planar-survey-stage${complete ? " complete" : ""}`}
          onClick={selectCorner}
          disabled={disabled || Boolean(issue) || complete}
          aria-describedby="planar-survey-instructions"
          aria-label={nextCorner ? `Select ${nextCorner} wall corner on the survey preview` : "Planar wall boundary complete"}
        >
          {/* A dynamic helper/blob URL must remain usable without a remote-image allowlist. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={previewUrl} alt={`Fixed camera survey view for wall ${wallId}`} draggable={false} />
          <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            {active.points.length >= 2 && <polyline points={linePoints} />}
            {complete && <polygon points={linePoints} />}
          </svg>
          {active.points.map((point, index) => (
            <span
              className="planar-survey-corner"
              key={`${index}-${point.x}-${point.y}`}
              style={{ left: percent(point.x), top: percent(point.y) }}
            >
              {PLANAR_CORNER_LABELS[index]}
            </span>
          ))}
        </button>
      </div>

      <p id="planar-survey-instructions" className="planar-survey-instructions">
        Planar wall only · one fixed camera view/session · fixed focus and zoom · validated lens profile required. Curved or discontinuous surfaces need a dense room/surface model and cannot use this four-corner tool.
      </p>

      {(issue || active.error) && <div className="planar-survey-error" role="alert">{issue || active.error}</div>}

      <footer className="planar-survey-actions">
        <span>{active.points.length}/4 corners · normalized frame coordinates 0…1</span>
        <button type="button" onClick={undo} disabled={disabled || active.confirming || active.points.length === 0}>Undo</button>
        <button type="button" onClick={reset} disabled={disabled || active.confirming || active.points.length === 0}>Reset</button>
        <button type="button" className="accept" onClick={confirm} disabled={disabled || active.confirming || !survey}>
          {active.confirming ? "Saving boundary…" : "Use this wall boundary"}
        </button>
      </footer>
    </section>
  );
}

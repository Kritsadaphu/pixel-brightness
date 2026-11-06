"use client";

import { useState } from "react";
import type {
  PixelCameraCalibration,
  PixelCameraSurveyPreviewCapture,
  PixelCameraSurveyPreviewRequest,
} from "../lib/pixel-server";
import {
  MarkerlessCameraSetup,
  type MarkerlessCalibrationSetup,
} from "./markerless-camera-setup";

type CalibrationOutput = { id: string };

type CameraCalibrationPanelProps = {
  outputs: CalibrationOutput[];
  selectedOutputIds: string[];
  wallId: string;
  serverConnected: boolean;
  nodeId?: string;
  cameraReady: boolean;
  calibration?: PixelCameraCalibration | null;
  running: boolean;
  busy?: string | null;
  onControl: (setup: MarkerlessCalibrationSetup | null) => void | Promise<void>;
  onCaptureSurveyPreview: (request: PixelCameraSurveyPreviewRequest) => Promise<PixelCameraSurveyPreviewCapture>;
  onConfirm: (stepId: string, confirmationId: string) => boolean | Promise<boolean>;
  onStartVerification: () => boolean | Promise<boolean>;
  onCancelVerification: () => boolean | Promise<boolean>;
  onConfirmVerification: (stepId: string, confirmationId: string) => boolean | Promise<boolean>;
};

type RecordValue = Record<string, unknown>;

const TERMINAL_STATES = new Set(["complete", "failed", "cancelled"]);

const REFERENCE_PROMPTS: Record<string, { title: string; detail: string }> = {
  "sensor-dark": {
    title: "Sensor-dark reference",
    detail: "Fit the opaque lens cap when prompted. Do not move the camera, lens, tripod or USB cable.",
  },
  "projectors-off-ambient": {
    title: "Ambient-light reference",
    detail: "Remove the lens cap, switch projector optical output off, and leave the room lighting unchanged.",
  },
  "projector-black": {
    title: "Projector-black reference",
    detail: "Keep warmed projectors on at digital black. Do not change ambient light between this and the long pass.",
  },
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}

function finiteNumber(value: unknown, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function text(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function passLabel(value: unknown) {
  const normalized = text(value).toLowerCase();
  if (normalized.includes("geometry")) return "SHORT GEOMETRY PASS";
  if (normalized.includes("radiometr") || normalized.includes("black")) return "LONG RADIOMETRY PASS";
  if (normalized.includes("reference") || normalized.includes("ambient") || normalized.includes("dark")) return "REFERENCE CAPTURE";
  return normalized ? normalized.replaceAll("-", " ").toUpperCase() : "CAPTURE SEQUENCE";
}

function referencePrompt(kind: string) {
  return REFERENCE_PROMPTS[kind] ?? {
    title: kind.replaceAll("-", " "),
    detail: "Confirm the requested physical capture condition before the sequence continues.",
  };
}

export function CameraCalibrationPanel({
  outputs,
  selectedOutputIds,
  wallId,
  serverConnected,
  nodeId,
  cameraReady,
  calibration,
  running,
  busy,
  onControl,
  onCaptureSurveyPreview,
  onConfirm,
  onStartVerification,
  onCancelVerification,
  onConfirmVerification,
}: CameraCalibrationPanelProps) {
  const [locallyQueuedConfirmationId, setLocallyQueuedConfirmationId] = useState<string | null>(null);
  const [locallyQueuedOpticalConfirmationId, setLocallyQueuedOpticalConfirmationId] = useState<string | null>(null);
  const [markerlessSetup, setMarkerlessSetup] = useState<MarkerlessCalibrationSetup | null>(null);
  const state = text(calibration?.state) || "idle";
  const progress = record(calibration?.progress);
  const completedSteps = Math.max(0, finiteNumber(progress.completedSteps));
  const totalSteps = Math.max(0, finiteNumber(progress.totalSteps));
  const plan = record(calibration?.plan);
  const steps = Array.isArray(plan.steps) ? plan.steps.map(record) : [];
  const completedStepCount = Math.max(0, Math.min(steps.length, Math.floor(completedSteps)));
  const plannedCaptures = steps.reduce((sum, step) => sum + (step.capture === true
    ? Math.max(0, Math.floor(finiteNumber(step.repeats))) : 0), 0);
  const inferredCompletedCaptures = steps.slice(0, completedStepCount).reduce((sum, step) => sum + (step.capture === true
    ? Math.max(0, Math.floor(finiteNumber(step.repeats))) : 0), 0);
  const totalCaptures = Math.max(plannedCaptures, finiteNumber(progress.totalCaptures, plannedCaptures));
  const completedCaptures = Math.max(0, Math.min(totalCaptures,
    finiteNumber(progress.completedCaptures, inferredCompletedCaptures)));
  const percent = totalCaptures > 0
    ? Math.max(0, Math.min(100, completedCaptures / totalCaptures * 100))
    : totalSteps > 0 ? Math.max(0, Math.min(100, completedSteps / totalSteps * 100)) : 0;
  const livePrompt = record(calibration?.operatorPrompt);
  const promptState = text(livePrompt.state).toLowerCase();
  const promptStepId = text(livePrompt.stepId);
  const promptConfirmationId = text(livePrompt.confirmationId);
  const progressStepId = promptStepId || text(progress.currentStepId) || text(progress.stepId);
  const stepIndex = Math.max(-1, Math.round(finiteNumber(progress.currentStepIndex, finiteNumber(progress.stepIndex, -1))));
  const currentStep = progressStepId
    ? steps.find((step) => text(step.id) === progressStepId) ?? {}
    : stepIndex >= 0 ? record(steps[stepIndex]) : {};
  const captureConditions = record(currentStep.captureConditions);
  const currentPassId = text(progress.passId)
    || text(progress.currentPassId)
    || text(currentStep.passId)
    || text(currentStep.exposureProfileId)
    || text(progress.phase);
  const referenceKind = text(progress.referenceKind)
    || text(currentStep.referenceKind)
    || text(captureConditions.referenceKind);
  const operatorPrompt = text(livePrompt.instructions)
    || text(progress.operatorPrompt)
    || text(captureConditions.operatorPrompt);
  const requiresConfirmation = promptState
    ? promptState === "waiting" || promptState === "confirmation-queued"
    : progress.requiresOperatorConfirmation === true
      || currentStep.requiresOperatorConfirmation === true
      || captureConditions.requiresOperatorConfirmation === true;

  const manifest = record(calibration?.manifest);
  const manifestOutputs = Array.isArray(manifest.outputs) ? manifest.outputs.map(record) : [];
  const applicable = manifest.applicable === true && manifest.provenance === "measured";
  const everyArtifact = (key: string) => manifestOutputs.length > 0
    && manifestOutputs.every((output) => Object.keys(record(record(output.artifacts)[key])).length > 0);
  const geometryArtifactReady = everyArtifact("warp") && everyArtifact("blendWeight") && everyArtifact("mask");
  const radiometryArtifactReady = everyArtifact("blackPedestal") && manifestOutputs.every((output) => (
    Array.isArray(record(record(output.artifacts).gamma).rgb)
  ));
  const lutColorimetric = manifestOutputs.length > 0 && manifestOutputs.every((output) => (
    text(record(record(output.artifacts).lut).status).toLowerCase() === "measured"
      && record(output.radiometry).colorimetric === true
  ));
  const lutCameraRelative = manifestOutputs.length > 0 && manifestOutputs.every((output) => (
    text(record(record(output.artifacts).lut).status).toLowerCase() === "measured-relative"
      && record(output.radiometry).colorimetric === false
      && text(record(output.radiometry).colorBasis).toLowerCase() === "camera-relative-rgb"
  ));
  const identityFallback = manifestOutputs.length > 0 && manifestOutputs.some((output) => {
    const status = text(record(record(output.artifacts).lut).status).toLowerCase();
    return status === "identity-fallback";
  });
  const projectCommitted = calibration?.projectCommitted === true;
  const rendererAcknowledged = calibration?.rendererAcknowledged === true;
  const opticalVerification = record(calibration?.opticalVerification);
  const opticalRuntimeCandidate = record(opticalVerification.runtime);
  const opticalRuntime = Object.keys(opticalRuntimeCandidate).length > 0
    ? opticalRuntimeCandidate
    : opticalVerification;
  const opticalVerificationState = text(opticalRuntime.state || opticalVerification.state).toLowerCase();
  const opticalVerificationReason = text(opticalRuntime.failure && record(opticalRuntime.failure).message)
    || text(opticalRuntime.rollback && record(opticalRuntime.rollback).reason)
    || text(opticalVerification.reason);
  const opticalProgress = record(opticalRuntime.progress);
  const opticalCompletedSteps = Math.max(0, finiteNumber(opticalProgress.completedSteps));
  const opticalTotalSteps = Math.max(0, finiteNumber(opticalProgress.totalSteps));
  const opticalPercent = opticalTotalSteps > 0
    ? Math.max(0, Math.min(100, opticalCompletedSteps / opticalTotalSteps * 100))
    : 0;
  const opticalPrompt = record(opticalRuntime.operatorPrompt);
  const opticalPromptState = text(opticalPrompt.state).toLowerCase();
  const opticalPromptStepId = text(opticalPrompt.stepId);
  const opticalPromptConfirmationId = text(opticalPrompt.confirmationId);
  const opticalRollback = record(opticalRuntime.rollback);
  const opticalActive = new Set([
    "queued", "preflight", "waiting-operator", "capturing", "evaluating",
    "rolling-back", "rollback-renderer-ack",
  ]).has(opticalVerificationState);
  const explicitlyVerified = opticalVerificationState === "verified";
  const applied = projectCommitted && applicable;

  const outputCount = Math.max(1, selectedOutputIds.length);
  const geometryEstimate = `${3 * outputCount}–${6 * outputCount} min`;
  const radiometryEstimate = `${8 * outputCount}–${15 * outputCount} min`;
  const actionBusy = busy === "camera-calibration"
    || busy === "camera-calibration-cancel"
    || busy === "camera-calibration-confirm"
    || busy === "camera-optical-verification"
    || busy === "camera-optical-verification-cancel"
    || busy === "camera-optical-verification-confirm";
  const opticalActionBusy = busy === "camera-optical-verification"
    || busy === "camera-optical-verification-cancel"
    || busy === "camera-optical-verification-confirm";
  const canStartOpticalVerification = state === "complete" && applied && rendererAcknowledged
    && opticalVerificationState === "pending-optical-capture";
  const disabled = !serverConnected || !nodeId || selectedOutputIds.length === 0 || actionBusy
    || opticalActive || (!running && markerlessSetup == null);
  const progressLabel = totalCaptures > 0
    ? `${completedCaptures}/${totalCaptures} captures acknowledged · ${completedSteps}/${totalSteps || "—"} steps`
    : `${completedSteps}/${totalSteps || "—"} steps acknowledged`;
  const confirmationQueued = promptState === "confirmation-queued"
    || (Boolean(promptConfirmationId) && locallyQueuedConfirmationId === promptConfirmationId);
  const confirmPhysicalState = async () => {
    if (!promptStepId || !promptConfirmationId || confirmationQueued) return;
    setLocallyQueuedConfirmationId(promptConfirmationId);
    const accepted = await onConfirm(promptStepId, promptConfirmationId);
    if (!accepted) setLocallyQueuedConfirmationId(null);
  };
  const opticalConfirmationQueued = opticalPromptState === "confirmation-queued"
    || (Boolean(opticalPromptConfirmationId)
      && locallyQueuedOpticalConfirmationId === opticalPromptConfirmationId);
  const confirmOpticalPhysicalState = async () => {
    if (!opticalPromptStepId || !opticalPromptConfirmationId || opticalConfirmationQueued) return;
    setLocallyQueuedOpticalConfirmationId(opticalPromptConfirmationId);
    const accepted = await onConfirmVerification(opticalPromptStepId, opticalPromptConfirmationId);
    if (!accepted) setLocallyQueuedOpticalConfirmationId(null);
  };

  let statusClass = "waiting";
  let statusTitle = "MEASURED CAMERA ADAPTER NOT READY";
  let statusDetail = "Connect the supported camera adapter. Start must fail before projector takeover when capture is unavailable.";
  if (state === "failed") {
    statusClass = "error";
    statusTitle = `FAILED · ${calibration?.failure?.code ?? "CALIBRATION_FAILED"}`;
    statusDetail = calibration?.failure?.message ?? "The node rejected calibration safely.";
  } else if (state === "cancelled") {
    statusTitle = "CANCELLED · OUTPUT SAFETY STATE MUST BE CONFIRMED";
    statusDetail = "Do not resume content until the render node reports its final output state.";
  } else if (state === "complete" && applied) {
    statusClass = explicitlyVerified ? "ready" : "warning";
    if (opticalVerificationState === "rollback-blocked") {
      statusClass = "error";
      statusTitle = `ROLLBACK BLOCKED · REVISION ${calibration?.appliedRevision ?? "—"} IS NOT VERIFIED`;
      statusDetail = opticalVerificationReason
        || "The project changed or the exact pre-apply snapshot cannot be restored automatically. Keep content stopped and resolve this manually.";
    } else if (opticalVerificationState === "rolled-back") {
      statusClass = "error";
      statusTitle = `VERIFICATION FAILED · PRE-APPLY REVISION RESTORED AS ${opticalRollback.targetRevision ?? "—"}`;
      statusDetail = "The failed calibrated outputs were replaced with the exact pre-apply snapshot, the renderer acknowledged that new revision, and content restore was acknowledged.";
    } else if (["rolling-back", "rollback-renderer-ack"].includes(opticalVerificationState)) {
      statusClass = "warning";
      statusTitle = opticalVerificationState === "rolling-back"
        ? "VERIFICATION FAILED · COMMITTING PRE-APPLY SNAPSHOT"
        : `ROLLBACK COMMITTED · WAITING FOR RENDERER / CONTENT ACK · REVISION ${opticalRollback.targetRevision ?? "—"}`;
      statusDetail = "Do not resume or edit the project. Rollback is incomplete until the exact renderer revision and final content restore are both acknowledged.";
    } else if (opticalVerificationState === "failed") {
      statusClass = "error";
      statusTitle = `OPTICAL VERIFICATION FAILED · REVISION ${calibration?.appliedRevision ?? "—"}`;
      statusDetail = opticalVerificationReason || "The deterministic optical gates failed; automatic rollback must complete before content resumes.";
    } else if (opticalVerificationState === "blocked") {
      statusClass = "error";
      statusTitle = `OPTICAL VERIFICATION BLOCKED · REVISION ${calibration?.appliedRevision ?? "—"} IS NOT VERIFIED`;
      statusDetail = opticalVerificationReason || "The physical recapture could not produce an authoritative report. The applied revision remains unverified.";
    } else if (opticalVerificationState === "cancelled") {
      statusClass = "warning";
      statusTitle = `OPTICAL VERIFICATION CANCELLED · REVISION ${calibration?.appliedRevision ?? "—"} IS NOT VERIFIED`;
      statusDetail = "Cancellation is not a pass. Confirm the renderer safety state before starting another verification.";
    } else if (opticalVerificationState === "superseded") {
      statusClass = "warning";
      statusTitle = `CALIBRATION SUPERSEDED · CURRENT PROJECT REVISION ${opticalVerification.supersededByRevision ?? "—"}`;
      statusDetail = "This result belongs to an older project revision and cannot be verified or reused as current evidence.";
    } else if (opticalActive) {
      statusClass = opticalVerificationState === "waiting-operator" ? "warning" : "active";
      statusTitle = opticalVerificationState === "waiting-operator"
        ? "OPTICAL VERIFICATION · OPERATOR CONFIRMATION REQUIRED"
        : `OPTICAL VERIFICATION · ${opticalVerificationState.replaceAll("-", " ").toUpperCase()} · ${opticalCompletedSteps}/${opticalTotalSteps || "—"}`;
      statusDetail = text(opticalPrompt.instructions)
        || "The camera is recapturing the applied correction. Renderer acknowledgement alone is not counted as a pass.";
    } else if (!rendererAcknowledged) {
      statusTitle = `PROJECT COMMITTED · WAITING FOR RENDERER ACK · REVISION ${calibration?.appliedRevision ?? "—"}`;
      statusDetail = "The Server committed the revision, but the Windows renderer has not acknowledged that revision yet. Optical verification cannot start.";
    } else if (explicitlyVerified && lutColorimetric) {
      statusTitle = `FULL CALIBRATION VERIFIED · REVISION ${calibration?.appliedRevision ?? "—"}`;
      statusDetail = "The renderer acknowledged the committed revision, optical recapture is explicitly verified, and a characterized target-space colour LUT is measured.";
    } else if (explicitlyVerified && lutCameraRelative) {
      statusTitle = `GEOMETRY / RADIOMETRY VERIFIED · CAMERA-RELATIVE RGB · REVISION ${calibration?.appliedRevision ?? "—"}`;
      statusDetail = "Optical verification passed. RGB response is equalized to this camera, but it is not spectral or target-space colorimetry.";
    } else if (explicitlyVerified) {
      statusTitle = `GEOMETRY / RADIOMETRY VERIFIED · COLOR PENDING · REVISION ${calibration?.appliedRevision ?? "—"}`;
      statusDetail = "Spatial and radiometric verification passed, but colour remains an identity fallback and is not calibrated.";
    } else {
      statusTitle = `RENDERER ACKNOWLEDGED · OPTICAL VERIFICATION REQUIRED · REVISION ${calibration?.appliedRevision ?? "—"}`;
      statusDetail = identityFallback
        ? "The acknowledged revision contains warp, blend and available radiometric artifacts; colour 3D LUT remains an identity fallback. Nothing is labelled optically verified yet."
        : "The renderer acknowledged the committed artifacts, but no successful post-apply camera recapture is recorded yet.";
    }
  } else if (state === "complete") {
    statusTitle = calibration?.mode === "simulation" ? "DRY RUN FINISHED · NOT APPLIED" : "CAPTURE FINISHED · PROJECT NOT APPLIED";
    statusDetail = "A terminal capture state is not proof that a measured revision reached the renderer.";
  } else if (running && !TERMINAL_STATES.has(state)) {
    statusClass = requiresConfirmation ? "warning" : "active";
    statusTitle = confirmationQueued
      ? `CONFIRMATION QUEUED · WAITING FOR NODE · ${passLabel(currentPassId || referenceKind)}`
      : requiresConfirmation
        ? `OPERATOR CONFIRMATION REQUIRED · ${passLabel(currentPassId || referenceKind)}`
      : `${passLabel(currentPassId)} · ${progressLabel.toUpperCase()}`;
    statusDetail = operatorPrompt || (referenceKind
      ? referencePrompt(referenceKind).detail
      : `Session ${calibration?.sessionId ?? "—"} · Node ${calibration?.nodeId ?? nodeId ?? "—"} · ${state.replaceAll("-", " ")}`);
  } else if (cameraReady) {
    statusClass = "ready";
    statusTitle = "REMOTE CAPTURE READY · PHYSICAL PREFLIGHT STILL REQUIRED";
    statusDetail = "Adapter connectivity alone does not confirm RAW bit depth, shutter mode, exposure, focus, references or lens stability.";
  }

  const stageStatus = (ready: boolean, colour = false) => {
    if (!applied) return "NOT COMMITTED";
    if (colour && lutCameraRelative) return "CAMERA-RELATIVE RGB · NOT COLORIMETRIC";
    if (colour && !lutColorimetric) return identityFallback ? "IDENTITY FALLBACK" : "NOT MEASURED";
    if (!ready) return "ARTIFACT MISSING";
    if (!rendererAcknowledged) return "COMMITTED · WAIT ACK";
    if (["failed", "rolling-back", "rollback-renderer-ack", "rolled-back", "rollback-blocked"].includes(opticalVerificationState)) {
      return opticalVerificationState === "rolled-back" ? "FAILED · ROLLED BACK" : "VERIFICATION FAILED";
    }
    if (opticalVerificationState === "superseded") return "SUPERSEDED";
    return explicitlyVerified ? "VERIFIED" : "ACKNOWLEDGED · VERIFY";
  };

  return (
    <section className="calibration-layout">
      <MarkerlessCameraSetup
        key={`${nodeId || "no-node"}:${wallId || "no-wall"}`}
        nodeId={nodeId}
        wallId={wallId}
        disabled={running || opticalActive}
        busy={busy === "camera-survey-preview"}
        onCapturePreview={onCaptureSurveyPreview}
        onReadyChange={setMarkerlessSetup}
      />
      <div className="calibration-hero panel">
        <div className="camera-orbit">
          <div className="camera-eye">◎</div>
          {outputs.slice(0, 3).map((item, index) => <span key={item.id} className={`orbit-node n${index + 1}`}>{item.id}</span>)}
        </div>
        <div>
          <p className="eyebrow">A7 IV · TWO-PASS MEASURED CALIBRATION</p>
          <h2>Short geometry first. Long radiometry only after controlled references.</h2>
          <p>Gray-code correspondence solves footprint, dense warp, overlap, blend and mask with a short exposure. A separate long-exposure pass measures black, near-black and tone response. Geometry success never implies black or colour success.</p>
          <button className="calibrate-button" disabled={disabled} onClick={() => void onControl(markerlessSetup)}>
            {busy === "camera-calibration" ? "Queuing two-pass capture…"
              : busy === "camera-calibration-cancel" ? "Requesting safe cancel…"
                : running ? `Cancel safely · ${completedSteps}/${totalSteps || "—"} steps`
                  : !nodeId ? "Windows render node not connected"
                    : markerlessSetup == null ? "Load profile · capture RAW view · choose wall"
                      : "Start measured two-pass capture"}
          </button>
          {running && <div className="calibration-progress" aria-label={`${progressLabel}; ${Math.round(percent)} percent of acknowledged capture repeats complete`}><span style={{ width: `${percent}%` }} /></div>}
          <div className={`camera-status ${statusClass}`}>
            <span />
            <b>{statusTitle}</b>
            <small>{statusDetail}</small>
          </div>
        </div>
      </div>

      <div className="calibration-pass-grid">
        <article className="calibration-pass panel geometry-pass">
          <header><span>PASS 1</span><b>SHORT EXPOSURE · GEOMETRY</b><em>{geometryEstimate}</em></header>
          <p>White target 60–75% of RAW full scale with every channel below clipping. Decode normal/inverse Gray code before any black solve.</p>
          <dl>
            <div><dt>CAPTURE</dt><dd>1× per pattern default</dd></div>
            <div><dt>OUTPUT</dt><dd>Warp · overlap · blend · mask · confidence</dd></div>
            <div><dt>GATE</dt><dd>Coverage and residual geometry must pass</dd></div>
          </dl>
        </article>
        <article className="calibration-pass panel radiometry-pass">
          <header><span>PASS 2</span><b>LONG EXPOSURE · RADIOMETRY</b><em>{radiometryEstimate}</em></header>
          <p>Start around 0.25–1 s, retain ISO 100, and measure the true short/long ratio with paired unsaturated gray captures. A nominal 60× mismatch fails closed.</p>
          <dl>
            <div><dt>CAPTURE</dt><dd>5× signal · 16× reference / near-black</dd></div>
            <div><dt>OUTPUT</dt><dd>Black pedestal · tone gamma · confidence</dd></div>
            <div><dt>COLOR</dt><dd>Camera-relative RGB first; target-space colorimetry needs a characterized profile</dd></div>
          </dl>
        </article>
      </div>

      <div className="calibration-readiness panel">
        <div className="panel-heading compact"><div><p className="eyebrow">CAMERA PREFLIGHT</p><h2>Settings that must survive readback</h2></div><span className="live-badge">BEFORE TAKEOVER</span></div>
        <div className="readiness-grid">
          <span><b>14-bit RAW</b><small>Lossless compressed or uncompressed; no JPEG, HEIF or ProRAW-style processing</small></span>
          <span><b>ISO 100 · MANUAL</b><small>Independent short and long shutter profiles; no Auto ISO or exposure fusion</small></span>
          <span><b>MECHANICAL / EFCS</b><small>Single-shot capture; electronic silent shutter and anti-flicker auto timing off</small></span>
          <span><b>FIXED OPTICS</b><small>16 mm, f/5.6, manual focus; tape zoom and focus, disable IBIS/OSS and lens correction</small></span>
        </div>
      </div>

      <div className="calibration-reference panel">
        <div>
          <p className="eyebrow">PHYSICAL REFERENCE PROMPTS</p>
          <h2>Do not automate past a human confirmation</h2>
          {requiresConfirmation && promptStepId && promptConfirmationId && <div className="operator-confirmation">
            <b>{text(livePrompt.title) || referencePrompt(referenceKind).title}</b>
            <small>{operatorPrompt || referencePrompt(referenceKind).detail}</small>
            <button
              disabled={promptState !== "waiting" || confirmationQueued || busy === "camera-calibration-confirm"}
              onClick={() => void confirmPhysicalState()}
            >{confirmationQueued || busy === "camera-calibration-confirm"
                ? "Confirmation queued…" : "I verified this physical state"}</button>
          </div>}
        </div>
        <ol>
          {Object.entries(REFERENCE_PROMPTS).map(([kind, prompt]) => (
            <li key={kind} className={referenceKind === kind ? "active" : ""}>
              <span>{referenceKind === kind && requiresConfirmation ? "WAIT" : "REF"}</span>
              <div><b>{prompt.title}</b><small>{prompt.detail}</small></div>
            </li>
          ))}
        </ol>
      </div>

      <div className={`optical-verification-control panel ${explicitlyVerified ? "verified" : opticalVerificationState}`}>
        <div>
          <p className="eyebrow">POST-APPLY OPTICAL VERIFICATION</p>
          <h2>Recapture the corrected output before calling it finished</h2>
          <p>Raw Gray-code checks target residual and coverage. Corrected linear solids re-measure black, near-black, tone and seams. A failed deterministic gate restores the exact pre-apply outputs as a new monotonic project revision.</p>
        </div>
        <div className="optical-verification-actions">
          {canStartOpticalVerification && <button
            className="primary-wide"
            disabled={opticalActionBusy}
            onClick={() => void onStartVerification()}
          >{busy === "camera-optical-verification" ? "Queuing RAW recapture…" : "Start post-apply RAW verification"}</button>}
          {opticalActive && <button
            className="primary-wide"
            disabled={opticalActionBusy || ["rolling-back", "rollback-renderer-ack"].includes(opticalVerificationState)}
            onClick={() => void onCancelVerification()}
          >{busy === "camera-optical-verification-cancel" ? "Queuing safe cancel…" : "Cancel optical verification safely"}</button>}
          {opticalActive && opticalTotalSteps > 0 && <div
            className="calibration-progress"
            aria-label={`${opticalCompletedSteps} of ${opticalTotalSteps} optical verification steps complete`}
          ><span style={{ width: `${opticalPercent}%` }} /></div>}
          {opticalVerificationState === "waiting-operator" && opticalPromptStepId && opticalPromptConfirmationId
            && <div className="operator-confirmation">
              <b>{text(opticalPrompt.title) || "Physical verification condition required"}</b>
              <small>{text(opticalPrompt.instructions) || "Verify the exact requested camera and projector state before capture continues."}</small>
              <button
                disabled={opticalPromptState !== "waiting" || opticalConfirmationQueued
                  || busy === "camera-optical-verification-confirm"}
                onClick={() => void confirmOpticalPhysicalState()}
              >{opticalConfirmationQueued || busy === "camera-optical-verification-confirm"
                  ? "Confirmation queued…" : "I verified this optical state"}</button>
            </div>}
          <small className="verification-truth">
            STATE <b>{(opticalVerificationState || "pending").replaceAll("-", " ").toUpperCase()}</b>
            {opticalRollback.targetRevision != null ? ` · ROLLBACK TARGET ${opticalRollback.targetRevision}` : ""}
          </small>
        </div>
      </div>

      <div className="calibration-result-gates panel">
        <div><p className="eyebrow">APPLY IS NOT VERIFY</p><h2>Post-apply result gates</h2></div>
        <div className="result-gate-grid">
          <span><b>GEOMETRY</b><em className={stageStatus(geometryArtifactReady).includes("VERIFIED") ? "verified" : ""}>{stageStatus(geometryArtifactReady)}</em><small>Camera recapture must report residual pixel error after apply.</small></span>
          <span><b>BLACK / TONE</b><em className={stageStatus(radiometryArtifactReady).includes("VERIFIED") ? "verified" : ""}>{stageStatus(radiometryArtifactReady)}</em><small>Re-measure black and near-black uniformity after correction.</small></span>
          <span><b>COLOR 3D LUT</b><em className={stageStatus(lutColorimetric, true).includes("VERIFIED") ? "verified" : "pending"}>{stageStatus(lutColorimetric, true)}</em><small>Camera-relative RGB equalization is measured, but only a characterized target-space profile is colorimetric.</small></span>
        </div>
      </div>

      <div className="calibration-steps panel">
        {[
          ["SHORT", "Geometry exposure", "Lock a non-clipping RAW exposure"],
          ["GRAY", "Correspondence", "Decode physical projector pixels"],
          ["MESH", "Spatial solve", "Warp, overlap, blend and mask"],
          ["REF", "Dark & ambient", "Capture three confirmed references"],
          ["LONG", "Radiometry", "Stack black, near-black and tone"],
          ["CHECK", "Verify after apply", "Record residuals; do not infer success"],
        ].map(([code, step, detail]) => <div key={step}><span>{code}</span><b>{step}</b><small>{detail}</small></div>)}
      </div>

      <div className="calibration-boundary panel"><b>MEASUREMENT BOUNDARY</b><p>The capture does not choose the intended wall boundary. Digital masking cannot identify that wall. Black Uniformity can add light to darker LCD leakage but cannot subtract photons. Camera-relative RGB is not target-space colorimetry, and a committed revision is not verified until a post-apply recapture passes. This panel verifies only the current fixed camera view; separate wall views are not a ROOM VERIFIED result until one final room bundle is applied and every view plus declared corner observation passes against the same revision and renderer fingerprint.</p></div>
    </section>
  );
}

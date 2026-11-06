"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { projectSyncReadiness } from "../lib/project-save.mjs";
import {
  createPixelServerClient,
  initialPixelServerUrl,
  PixelServerError,
  PIXEL_SERVER_TOKEN_KEY,
  pixelServerUrl,
  storedPixelServerToken,
  type PixelNodeActionType,
  type PixelProjector,
  type PixelProjectorAction,
  type PixelCameraCalibrationRequest,
  type PixelCameraSurveyPreviewCapture,
  type PixelCameraSurveyPreviewRequest,
  type PixelProject,
  type PixelProjectApplyResult,
  type PixelProjectSaveResult,
  type PixelProjectSyncStatus,
  type PixelServerState,
  type PixelShowScheduleConfig,
} from "../lib/pixel-server";

export type ConnectionState = "connecting" | "connected" | "offline";

const subscribeStaticBrowserLocation = () => () => undefined;

export function usePixelServer(pollMs = 1000) {
  const [state, setState] = useState<PixelServerState | null>(null);
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [authRequired, setAuthRequired] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [paired, setPaired] = useState(false);
  const projectRef = useRef<PixelProject | null>(null);
  const refreshInFlightRef = useRef<Promise<PixelServerState | null> | null>(null);
  const baseUrl = useSyncExternalStore(subscribeStaticBrowserLocation, pixelServerUrl, initialPixelServerUrl);
  const client = useMemo(() => createPixelServerClient(baseUrl), [baseUrl]);

  const performRefresh = useCallback(async (signal?: AbortSignal): Promise<PixelServerState | null> => {
    try {
      const summary = await client.stateSummary(signal);
      const revision = Number(summary.projectRevision);
      let project = projectRef.current;
      if (!project || !Number.isFinite(revision) || Number(project.revision) !== revision) {
        project = (await client.project(signal)).project;
        projectRef.current = project;
      }
      const next = { ...summary, project };
      setState(next);
      setAuthRequired(next.server?.authRequired ?? true);
      if (next.server?.accessMode === "trusted-local") {
        window.localStorage.removeItem(PIXEL_SERVER_TOKEN_KEY);
        setPaired(false);
      }
      setConnection("connected");
      setError(null);
      setErrorStatus(null);
      return next;
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return null;
      setConnection("offline");
      setError(cause instanceof Error ? cause.message : "Pixel Server is unavailable");
      setErrorStatus(cause instanceof PixelServerError ? cause.status : null);
      if (cause instanceof PixelServerError && cause.status === 401) setAuthRequired(true);
      return null;
    }
  }, [client]);

  const refresh = useCallback((signal?: AbortSignal, forceAfterCurrent = false) => {
    const predecessor = refreshInFlightRef.current;
    if (predecessor && !forceAfterCurrent) return predecessor;
    // A mutation must observe a response that started after that mutation.
    // Chaining behind an older polling GET prevents its stale snapshot from
    // satisfying the post-write refresh or racing to overwrite the new state.
    const operation = (async () => {
      if (predecessor) await predecessor;
      return performRefresh(signal);
    })();
    refreshInFlightRef.current = operation;
    void operation.finally(() => {
      if (refreshInFlightRef.current === operation) refreshInFlightRef.current = null;
    });
    return operation;
  }, [performRefresh]);

  useEffect(() => {
    const controller = new AbortController();
    window.queueMicrotask(() => setPaired(Boolean(storedPixelServerToken())));
    window.queueMicrotask(() => void refresh(controller.signal));
    const timer = window.setInterval(() => void refresh(controller.signal), pollMs);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [pollMs, refresh]);

  const run = useCallback(async <T,>(name: string, operation: () => Promise<T>) => {
    setBusy(name);
    setError(null);
    setErrorStatus(null);
    try {
      const result = await operation();
      await refresh(undefined, true);
      return result;
    } catch (cause) {
      if (cause instanceof PixelServerError && cause.status === 409) await refresh(undefined, true);
      setConnection(cause instanceof PixelServerError ? "connected" : "offline");
      setError(cause instanceof Error ? cause.message : "Command failed");
      setErrorStatus(cause instanceof PixelServerError ? cause.status : null);
      if (cause instanceof PixelServerError && cause.status === 401) setAuthRequired(true);
      throw cause;
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const waitForProjectSync = useCallback(async (
    saved: PixelProjectSaveResult,
    timeoutMs = 15_000,
  ): Promise<PixelProjectApplyResult> => {
    const revision = Number(saved.project.revision);
    const targets = Array.isArray(saved.syncTargets) ? saved.syncTargets : [];
    let readiness = projectSyncReadiness({ nodes: [] }, targets, revision) as Omit<PixelProjectSyncStatus, "timedOut" | "pollError">;
    let pollError: string | null = null;

    if (targets.length === 0) {
      return { ...saved, syncStatus: { ...readiness, timedOut: false, pollError } };
    }

    const deadline = Date.now() + Math.max(1_000, timeoutMs);
    while (Date.now() < deadline) {
      try {
        const summary = await client.stateSummary();
        readiness = projectSyncReadiness(summary, targets, revision) as Omit<PixelProjectSyncStatus, "timedOut" | "pollError">;
        pollError = null;
        if (readiness.live) break;
      } catch (cause) {
        pollError = cause instanceof Error ? cause.message : "Could not read renderer acknowledgement";
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, Math.min(500, remainingMs)));
      }
    }

    return {
      ...saved,
      syncStatus: {
        ...readiness,
        timedOut: !readiness.live && Date.now() >= deadline,
        pollError,
      },
    };
  }, [client]);

  const pairToken = useCallback(async (token: string) => {
    const value = token.trim();
    if (value) window.localStorage.setItem(PIXEL_SERVER_TOKEN_KEY, value);
    else window.localStorage.removeItem(PIXEL_SERVER_TOKEN_KEY);
    setPaired(Boolean(value));
    setError(null);
    setErrorStatus(null);
    setConnection("connecting");
    await refresh();
  }, [refresh]);

  const clearToken = useCallback(async () => {
    window.localStorage.removeItem(PIXEL_SERVER_TOKEN_KEY);
    setPaired(false);
    setConnection("connecting");
    await refresh();
  }, [refresh]);

  const captureCameraSurveyPreview = useCallback((options: PixelCameraSurveyPreviewRequest) => (
    run<PixelCameraSurveyPreviewCapture>("camera-survey-preview", async () => {
      const queued = await client.requestCameraSurveyPreview(options);
      const requestId = String(queued.preview?.requestId || "");
      if (!requestId) throw new PixelServerError("Pixel Server omitted the camera survey-preview request id", 502);
      const deadline = Date.now() + 120_000;
      let preview = queued.preview;
      while (!["complete", "failed"].includes(String(preview.status).toLowerCase())) {
        if (Date.now() >= deadline) {
          throw new PixelServerError("Camera survey preview did not finish within 120 seconds", 408);
        }
        await new Promise<void>((resolve) => window.setTimeout(resolve, 500));
        preview = (await client.cameraSurveyPreview(requestId)).preview;
      }
      if (String(preview.status).toLowerCase() !== "complete") {
        throw new PixelServerError(
          preview.failure?.message || preview.report?.error?.message || "Camera survey preview failed",
          409,
        );
      }
      const artifact = await client.cameraSurveyPreviewArtifact(requestId);
      if (artifact.type && artifact.type !== "image/png") {
        throw new PixelServerError(`Camera survey preview returned ${artifact.type}, not image/png`, 502);
      }
      return { preview, artifact };
    })
  ), [client, run]);

  const loadShowSchedule = useCallback(
    (signal?: AbortSignal) => client.showSchedule(signal),
    [client],
  );
  const saveShowSchedule = useCallback(
    (schedule: PixelShowScheduleConfig, expectedRevision: number) => run(
      "show-schedule:save",
      () => client.configureShowSchedule(schedule, expectedRevision),
    ),
    [client, run],
  );

  return {
    state,
    connection,
    connected: connection === "connected",
    error,
    errorStatus,
    busy,
    paired,
    authRequired,
    baseUrl,
    refresh,
    pairToken,
    clearToken,
    prepare: () => run("prepare", () => client.prepare()),
    play: (baseFrame = 0) => run("play", () => client.play({ delayMs: 750, baseFrame })),
    pause: () => run("pause", () => client.pause()),
    seek: (frame: number) => run("seek", () => client.seek(frame)),
    pattern: (outputId: string, enabled: boolean, type: "grid" | "identify" = "grid", cellSize = 32) =>
      run("pattern", () => client.pattern(outputId, enabled, { type, cellSize })),
    startCameraCalibration: (options: PixelCameraCalibrationRequest) =>
      run("camera-calibration", () => client.startCameraCalibration(options)),
    cancelCameraCalibration: (sessionId: string) =>
      run("camera-calibration-cancel", () => client.cancelCameraCalibration(sessionId)),
    confirmCameraCalibration: (sessionId: string, stepId: string, confirmationId: string) =>
      run("camera-calibration-confirm", () => client.confirmCameraCalibration(sessionId, stepId, confirmationId)),
    startCameraOpticalVerification: (sessionId: string) =>
      run("camera-optical-verification", () => client.startCameraOpticalVerification(sessionId)),
    cancelCameraOpticalVerification: (sessionId: string) =>
      run("camera-optical-verification-cancel", () => client.cancelCameraOpticalVerification(sessionId)),
    confirmCameraOpticalVerification: (sessionId: string, stepId: string, confirmationId: string) =>
      run(
        "camera-optical-verification-confirm",
        () => client.confirmCameraOpticalVerification(sessionId, stepId, confirmationId),
      ),
    captureCameraSurveyPreview,
    nodeAction: (nodeId: string, type: PixelNodeActionType, payload: Record<string, unknown> = {}, confirmationPhrase?: string) =>
      run(`node-action:${nodeId}:${type}`, () => client.nodeAction(nodeId, type, payload, confirmationPhrase)),
    configureProjectors: (projectors: PixelProjector[]) =>
      run("projectors:configure", () => client.configureProjectors(projectors)),
    refreshProjectors: (projectorIds?: string[]) =>
      run("projectors:refresh", () => client.refreshProjectors(projectorIds)),
    projectorAction: (action: PixelProjectorAction, projectorIds?: string[], staggerMs = 0) =>
      run(`projectors:${action}`, () => client.projectorAction(action, projectorIds, staggerMs)),
    loadShowSchedule,
    saveShowSchedule,
    saveProject: (project: PixelProject, expectedRevision: number) =>
      run("save", async () => waitForProjectSync(await client.saveProject(project, expectedRevision))),
    uploadMedia: (file: File) => run("upload", () => client.uploadMedia(file)),
  };
}

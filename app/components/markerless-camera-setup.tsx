"use client";

import { useEffect, useRef, useState } from "react";
import type {
  PixelCameraLensProfile,
  PixelCameraManualSettings,
  PixelCameraSurveyPreviewCapture,
  PixelCameraSurveyPreviewRequest,
  PixelPlanarSurfaceSurvey,
} from "../lib/pixel-server";
import { PlanarSurfaceSurvey } from "./planar-surface-survey";

export type MarkerlessCalibrationSetup = {
  lensProfile: PixelCameraLensProfile;
  surfaceSurveys: PixelPlanarSurfaceSurvey[];
};

type MarkerlessCameraSetupProps = {
  nodeId?: string;
  wallId: string;
  disabled?: boolean;
  busy?: boolean;
  onCapturePreview: (request: PixelCameraSurveyPreviewRequest) => Promise<PixelCameraSurveyPreviewCapture>;
  onReadyChange: (setup: MarkerlessCalibrationSetup | null) => void;
};

type PreviewState = {
  url: string;
  requestId: string;
  cameraViewId: string;
  lensProfileSha256: string;
  frame: { width: number; height: number };
};

const SHA256 = /^[a-f0-9]{64}$/i;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function positive(value: unknown) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function parseLensProfile(input: unknown): PixelCameraLensProfile {
  const value = record(input);
  const camera = record(value.camera);
  const lens = record(value.lens);
  const frame = record(value.frame);
  const capture = record(value.capture);
  const intrinsics = record(value.intrinsics);
  const distortion = record(value.distortion);
  const calibration = record(value.calibration);
  const textFields = [
    camera.manufacturer,
    camera.model,
    camera.serialNumber,
    lens.manufacturer,
    lens.model,
    lens.serialNumber,
    calibration.calibratedAt,
  ];
  if (value.schema !== "pixel-brightness.camera-lens-profile.v1"
    || !SHA256.test(String(value.sha256 || ""))
    || textFields.some((field) => typeof field !== "string" || !field.trim())
    || !Number.isSafeInteger(Number(frame.width))
    || !Number.isSafeInteger(Number(frame.height))
    || !positive(frame.width)
    || !positive(frame.height)
    || !positive(capture.focalLengthMm)
    || !positive(capture.focusDistanceM)
    || !positive(capture.apertureFNumber)
    || !positive(intrinsics.fx)
    || !positive(intrinsics.fy)
    || !Number.isFinite(Number(intrinsics.cx))
    || !Number.isFinite(Number(intrinsics.cy))
    || distortion.model !== "brown-conrady-v1"
    || [distortion.k1, distortion.k2, distortion.k3, distortion.p1, distortion.p2]
      .some((coefficient) => !Number.isFinite(Number(coefficient)))
    || calibration.method !== "opencv-charuco-brown-conrady-v1"
    || !positive(calibration.imageCount)
    || !Number.isFinite(Number(calibration.rmsResidualPx))
    || !Number.isFinite(Number(calibration.maxResidualPx))) {
    throw new Error("ไฟล์นี้ไม่ใช่ Pixel Brightness Lens Profile v1 ที่ครบถ้วน");
  }
  return input as PixelCameraLensProfile;
}

function safeIdentifier(value: string, fallback: string) {
  const normalized = value.trim().replace(/[^A-Za-z0-9_.:-]+/g, "-").replace(/^-+/, "").slice(0, 96);
  return /^[A-Za-z0-9]/.test(normalized) ? normalized : fallback;
}

export function MarkerlessCameraSetup({
  nodeId,
  wallId,
  disabled = false,
  busy = false,
  onCapturePreview,
  onReadyChange,
}: MarkerlessCameraSetupProps) {
  const [lensProfile, setLensProfile] = useState<PixelCameraLensProfile | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [acceptedSurvey, setAcceptedSurvey] = useState<PixelPlanarSurfaceSurvey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);

  const releasePreview = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = null;
    setPreview(null);
  };

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    onReadyChange(null);
  }, [onReadyChange]);

  const loadLensProfile = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setError(null);
    releasePreview();
    setAcceptedSurvey(null);
    onReadyChange(null);
    try {
      if (file.size < 2 || file.size > 1_048_576) {
        throw new Error("Lens Profile ต้องเป็น JSON ขนาดไม่เกิน 1 MiB");
      }
      const profile = parseLensProfile(JSON.parse(await file.text()));
      setLensProfile(profile);
    } catch (cause) {
      setLensProfile(null);
      setError(cause instanceof Error ? cause.message : "อ่าน Lens Profile ไม่สำเร็จ");
    }
  };

  const capturePreview = async () => {
    if (!nodeId || !lensProfile || !wallId) return;
    setError(null);
    setAcceptedSurvey(null);
    onReadyChange(null);
    releasePreview();
    const stamp = Date.now().toString(36);
    const cameraViewId = safeIdentifier(`view-${wallId}-${stamp}`, `view-${stamp}`);
    const cameraSettings: PixelCameraManualSettings = {
      exposureMode: "manual",
      iso: 100,
      apertureF: lensProfile.capture.apertureFNumber,
      shutterUs: 16_667,
      whiteBalance: { mode: "kelvin", kelvin: 5_600 },
      focusMode: "manual",
      captureFormat: "linear-rgb",
    };
    try {
      const result = await onCapturePreview({
        nodeId,
        // The hardware-selection key is the immutable body serial. Display
        // labels and model names must never decide which tethered body wins.
        cameraId: lensProfile.camera.serialNumber,
        cameraViewId,
        lensProfile,
        cameraSettings,
      });
      const frame = result.preview.report?.frame ?? result.preview.frame;
      if (!frame || !positive(frame.width) || !positive(frame.height)) {
        throw new Error("Server ยืนยัน Preview แล้ว แต่ไม่ส่งขนาด RAW raster กลับมา");
      }
      const url = URL.createObjectURL(result.artifact);
      previewUrlRef.current = url;
      setPreview({
        url,
        requestId: result.preview.requestId,
        cameraViewId: result.preview.cameraViewId,
        lensProfileSha256: result.preview.lensProfileSha256,
        frame: { width: Number(frame.width), height: Number(frame.height) },
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "ถ่าย RAW Survey Preview ไม่สำเร็จ");
    }
  };

  const acceptSurvey = async (survey: PixelPlanarSurfaceSurvey) => {
    if (!lensProfile || survey.lensProfileSha256 !== lensProfile.sha256) {
      throw new Error("ขอบผนังไม่ตรงกับ Lens Profile ที่โหลดอยู่");
    }
    setAcceptedSurvey(survey);
    onReadyChange({ lensProfile, surfaceSurveys: [survey] });
  };

  const profileServerVerified = Boolean(preview && lensProfile
    && preview.lensProfileSha256 === lensProfile.sha256);

  return (
    <section className="markerless-setup" aria-labelledby="markerless-setup-title">
      <div className="markerless-setup-head panel">
        <div>
          <p className="eyebrow">NO VENUE MARKER · FIXED RAW CAMERA VIEW</p>
          <h2 id="markerless-setup-title">Prepare one planar wall before capture</h2>
          <p>Lens Profile ใช้ ChArUco แค่ครั้งเดียวในสตูดิโอ จากนั้นหน้างานใช้ภาพ RAW เลือกมุมผนัง 4 จุด โดยไม่ต้องติด Marker บนผิวฉาย</p>
        </div>
        <div className="markerless-profile-actions">
          <label className="file-button">
            Load Lens Profile JSON
            <input type="file" accept="application/json,.json" disabled={disabled || busy} onChange={(event) => void loadLensProfile(event)} />
          </label>
          <button type="button" disabled={disabled || busy || !nodeId || !wallId || !lensProfile} onClick={() => void capturePreview()}>
            {busy ? "Capturing exact RAW preview…" : preview ? "Recapture exact RAW preview" : "Capture exact RAW preview"}
          </button>
        </div>
      </div>

      <div className="markerless-setup-status panel">
        <span><b>WALL</b>{wallId || "SELECT ONE WALL"}</span>
        <span><b>PROFILE</b>{profileServerVerified ? "SERVER + CAMERA VERIFIED" : lensProfile ? "LOADED · VERIFY WITH CAMERA" : "REQUIRED"}</span>
        <span><b>RAW VIEW</b>{preview ? `${preview.frame.width} × ${preview.frame.height}` : "REQUIRED"}</span>
        <span><b>BOUNDARY</b>{acceptedSurvey ? "ACCEPTED" : "REQUIRED"}</span>
      </div>

      {error && <div className="markerless-setup-error" role="alert">{error}</div>}

      {preview && lensProfile && <PlanarSurfaceSurvey
        previewUrl={preview.url}
        frame={preview.frame}
        surveyId={safeIdentifier(`survey-${wallId}-${preview.requestId}`, `survey-${preview.requestId}`)}
        wallId={wallId}
        cameraViewId={preview.cameraViewId}
        lensProfileSha256={preview.lensProfileSha256}
        disabled={disabled || busy}
        onSurveyChange={(survey) => {
          if (!survey && acceptedSurvey) {
            setAcceptedSurvey(null);
            onReadyChange(null);
          }
        }}
        onConfirm={acceptSurvey}
      />}
    </section>
  );
}

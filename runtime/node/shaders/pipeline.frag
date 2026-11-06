#version 330 core

in vec2 vSourceUv;
in vec2 vOutputUv;
layout(location = 0) out vec4 oColor;

uniform sampler2D uSource;
uniform sampler2D uMaskMap;
uniform sampler2D uBlackLiftMap;
uniform sampler3D uColorLut;

// xy = top-left and zw = size, all normalized to the master source texture.
uniform vec4 uSourceRect;
uniform vec2 uOutputSize;
// left, right, top, bottom overlap widths in projector pixels.
uniform vec4 uOverlapPixels;
uniform float uBlendFeather;
uniform float uBlendGamma;
uniform bool uBlendEnabled;

uniform bool uBlackUniformityEnabled;
uniform float uBlackLift;
uniform bool uUseBlackLiftMap;

uniform vec3 uColorGain;
uniform vec3 uColorOffset;
uniform vec3 uColorGamma;
uniform bool uUseColorLut;

// 0 = disabled, 1 = soft texture, 2 = hard texture threshold.
uniform int uMaskMode;
uniform float uMaskThreshold;
uniform bool uMaskInvert;

float rampFromEdge(float pixelsFromEdge, float overlapPixels) {
  if (overlapPixels <= 0.0) return 1.0;
  float normalized = clamp(pixelsFromEdge / overlapPixels, 0.0, 1.0);
  float feathered = smoothstep(0.0, max(uBlendFeather, 1e-4), normalized);
  return pow(feathered, max(uBlendGamma, 1e-4));
}

float edgeBlendWeight(vec2 uv) {
  if (!uBlendEnabled) return 1.0;
  vec2 pixel = uv * uOutputSize;
  vec2 opposite = (vec2(1.0) - uv) * uOutputSize;
  float left = rampFromEdge(pixel.x, uOverlapPixels.x);
  float right = rampFromEdge(opposite.x, uOverlapPixels.y);
  float top = rampFromEdge(pixel.y, uOverlapPixels.z);
  float bottom = rampFromEdge(opposite.y, uOverlapPixels.w);
  return clamp(left * right * top * bottom, 0.0, 1.0);
}

float maskWeight(vec2 uv) {
  if (uMaskMode == 0) return 1.0;
  float sampled = texture(uMaskMap, uv).r;
  if (uMaskInvert) sampled = 1.0 - sampled;
  if (uMaskMode == 2) return sampled >= uMaskThreshold ? 1.0 : 0.0;
  float width = max(fwidth(sampled), 1.0 / max(uOutputSize.x, uOutputSize.y));
  return smoothstep(uMaskThreshold - width, uMaskThreshold + width, sampled);
}

vec3 applyColorPipeline(vec3 linearRgb) {
  vec3 corrected = max(linearRgb * uColorGain + uColorOffset, vec3(0.0));
  corrected = pow(corrected, vec3(1.0) / max(uColorGamma, vec3(1e-4)));
  if (uUseColorLut) corrected = texture(uColorLut, clamp(corrected, 0.0, 1.0)).rgb;
  return corrected;
}

void main() {
  // Source crop/selection happens before the calibrated mesh sample.
  vec2 sourceUv = uSourceRect.xy + vSourceUv * uSourceRect.zw;
  vec3 sourceLinear = texture(uSource, sourceUv).rgb;
  float blend = edgeBlendWeight(vOutputUv);
  float mask = maskWeight(vOutputUv);

  // Black compensation raises the single-projector black floor to the measured
  // worst floor. It cannot remove optical leakage from an LCD projector.
  // A measured map stores direct additive linear-light correction at each
  // physical projector pixel. uBlackLift is only the uniform fallback used
  // before a camera map exists. Correction is independent of blend weight.
  float blackLift = uUseBlackLiftMap ? texture(uBlackLiftMap, vOutputUv).r : uBlackLift;
  blackLift = uBlackUniformityEnabled ? max(0.0, blackLift) : 0.0;
  vec3 linearRgb = sourceLinear * blend + vec3(blackLift);
  vec3 finalRgb = applyColorPipeline(linearRgb) * mask;
  oColor = vec4(clamp(finalRgb, 0.0, 1.0), 1.0);
}

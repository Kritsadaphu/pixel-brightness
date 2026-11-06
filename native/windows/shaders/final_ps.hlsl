Texture2D<float4> sourceTexture : register(t0);
Texture2D<float4> blackMap : register(t1);
Texture2D<float> maskMap : register(t2);
Texture3D<float4> colorLut : register(t3);
Texture2D<float> blendMap : register(t4);
SamplerState linearClamp : register(s0);

cbuffer OutputConstants : register(b0) {
    float4 sourceRect;       // normalized xywh in the incoming master canvas
    float4 overlapPixels;    // left, right, top, bottom
    float2 outputSize;
    float blendFeather;
    float blendGamma;
    float lutSize;
    float patternCellSize;
    uint flags;
    uint patternMode;
    uint patternAxis;
    uint patternBit;
    uint patternInverse;
    float _patternPad;
    float3 solidRgb;
    float _padSolid;
    float3 gain;
    float _pad0;
    float3 offset;
    float _pad1;
    float3 gammaValue;
    float _pad2;
};

static const uint FLAG_SOURCE_SRGB = 1u << 0;
static const uint FLAG_BLEND = 1u << 1;
static const uint FLAG_BLACK_MAP = 1u << 2;
static const uint FLAG_MASK = 1u << 3;
static const uint FLAG_LUT = 1u << 4;
static const uint FLAG_BLEND_MAP = 1u << 5;
static const uint FLAG_SOURCE_VALID = 1u << 6;
static const uint FLAG_BLANK = 1u << 7;
static const uint FLAG_BLACK_MAP_RGB = 1u << 8;
static const uint FLAG_HARD_POLYGON_MASK = 1u << 9;

float edgeRamp(float pixelsFromEdge, float overlap) {
    if (overlap <= 0.0) return 1.0;
    // Keep the transition symmetric around the overlap midpoint. For two
    // matched projectors, the opposite edge evaluates 1-t; the normalized
    // power curve below therefore guarantees w(t) + w(1-t) == 1 in linear
    // light instead of creating a dark/bright seam at the midpoint.
    float normalized = pixelsFromEdge / overlap;
    float width = max(blendFeather, 0.0001);
    float start = 0.5 * (1.0 - width);
    float end = 1.0 - start;
    // Explicit endpoints prevent decimal rounding at a transition boundary
    // from leaking a non-zero value into a region that must be fully black.
    float endpointEpsilon = min(width * 0.0001, 0.000001);
    if (normalized <= start + endpointEpsilon) return 0.0;
    if (normalized >= end - endpointEpsilon) return 1.0;
    // Evaluate both halves from their distance to the nearest outside edge.
    // The upper half is then the explicit complement of the same low-side
    // function. This is substantially more stable in 32-bit shader math near
    // 0/1 than evaluating two independent power ratios.
    bool upperHalf = normalized > 0.5;
    float nearestOutside = upperHalf ? 1.0 - normalized : normalized;
    float t = saturate((nearestOutside - start) / width);
    t = t * t * (3.0 - 2.0 * t);
    float forward = pow(t, max(blendGamma, 0.1));
    float reverse = pow(1.0 - t, max(blendGamma, 0.1));
    float lowerWeight = forward / max(forward + reverse, 0.000001);
    return upperHalf ? 1.0 - lowerWeight : lowerWeight;
}

float blendWeight(float2 uv) {
    if ((flags & FLAG_BLEND_MAP) != 0) return saturate(blendMap.SampleLevel(linearClamp, uv, 0));
    if ((flags & FLAG_BLEND) == 0) return 1.0;
    float2 pixel = uv * outputSize;
    return edgeRamp(pixel.x, overlapPixels.x)
         * edgeRamp(outputSize.x - pixel.x, overlapPixels.y)
         * edgeRamp(pixel.y, overlapPixels.z)
         * edgeRamp(outputSize.y - pixel.y, overlapPixels.w);
}

float srgbChannelToLinear(float value) {
    return value <= 0.04045 ? value / 12.92
                            : pow(max((value + 0.055) / 1.055, 0.0), 2.4);
}

float3 srgbToLinear(float3 value) {
    return float3(srgbChannelToLinear(value.r),
                  srgbChannelToLinear(value.g),
                  srgbChannelToLinear(value.b));
}

float linearChannelToSrgb(float value) {
    value = max(value, 0.0);
    return value <= 0.0031308 ? value * 12.92
                              : 1.055 * pow(value, 1.0 / 2.4) - 0.055;
}

float3 linearToSrgb(float3 value) {
    return float3(linearChannelToSrgb(value.r),
                  linearChannelToSrgb(value.g),
                  linearChannelToSrgb(value.b));
}

uint grayCodeBitCount(uint dimension) {
    uint value = max(dimension - 1u, 1u);
    // Output dimensions are capped at 16,384. This uniform branch ladder is
    // deterministic in Shader Model 5 and avoids compiler-specific first-bit
    // intrinsics and dynamic-loop unrolling behaviour.
    uint bits = 1u;
    if (value >= 2u) bits = 2u;
    if (value >= 4u) bits = 3u;
    if (value >= 8u) bits = 4u;
    if (value >= 16u) bits = 5u;
    if (value >= 32u) bits = 6u;
    if (value >= 64u) bits = 7u;
    if (value >= 128u) bits = 8u;
    if (value >= 256u) bits = 9u;
    if (value >= 512u) bits = 10u;
    if (value >= 1024u) bits = 11u;
    if (value >= 2048u) bits = 12u;
    if (value >= 4096u) bits = 13u;
    if (value >= 8192u) bits = 14u;
    return bits;
}

float3 testPattern(float2 uv) {
    if (patternMode == 1) return 0.0.xxx;
    if (patternMode == 2) return 1.0.xxx;
    if (patternMode == 3) return 0.18.xxx;
    if (patternMode == 4) return float3(1, 0, 0);
    if (patternMode == 5) return float3(0, 1, 0);
    if (patternMode == 6) return float3(0, 0, 1);
    if (patternMode == 9) return saturate(solidRgb);
    float2 pixel = floor(uv * outputSize);
    if (patternMode == 10) {
        uint coordinate = (uint)(patternAxis == 0 ? pixel.x : pixel.y);
        uint dimension = (uint)(patternAxis == 0 ? outputSize.x : outputSize.y);
        uint bits = grayCodeBitCount(dimension);
        uint shift = bits - min(patternBit, bits - 1u) - 1u;
        uint gray = coordinate ^ (coordinate >> 1);
        uint value = (gray >> shift) & 1u;
        if (patternInverse != 0) value = value ^ 1u;
        return float3((float)value, (float)value, (float)value);
    }
    float cell = max(patternCellSize, 2.0);
    bool gridLine = fmod(pixel.x, cell) < 2.0 || fmod(pixel.y, cell) < 2.0;
    if (patternMode == 8) return gridLine ? float3(0.0, 0.72, 1.0) : float3(0.01, 0.015, 0.02);
    return gridLine ? 0.85.xxx : 0.01.xxx;
}

float4 main(float4 position : SV_Position, float2 outputUv : TEXCOORD0) : SV_Target {
    if ((flags & FLAG_BLANK) != 0) return float4(0, 0, 0, 1);

    // SV_Position is the post-warp physical projector pixel. Calibration maps
    // and blend edges live in this coordinate system; only content crop uses
    // the interpolated mesh/source UV.
    float2 physicalUv = saturate(position.xy / outputSize);

    float3 rgb;
    if (patternMode != 0) {
        rgb = testPattern(physicalUv);
    } else if ((flags & FLAG_SOURCE_VALID) != 0) {
        float2 sourceUv = sourceRect.xy + outputUv * sourceRect.zw;
        rgb = sourceTexture.Sample(linearClamp, sourceUv).rgb;
        if ((flags & FLAG_SOURCE_SRGB) != 0) rgb = srgbToLinear(rgb);
    } else {
        return float4(0, 0, 0, 1);
    }

    float weight = blendWeight(physicalUv);
    rgb *= weight;
    if ((flags & FLAG_BLACK_MAP) != 0) {
        // The calibration texture stores the measured additive correction in
        // linear-light units. It is not modulated by the blend weight; doing so
        // would re-introduce the black-floor seam the map is meant to remove.
        float4 measuredLift = blackMap.SampleLevel(linearClamp, physicalUv, 0);
        rgb += (flags & FLAG_BLACK_MAP_RGB) != 0 ? measuredLift.rgb : measuredLift.rrr;
    }
    rgb = max(0.0, rgb * gain + offset);
    rgb = pow(rgb, 1.0 / max(gammaValue, 0.0001));
    if ((flags & FLAG_LUT) != 0) {
        // LUT samples describe a lattice including both 0 and 1. Convert the
        // normalized lattice coordinate to texel centers; sampling rgb
        // directly would spend half a cell clamped at each edge and bias the
        // whole calibration curve.
        float size = max(lutSize, 2.0);
        float3 lutUv = (saturate(rgb) * (size - 1.0) + 0.5) / size;
        rgb = colorLut.SampleLevel(linearClamp, lutUv, 0).rgb;
    }
    float mask = (flags & FLAG_MASK) != 0 ? maskMap.SampleLevel(linearClamp, physicalUv, 0) : 1.0;
    // Generated zero-softness polygons may be rasterized below the physical
    // output resolution. Remove the fractional edge introduced by linear
    // upsampling so the final hard mask remains digital zero/one. Deliberately
    // soft polygons and measured mask maps do not set this flag.
    if ((flags & FLAG_HARD_POLYGON_MASK) != 0) mask = mask >= 0.5 ? 1.0 : 0.0;
    rgb *= saturate(mask);
    // The SDR swapchain is declared G22/P709, so every linear pipeline result
    // is transfer-encoded here regardless of the incoming Spout encoding.
    return float4(saturate(linearToSrgb(rgb)), 1.0);
}

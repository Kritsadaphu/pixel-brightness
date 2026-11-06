import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const projectRoot = new URL("../", import.meta.url);

test("native renderer fingerprints loaded correction bytes and commits binding only after a successful rebuild", async () => {
  const [pipeline, shader, renderer, telemetry, cmake] = await Promise.all([
    readFile(new URL("native/windows/src/FinalPipeline.cpp", projectRoot), "utf8"),
    readFile(new URL("native/windows/shaders/final_ps.hlsl", projectRoot), "utf8"),
    readFile(new URL("native/windows/src/RendererApp.cpp", projectRoot), "utf8"),
    readFile(new URL("native/windows/src/Telemetry.cpp", projectRoot), "utf8"),
    readFile(new URL("native/windows/CMakeLists.txt", projectRoot), "utf8"),
  ]);

  assert.match(pipeline, /loaded\.values\.data\(\)/,
    "GPU resources and artifact digests must use the same loaded byte buffer");
  assert.match(pipeline, /digest = loaded\.sha256/,
    "file path or config metadata alone must never stand in for loaded correction bytes");
  assert.match(pipeline, /verticesSha256[\s\S]{0,180}indicesSha256/,
    "the exact generated vertex and index buffers must bind the active warp mesh");
  assert.match(pipeline, /RasterizePolygonMask[\s\S]{0,4500}digest = VectorSha256\(mask\)/,
    "generated polygon masks need an observed resource digest too");
  assert.match(pipeline, /CreateScalarTexture[\s\S]{0,1400}digest = Sha256Hex/,
    "generated black-lift textures need an observed resource digest too");

  assert.match(pipeline,
    /maskMap_ && output\.maskEnabled && !output\.maskMap &&\s*output\.maskSoftness == 0\.0F[\s\S]{0,100}values\.flags \|= 1U << 9/,
    "only generated zero-softness polygon masks may request hard shader sampling");
  assert.match(shader, /FLAG_HARD_POLYGON_MASK = 1u << 9/,
    "the native shader must reserve the same hard-polygon flag bit");
  const maskSample = shader.indexOf("maskMap.SampleLevel(linearClamp, physicalUv, 0)");
  const hardThreshold = shader.indexOf("mask >= 0.5 ? 1.0 : 0.0", maskSample);
  const maskMultiply = shader.indexOf("rgb *= saturate(mask)", hardThreshold);
  assert.ok(maskSample >= 0 && maskSample < hardThreshold && hardThreshold < maskMultiply,
    "a generated hard polygon must be thresholded after sampling and before it can emit RGB");

  const buildCandidate = renderer.indexOf("auto candidateBinding = BuildActiveCorrectionBinding");
  const swapCandidate = renderer.indexOf("outputs_.swap(candidateOutputs)");
  const commitCandidate = renderer.indexOf("std::swap(activeCorrectionBinding_, candidateBinding)");
  assert.ok(buildCandidate >= 0 && buildCandidate < swapCandidate && swapCandidate < commitCandidate,
    "live apply must stage the binding and commit it only with the successful output swap");
  const rebuildCandidate = renderer.indexOf("auto rebuiltBinding = BuildActiveCorrectionBinding");
  const rebuildSwap = renderer.indexOf("outputs_.swap(rebuilt)", rebuildCandidate);
  const rebuildCommit = renderer.indexOf("activeCorrectionBinding_ = std::move(rebuiltBinding)", rebuildSwap);
  assert.ok(rebuildCandidate >= 0 && rebuildCandidate < rebuildSwap && rebuildSwap < rebuildCommit,
    "display-topology rebuild must retain the old fingerprint until its replacement succeeds");
  assert.match(renderer, /apply-config[\s\S]{0,1400}activeCorrectionBinding/,
    "apply-config must return the exact binding committed by native code");
  assert.match(telemetry, /\{"activeCorrectionBinding", ActiveCorrectionBindingJson\(activeCorrectionBinding\)\}/,
    "live status telemetry must carry the committed binding");
  assert.match(cmake, /\bbcrypt\b/,
    "the native target must link the Windows SHA-256 provider");
});

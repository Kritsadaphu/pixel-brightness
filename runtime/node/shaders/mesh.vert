#version 330 core

// The CPU uploads a tessellated projector mesh. aSourceUv identifies the point
// in the master canvas; aOutputPosition is the calibrated destination point in
// normalized projector coordinates and may extend beyond 0..1 for masking.
layout(location = 0) in vec2 aSourceUv;
layout(location = 1) in vec2 aOutputPosition;

uniform mat3 uOutputTransform;

out vec2 vSourceUv;
out vec2 vOutputUv;

void main() {
  vec3 transformed = uOutputTransform * vec3(aOutputPosition, 1.0);
  vec2 outputUv = transformed.xy / max(abs(transformed.z), 1e-7);
  vSourceUv = aSourceUv;
  vOutputUv = outputUv;
  gl_Position = vec4(outputUv * 2.0 - 1.0, 0.0, 1.0);
}

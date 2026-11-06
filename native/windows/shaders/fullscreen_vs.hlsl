struct VertexOut {
    float4 position : SV_Position;
    float2 uv : TEXCOORD0;
};

struct VertexIn {
    float2 position : POSITION;
    float2 uv : TEXCOORD0;
};

VertexOut main(VertexIn input) {
    VertexOut output;
    output.uv = input.uv;
    output.position = float4(input.position.x * 2.0 - 1.0,
                             1.0 - input.position.y * 2.0, 0.0, 1.0);
    return output;
}

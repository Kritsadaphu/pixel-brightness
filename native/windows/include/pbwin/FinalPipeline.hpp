#pragma once

#include "pbwin/Config.hpp"

#include <d3d11.h>
#include <wrl/client.h>

#include <filesystem>
#include <optional>
#include <string>

namespace pbwin {

struct OutputCorrectionBinding {
    std::string warpMeshSha256;
    std::optional<std::string> blendMapSha256;
    std::optional<std::string> blackMapSha256;
    std::optional<std::string> maskSha256;
    std::optional<std::string> colorLutSha256;
};

class FinalPipeline final {
public:
    void Initialize(ID3D11Device* device, const std::filesystem::path& shaderDirectory,
                    const OutputConfig& output);
    void Render(ID3D11DeviceContext* context,
                ID3D11RenderTargetView* target,
                ID3D11ShaderResourceView* source,
                bool sourceValid,
                const OutputConfig& output,
                const CanvasConfig& canvas,
                bool sourceIsSrgb,
                const PatternConfig& pattern,
                bool blank);

    void LoadCorrectionAssets(ID3D11Device* device,
                              const OutputConfig& output,
                              const std::filesystem::path& baseDirectory);
    [[nodiscard]] const OutputCorrectionBinding& CorrectionBinding() const noexcept {
        return correctionBinding_;
    }

private:
    struct alignas(16) Constants {
        float sourceRect[4]{};
        float overlapPixels[4]{};
        float outputSize[2]{};
        float blendFeather{};
        float blendGamma{};
        float lutSize{};
        float patternCellSize{};
        std::uint32_t flags{};
        std::uint32_t patternMode{};
        std::uint32_t patternAxis{};
        std::uint32_t patternBit{};
        std::uint32_t patternInverse{};
        float patternPad{};
        float solidRgb[3]{};
        float padSolid{};
        float gain[3]{};
        float pad0{};
        float offset[3]{};
        float pad1{};
        float gamma[3]{};
        float pad2{};
    };

    Microsoft::WRL::ComPtr<ID3D11VertexShader> vertexShader_;
    Microsoft::WRL::ComPtr<ID3D11PixelShader> pixelShader_;
    Microsoft::WRL::ComPtr<ID3D11InputLayout> inputLayout_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> vertices_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> indices_;
    Microsoft::WRL::ComPtr<ID3D11SamplerState> sampler_;
    Microsoft::WRL::ComPtr<ID3D11Buffer> constants_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> blackMap_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> blendMap_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> maskMap_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> colorLut_;
    std::uint32_t indexCount_{};
    OutputCorrectionBinding correctionBinding_;
};

} // namespace pbwin

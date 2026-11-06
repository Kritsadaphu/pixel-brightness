#pragma once

#include "pbwin/FinalPipeline.hpp"
#include "pbwin/NetworkVideoFrame.hpp"

#include <array>
#include <optional>

namespace pbwin {

// Experimental transport-neutral output. No HWND, monitor binding or swapchain.
// Uses exactly the same correction shader/assets as the physical display path.
// All methods must be called on the one D3D immediate-context owner thread.
class OffscreenOutput final {
public:
    struct ReadbackTiming { double allocationMs{}, mapMs{}, copyMs{}, pollMs{}; };
    [[nodiscard]] const ReadbackTiming& Timing() const noexcept { return timing_; }
    OffscreenOutput() = default;
    OffscreenOutput(const OffscreenOutput&) = delete;
    OffscreenOutput& operator=(const OffscreenOutput&) = delete;
    void Initialize(ID3D11Device* device, OutputConfig output, CanvasConfig canvas,
                    const std::filesystem::path& shaderDirectory,
                    const std::filesystem::path& assetDirectory);
    // Returns false if both readback slots are occupied. Never overwrites a
    // pending frame, blocks waiting for the GPU, or grows an unbounded queue.
    bool Submit(ID3D11DeviceContext* context, ID3D11ShaderResourceView* source,
                bool sourceValid, bool sourceIsSrgb, PatternConfig pattern,
                bool blank, std::uint64_t sequence, std::int64_t timecode);
    std::optional<NetworkVideoFrame> TryReadback(ID3D11DeviceContext* context);
    void RecycleReadbackBuffer(std::vector<std::uint8_t> buffer) {
        if (reusable_.empty()) reusable_ = std::move(buffer);
    }
    // Caller must discard queued frames whenever authorization/content epoch
    // changes (blank, source loss, config swap). It must then submit fresh black.
    void DiscardPending() noexcept;
    [[nodiscard]] const OutputCorrectionBinding& CorrectionBinding() const noexcept {
        return pipeline_.CorrectionBinding();
    }

private:
    struct Slot {
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
        Microsoft::WRL::ComPtr<ID3D11Query> completion;
        std::uint64_t sequence{};
        std::int64_t timecode{};
    };
    OutputConfig output_;
    CanvasConfig canvas_;
    FinalPipeline pipeline_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> target_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> view_;
    std::array<Slot, 2> slots_;
    std::size_t head_{};
    std::size_t count_{};
    ReadbackTiming timing_{};
    std::vector<std::uint8_t> reusable_;
};

} // namespace pbwin

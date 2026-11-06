#pragma once

#include "pbwin/Config.hpp"
#include "pbwin/DisplayTiming.hpp"
#include "pbwin/DisplayRegistry.hpp"
#include "pbwin/FinalPipeline.hpp"
#include "pbwin/Telemetry.hpp"
#include "pbwin/Win32Window.hpp"

#include <dxgi1_6.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>

namespace pbwin {

class D3DDevice;

class OutputSurface final {
public:
    OutputSurface() = default;
    ~OutputSurface();
    OutputSurface(const OutputSurface&) = delete;
    OutputSurface& operator=(const OutputSurface&) = delete;

    void Initialize(D3DDevice& graphics,
                    OutputConfig config,
                    const CanvasConfig& canvas,
                    DisplayDescriptor display,
                    const std::filesystem::path& baseDirectory,
                    bool topmost,
                    bool vsync);
    void Render(D3DDevice& graphics, const CanvasConfig& canvas,
                ID3D11ShaderResourceView* composition, bool sourceValid,
                bool sourceIsSrgb);
    void RefreshDisplayTiming() noexcept { SampleDisplayTiming(); }
    void MarkDisplayTimingRecovering() noexcept;
    void ValidateBlackPresent(D3DDevice& graphics);
    void PresentBlack(D3DDevice& graphics) noexcept;
    void Shutdown() noexcept;

    void SetBlank(bool value) noexcept { blank_ = value; }
    void SetPattern(PatternConfig value) noexcept;
    [[nodiscard]] const std::string& Id() const noexcept { return config_.id; }
    [[nodiscard]] const ResolutionConfig& Resolution() const noexcept { return config_.resolution; }
    [[nodiscard]] bool IsBlank() const noexcept { return blank_; }
    [[nodiscard]] bool IsOccluded() const noexcept { return occluded_; }
    [[nodiscard]] const PatternConfig& Pattern() const noexcept { return pattern_; }
    [[nodiscard]] HANDLE FrameLatencyHandle() const noexcept { return frameLatencyHandle_; }
    [[nodiscard]] OutputTelemetry Snapshot() const;

private:
    void CreateSwapChain(D3DDevice& graphics);
    void CreateBackBuffer(D3DDevice& graphics);
    void SampleDisplayTiming() noexcept;

    OutputConfig config_;
    CanvasConfig canvas_;
    DisplayDescriptor display_;
    Win32Window window_;
    Microsoft::WRL::ComPtr<IDXGISwapChain4> swapChain_;
    Microsoft::WRL::ComPtr<ID3D11RenderTargetView> renderTarget_;
    HANDLE frameLatencyHandle_{INVALID_HANDLE_VALUE};
    FinalPipeline pipeline_;
    PatternConfig pattern_{};
    bool blank_{true};
    bool vsync_{true};
    bool occluded_{};
    std::uint64_t presentAttempts_{};
    std::uint64_t acceptedPresentSubmissions_{};
    std::uint64_t occludedPresentSubmissions_{};
    std::uint64_t otherPresentStatuses_{};
    std::uint64_t presentFailures_{};
    HRESULT lastPresentResult_{S_OK};
    HRESULT lastPresentIdResult_{S_OK};
    std::optional<std::uint32_t> lastSubmittedPresentId_;
    std::int64_t lastPresentSubmissionQpc_{};
    std::int64_t qpcFrequency_{};
    double lastRenderMilliseconds_{};
    DisplayTimingTracker displayTiming_;
};

} // namespace pbwin

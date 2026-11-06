#pragma once

#include "pbwin/BootBlackLock.hpp"
#include "pbwin/Config.hpp"
#include "pbwin/D3DDevice.hpp"
#include "pbwin/NamedPipeServer.hpp"
#include "pbwin/OutputSurface.hpp"
#include "pbwin/SpoutInput.hpp"
#include "pbwin/Telemetry.hpp"

#include <Windows.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace pbwin {

class RendererApp final {
public:
    RendererApp(HINSTANCE instance, std::string bootBlackAuthorizationDigest);
    int Run(RendererConfig config);
    static nlohmann::json ListDisplaysJson();

private:
    void ApplyConfig(RendererConfig config, bool initial,
                     std::optional<std::string> canonicalConfigSha256 = std::nullopt);
    void BuildOutputs(const RendererConfig& config,
                      D3DDevice& graphics,
                      std::vector<std::unique_ptr<OutputSurface>>& destination);
    void HandleRequests();
    void HandleRequest(const IpcRequest& request);
    void PumpMessages();
    [[nodiscard]] bool HandleFatalPipeListener();
    void BeginRecovery(RecoveryTrigger trigger, const std::string& detail);
    void ServiceRecovery();
    void KeepOutputsBlack(bool invalidateTiming = false, bool force = false) noexcept;
    void RenderFrame();
    void UpdateTelemetry();
    void UpdateTelemetry(bool publish);
    void BlankAll(bool blank, const std::optional<std::string>& outputId);
    void PatternAll(const PatternConfig& pattern,
                    const std::optional<std::string>& outputId);
    void RestoreRuntimeOverrides(std::vector<std::unique_ptr<OutputSurface>>& destination) const;
    [[nodiscard]] bool BootBlackLocked() const noexcept { return bootBlackLock_.Locked(); }
    nlohmann::json Capabilities() const;

    HINSTANCE instance_{};
    RendererConfig config_;
    D3DDevice graphics_;
    SpoutInput compositionInput_;
    std::vector<std::unique_ptr<OutputSurface>> outputs_;
    NamedPipeServer pipe_;
    BootBlackLock bootBlackLock_;
    Telemetry telemetry_;
    RecoveryPolicy recovery_;
    std::atomic_bool running_{true};
    // Health is earned only by an all-output checked black-present commit.
    // In particular, startup must not expose a releasable healthy state while
    // the first candidate is still being constructed or validated.
    bool outputsHealthy_{};
    bool newOutputBlank_{};
    PatternConfig newOutputPattern_{};
    ActiveCorrectionBinding activeCorrectionBinding_;
    std::chrono::steady_clock::time_point lastFrameStatisticsFlush_{};
    std::chrono::steady_clock::time_point lastRecoveryBlackPresent_{};
    std::string state_{"starting"};
};

} // namespace pbwin

#pragma once

#include "pbwin/Config.hpp"
#include "pbwin/DisplayTiming.hpp"
#include "pbwin/FinalPipeline.hpp"
#include "pbwin/PipeListenerRecoveryPolicy.hpp"
#include "pbwin/RecoveryPolicy.hpp"
#include "pbwin/SpoutInput.hpp"
#include "pbwin/TelemetryPersistence.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace pbwin {

struct ActiveOutputCorrectionBinding {
    std::string id;
    bool processingBypass{};
    OutputCorrectionBinding artifacts;
};

struct ActiveCorrectionBinding {
    std::uint32_t schemaVersion{1};
    std::string algorithm{"sha256"};
    std::string configSha256;
    std::string fingerprint;
    std::vector<ActiveOutputCorrectionBinding> outputs;
};

nlohmann::json ActiveCorrectionBindingJson(const ActiveCorrectionBinding& binding);

struct OutputTelemetry {
    std::string id;
    std::wstring devicePath;
    std::wstring gdiName;
    bool active{};
    bool blank{};
    bool processingBypass{};
    OutputCorrectionBinding correctionBinding;
    PatternConfig pattern{};
    bool occluded{};
    std::uint64_t presentAttempts{};
    std::uint64_t acceptedPresentSubmissions{};
    std::uint64_t occludedPresentSubmissions{};
    std::uint64_t otherPresentStatuses{};
    std::uint64_t presentFailures{};
    long lastPresentResult{};
    long lastPresentIdResult{};
    std::optional<std::uint32_t> lastSubmittedPresentId;
    std::int64_t lastPresentSubmissionQpc{};
    double renderMilliseconds{};
    bool vsync{};
    DisplayTimingSnapshot displayTiming;
};

class Telemetry final {
public:
    Telemetry();
    ~Telemetry() = default;
    Telemetry(const Telemetry&) = delete;
    Telemetry& operator=(const Telemetry&) = delete;

    void Configure(const TelemetryConfig& config);
    void Update(std::uint64_t revision,
                const std::string& nodeId,
                const std::string& state,
                const std::string& adapterName,
                const LuidValue& adapterLuid,
                const SpoutInputStatus& compositionInput,
                const PipeListenerRecoverySnapshot& ipcListener,
                const RecoverySnapshot& recovery,
                const ActiveCorrectionBinding& activeCorrectionBinding,
                bool bootBlackLocked,
                std::uint32_t bootBlackReleaseCount,
                std::vector<OutputTelemetry> outputs);
    [[nodiscard]] nlohmann::json Snapshot() const;
    void MaybePublish();
    [[nodiscard]] bool PublishFinal(std::chrono::milliseconds timeout) noexcept;
    void Shutdown() noexcept;

private:
    std::atomic<std::shared_ptr<const nlohmann::json>> snapshot_;
    TelemetryPersistence persistence_;
    std::optional<std::filesystem::path> path_;
    std::chrono::milliseconds interval_{1000};
    std::chrono::steady_clock::time_point lastPublish_{};
};

} // namespace pbwin

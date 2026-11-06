#include "pbwin/Telemetry.hpp"
#include "pbwin/Log.hpp"

#include <Windows.h>

#include <format>
#include <memory>
#include <utility>

namespace pbwin {
namespace {

std::string UtcTimestamp() {
    SYSTEMTIME value{};
    GetSystemTime(&value);
    return std::format("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z", value.wYear, value.wMonth,
                       value.wDay, value.wHour, value.wMinute, value.wSecond, value.wMilliseconds);
}

nlohmann::json InputJson(const SpoutInputStatus& input) {
    return {
        {"state", InputStateName(input.state)}, {"detail", input.detail},
        {"width", input.width}, {"height", input.height},
        {"format", DxgiFormatName(input.format)}, {"expectedFps", input.expectedFps},
        {"senderFps", input.senderFps}, {"frameRateDelta", input.frameRateDelta},
        {"frameRateValidated", input.frameRateValidated},
        {"senderFrame", input.senderFrame}, {"frameNew", input.frameNew},
        {"receivedFrames", input.receivedFrames}, {"rejectedFrames", input.rejectedFrames},
    };
}

nlohmann::json OptionalDigestJson(const std::optional<std::string>& digest) {
    return digest ? nlohmann::json(*digest) : nlohmann::json(nullptr);
}

template <typename T>
nlohmann::json OptionalNumberJson(const std::optional<T>& value) {
    return value ? nlohmann::json(*value) : nlohmann::json(nullptr);
}

std::string HresultText(const long result) {
    return std::format("0x{:08X}", static_cast<unsigned long>(result));
}

nlohmann::json OptionalHresultJson(const std::optional<std::int32_t>& result) {
    return result ? nlohmann::json(HresultText(*result)) : nlohmann::json(nullptr);
}

nlohmann::json DisplayTimingJson(const DisplayTimingSnapshot& timing, const bool vsync) {
    return {
        {"source", "IDXGISwapChain::GetFrameStatistics"},
        {"syncInterval", vsync ? 1 : 0},
        {"cadenceMetricsApplicable", vsync},
        {"phaseProof", false},
        {"multiMonitorReliability", "platform-dependent"},
        {"available", timing.available},
        {"status", std::string(timing.status)},
        {"lastQueryHresult", OptionalHresultJson(timing.lastQueryResult)},
        {"lastQueryQpc", OptionalNumberJson(timing.lastQueryQpc)},
        {"presentCount", OptionalNumberJson(timing.presentCount)},
        {"presentRefreshCount", OptionalNumberJson(timing.presentRefreshCount)},
        {"syncRefreshCount", OptionalNumberJson(timing.syncRefreshCount)},
        {"syncQpcTime", OptionalNumberJson(timing.syncQpcTime)},
        {"sampleAgeMilliseconds", OptionalNumberJson(timing.sampleAgeMilliseconds)},
        {"sampleSequence", timing.sampleSequence},
        {"discontinuities", timing.discontinuities},
        {"droppedPresents", vsync ? OptionalNumberJson(timing.droppedPresents) : nlohmann::json(nullptr)},
        {"repeatedRefreshes", vsync ? OptionalNumberJson(timing.repeatedRefreshes) : nlohmann::json(nullptr)},
        {"latePresentEvents", vsync ? OptionalNumberJson(timing.latePresentEvents) : nlohmann::json(nullptr)},
        {"maximumLatenessRefreshes", vsync ? OptionalNumberJson(timing.maximumLatenessRefreshes)
                                            : nlohmann::json(nullptr)},
    };
}

nlohmann::json RecoveryJson(const RecoverySnapshot& recovery) {
    return {
        {"active", recovery.active},
        {"phase", RecoveryPhaseName(recovery.phase)},
        {"trigger", RecoveryTriggerName(recovery.trigger)},
        {"generation", recovery.generation},
        {"attempts", recovery.attempts},
        {"maximumAttempts", recovery.maximumAttempts},
        {"retryInMilliseconds", OptionalNumberJson(recovery.retryInMilliseconds)},
        {"exhausted", recovery.exhausted},
        {"deviceRecreationAttempted", recovery.deviceRecreationAttempted},
        {"deviceRecreated", recovery.deviceRecreated},
        {"successfulRecoveries", recovery.successfulRecoveries},
        {"exhaustedRecoveries", recovery.exhaustedRecoveries},
        {"triggerDetail", recovery.triggerDetail.empty() ? nlohmann::json(nullptr)
                                                           : nlohmann::json(recovery.triggerDetail)},
        {"lastError", recovery.lastError.empty() ? nlohmann::json(nullptr)
                                                   : nlohmann::json(recovery.lastError)},
    };
}

nlohmann::json PipeListenerJson(const PipeListenerRecoverySnapshot& listener) {
    return {
        {"state", std::string(PipeListenerPhaseName(listener.phase))},
        {"healthy", listener.healthy},
        {"degraded", listener.degraded},
        {"fatal", listener.fatal},
        {"consecutiveFailures", listener.consecutiveFailures},
        {"maximumFailures", listener.maximumFailures},
        {"totalFailures", listener.totalFailures},
        {"successfulRecoveries", listener.successfulRecoveries},
        {"retryInMilliseconds",
         listener.retryInMilliseconds
             ? nlohmann::json(*listener.retryInMilliseconds)
             : nlohmann::json(nullptr)},
        {"lastFailureStage",
         listener.lastFailureStage == PipeListenerFailureStage::none
             ? nlohmann::json(nullptr)
             : nlohmann::json(std::string(PipeListenerFailureStageName(
                   listener.lastFailureStage)))},
        {"lastWin32Error",
         listener.lastErrorCode == 0 ? nlohmann::json(nullptr)
                                     : nlohmann::json(listener.lastErrorCode)},
        {"lastError", listener.lastError.empty()
                          ? nlohmann::json(nullptr)
                          : nlohmann::json(listener.lastError)},
    };
}

nlohmann::json OutputCorrectionBindingJson(const OutputCorrectionBinding& binding) {
    return {
        {"warpMeshSha256", binding.warpMeshSha256},
        {"blendMapSha256", OptionalDigestJson(binding.blendMapSha256)},
        {"blackMapSha256", OptionalDigestJson(binding.blackMapSha256)},
        {"maskSha256", OptionalDigestJson(binding.maskSha256)},
        {"colorLutSha256", OptionalDigestJson(binding.colorLutSha256)},
    };
}

} // namespace

nlohmann::json ActiveCorrectionBindingJson(const ActiveCorrectionBinding& binding) {
    nlohmann::json outputs = nlohmann::json::array();
    for (const auto& output : binding.outputs) {
        outputs.push_back({
            {"id", output.id},
            {"processingBypass", output.processingBypass},
            {"artifacts", OutputCorrectionBindingJson(output.artifacts)},
        });
    }
    return {
        {"schemaVersion", binding.schemaVersion},
        {"algorithm", binding.algorithm},
        {"configSha256", binding.configSha256},
        {"fingerprint", binding.fingerprint},
        {"outputs", std::move(outputs)},
    };
}

Telemetry::Telemetry()
    : snapshot_(std::make_shared<const nlohmann::json>(nlohmann::json::object())) {}

void Telemetry::Configure(const TelemetryConfig& config) {
    auto nextPath = config.path;
    const auto nextInterval = std::chrono::milliseconds(config.intervalMs);
    persistence_.Configure(nextPath.has_value());
    path_ = std::move(nextPath);
    interval_ = nextInterval;
    lastPublish_ = {};
}

void Telemetry::Update(const std::uint64_t revision, const std::string& nodeId,
                       const std::string& state, const std::string& adapterName,
                       const LuidValue& adapterLuid, const SpoutInputStatus& compositionInput,
                       const PipeListenerRecoverySnapshot& ipcListener,
                       const RecoverySnapshot& recovery,
                       const ActiveCorrectionBinding& activeCorrectionBinding,
                       const bool bootBlackLocked,
                       const std::uint32_t bootBlackReleaseCount,
                       std::vector<OutputTelemetry> outputs) {
    nlohmann::json outputJson = nlohmann::json::array();
    for (const auto& output : outputs) {
        nlohmann::json patternParameters = nlohmann::json::object();
        if (output.pattern.mode == PatternMode::solid) {
            patternParameters["rgb"] = output.pattern.solidRgb;
            patternParameters["applyCorrections"] = output.pattern.applyCorrections;
        }
        if (output.pattern.mode == PatternMode::grayCode) {
            patternParameters["axis"] = output.pattern.grayAxisY ? "y" : "x";
            patternParameters["bit"] = output.pattern.grayBit;
            patternParameters["inverse"] = output.pattern.inverse;
        }
        if (output.pattern.mode == PatternMode::grid || output.pattern.mode == PatternMode::identify) {
            patternParameters["cellSize"] = output.pattern.cellSize;
        }
        outputJson.push_back({
            {"id", output.id}, {"devicePath", Narrow(output.devicePath)}, {"gdiName", Narrow(output.gdiName)},
            {"active", output.active}, {"blank", bootBlackLocked || output.blank},
            {"processingBypass", output.processingBypass},
            {"correctionBinding", OutputCorrectionBindingJson(output.correctionBinding)},
            {"correctionsBypassed", PatternCorrectionsBypassed(output.pattern, output.processingBypass)},
            {"pattern", PatternModeName(output.pattern.mode)},
            {"patternParameters", std::move(patternParameters)},
            {"presentSubmissions", {
                {"attempted", output.presentAttempts},
                {"accepted", output.acceptedPresentSubmissions},
                {"occluded", output.occludedPresentSubmissions},
                {"otherStatuses", output.otherPresentStatuses},
                {"failures", output.presentFailures},
                {"lastHresult", HresultText(output.lastPresentResult)},
                {"lastPresentIdHresult", HresultText(output.lastPresentIdResult)},
                {"lastSubmittedPresentId", OptionalNumberJson(output.lastSubmittedPresentId)},
                {"lastSubmissionQpc", output.lastPresentSubmissionQpc},
            }},
            {"displayTiming", DisplayTimingJson(output.displayTiming, output.vsync)},
            {"occluded", output.occluded},
            {"renderMilliseconds", output.renderMilliseconds},
        });
    }
    nlohmann::json next{
        {"schemaVersion", 2}, {"updatedAt", UtcTimestamp()}, {"nodeId", nodeId},
        {"revision", revision}, {"state", state},
        {"bootBlackLocked", bootBlackLocked},
        {"bootBlackReleaseCount", bootBlackReleaseCount},
        {"activeCorrectionBinding", ActiveCorrectionBindingJson(activeCorrectionBinding)},
        {"adapter", {{"name", adapterName}, {"luid", LuidToString(adapterLuid)}}},
        {"compositionSource", InputJson(compositionInput)},
        {"ipcListener", PipeListenerJson(ipcListener)},
        {"recovery", RecoveryJson(recovery)},
        {"outputs", std::move(outputJson)},
    };
    snapshot_.store(std::make_shared<const nlohmann::json>(std::move(next)));
}

nlohmann::json Telemetry::Snapshot() const {
    const auto immutable = snapshot_.load();
    auto result = immutable ? *immutable : nlohmann::json::object();
    result["telemetryPersistence"] = persistence_.StatusJson();
    return result;
}

void Telemetry::MaybePublish() {
    if (!path_) return;
    const auto now = std::chrono::steady_clock::now();
    if (lastPublish_.time_since_epoch().count() != 0 &&
        now - lastPublish_ < interval_) {
        return;
    }
    if (persistence_.TryPublish(*path_, snapshot_.load())) lastPublish_ = now;
}

bool Telemetry::PublishFinal(const std::chrono::milliseconds timeout) noexcept {
    if (!path_) return false;
    return persistence_.TryPublishAndWait(*path_, snapshot_.load(), timeout);
}

void Telemetry::Shutdown() noexcept { persistence_.Shutdown(); }

} // namespace pbwin

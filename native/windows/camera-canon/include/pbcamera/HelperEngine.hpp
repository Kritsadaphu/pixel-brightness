#pragma once

#include "pbcamera/Provider.hpp"

#include <nlohmann/json.hpp>

#include <memory>
#include <set>
#include <string>

namespace pbcamera {

inline constexpr int kCameraHelperProtocolVersion = 1;
inline constexpr std::size_t kMaximumProtocolLineBytes = 1024U * 1024U;

enum class HelperState {
    ready,
    detected,
    sessionOpen,
    manualLocked,
    faulted,
    closed,
};

class HelperEngine final {
public:
    explicit HelperEngine(std::unique_ptr<ICanonCameraProvider> provider);

    nlohmann::json HandleEnvelope(const nlohmann::json& envelope) noexcept;

    [[nodiscard]] HelperState State() const noexcept { return state_; }
    [[nodiscard]] bool Closed() const noexcept { return state_ == HelperState::closed; }

private:
    nlohmann::json Dispatch(const std::string& method,
                            const nlohmann::json& params);

    std::unique_ptr<ICanonCameraProvider> provider_;
    HelperState state_{HelperState::ready};
    nlohmann::json detectedCameras_{nlohmann::json::object()};
    nlohmann::json openedCamera_;
    nlohmann::json openedLens_;
    nlohmann::json manualSettings_;
    nlohmann::json sourcePolicy_;
    nlohmann::json sdkProvenance_;
    nlohmann::json decoderProvenance_;
    nlohmann::json rawDecodeProvenance_;
    nlohmann::json spatialTransform_;
    std::string helperVersion_;
    std::set<std::string> sourceDigests_;
};

nlohmann::json ErrorEnvelope(std::string id,
                             std::string code,
                             std::string message,
                             nlohmann::json details = nullptr,
                             bool retryable = false);

} // namespace pbcamera

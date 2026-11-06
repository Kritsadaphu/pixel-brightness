#include "pbwin/PipeListenerRecoveryPolicy.hpp"

#include <algorithm>
#include <limits>
#include <utility>

namespace pbwin {
namespace {

std::uint64_t SaturatingAdd(const std::uint64_t left,
                            const std::uint64_t right) noexcept {
    if (right > std::numeric_limits<std::uint64_t>::max() - left) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return left + right;
}

std::string BoundedError(std::string detail) {
    if (detail.size() > PipeListenerRecoveryPolicy::kMaximumErrorBytes) {
        detail.resize(PipeListenerRecoveryPolicy::kMaximumErrorBytes);
    }
    return detail;
}

} // namespace

std::string_view PipeListenerPhaseName(const PipeListenerPhase value) noexcept {
    switch (value) {
    case PipeListenerPhase::stopped: return "stopped";
    case PipeListenerPhase::starting: return "starting";
    case PipeListenerPhase::listening: return "listening";
    case PipeListenerPhase::connected: return "connected";
    case PipeListenerPhase::retryWait: return "retry-wait";
    case PipeListenerPhase::fatal: return "fatal";
    }
    return "unknown";
}

std::string_view PipeListenerFailureStageName(
    const PipeListenerFailureStage value) noexcept {
    switch (value) {
    case PipeListenerFailureStage::none: return "none";
    case PipeListenerFailureStage::createPipe: return "create-pipe";
    case PipeListenerFailureStage::connectionState: return "connection-state";
    case PipeListenerFailureStage::connectEvent: return "connect-event";
    case PipeListenerFailureStage::connectStart: return "connect-start";
    case PipeListenerFailureStage::connectWait: return "connect-wait";
    case PipeListenerFailureStage::connectComplete: return "connect-complete";
    }
    return "unknown";
}

void PipeListenerRecoveryPolicy::Start() noexcept {
    phase_ = PipeListenerPhase::starting;
    consecutiveFailures_ = 0;
    retryAtMilliseconds_ = 0;
    lastFailureStage_ = PipeListenerFailureStage::none;
    lastErrorCode_ = 0;
    lastError_.clear();
}

void PipeListenerRecoveryPolicy::MarkListening() noexcept {
    if (phase_ != PipeListenerPhase::fatal) {
        phase_ = PipeListenerPhase::listening;
        retryAtMilliseconds_ = 0;
    }
}

void PipeListenerRecoveryPolicy::MarkConnected() noexcept {
    if (phase_ == PipeListenerPhase::fatal) return;
    if (consecutiveFailures_ != 0) ++successfulRecoveries_;
    consecutiveFailures_ = 0;
    retryAtMilliseconds_ = 0;
    phase_ = PipeListenerPhase::connected;
}

void PipeListenerRecoveryPolicy::MarkDisconnected() noexcept {
    if (phase_ != PipeListenerPhase::fatal) phase_ = PipeListenerPhase::starting;
}

void PipeListenerRecoveryPolicy::Stop() noexcept {
    if (phase_ != PipeListenerPhase::fatal) phase_ = PipeListenerPhase::stopped;
    retryAtMilliseconds_ = 0;
}

void PipeListenerRecoveryPolicy::Fail(const PipeListenerFailureStage stage,
                                      const std::uint32_t errorCode,
                                      std::string detail,
                                      const std::uint64_t nowMilliseconds) {
    if (phase_ == PipeListenerPhase::fatal) return;
    ++consecutiveFailures_;
    ++totalFailures_;
    lastFailureStage_ = stage;
    lastErrorCode_ = errorCode;
    lastError_ = BoundedError(std::move(detail));
    if (consecutiveFailures_ >= kMaximumFailures) {
        phase_ = PipeListenerPhase::fatal;
        retryAtMilliseconds_ = 0;
        return;
    }

    const auto exponent = std::min<std::uint32_t>(consecutiveFailures_ - 1, 31);
    const auto multiplied = kInitialRetryDelayMs << exponent;
    const auto delay = std::min(multiplied, kMaximumRetryDelayMs);
    retryAtMilliseconds_ = SaturatingAdd(nowMilliseconds, delay);
    phase_ = PipeListenerPhase::retryWait;
}

PipeListenerRecoverySnapshot PipeListenerRecoveryPolicy::Snapshot(
    const std::uint64_t nowMilliseconds) const {
    PipeListenerRecoverySnapshot result;
    result.phase = phase_;
    result.healthy = phase_ == PipeListenerPhase::listening ||
                     phase_ == PipeListenerPhase::connected;
    result.degraded = consecutiveFailures_ != 0 ||
                      phase_ == PipeListenerPhase::retryWait;
    result.fatal = phase_ == PipeListenerPhase::fatal;
    result.consecutiveFailures = consecutiveFailures_;
    result.maximumFailures = kMaximumFailures;
    result.totalFailures = totalFailures_;
    result.successfulRecoveries = successfulRecoveries_;
    if (phase_ == PipeListenerPhase::retryWait) {
        result.retryInMilliseconds = nowMilliseconds >= retryAtMilliseconds_
                                         ? 0
                                         : retryAtMilliseconds_ - nowMilliseconds;
    }
    result.lastFailureStage = lastFailureStage_;
    result.lastErrorCode = lastErrorCode_;
    result.lastError = lastError_;
    return result;
}

} // namespace pbwin

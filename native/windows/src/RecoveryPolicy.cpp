#include "pbwin/RecoveryPolicy.hpp"

#include <algorithm>
#include <limits>
#include <utility>

namespace pbwin {
namespace {

constexpr std::size_t kMaximumDetailBytes = 1024;

std::uint64_t SaturatingAdd(const std::uint64_t left,
                            const std::uint64_t right) noexcept {
    if (right > std::numeric_limits<std::uint64_t>::max() - left) {
        return std::numeric_limits<std::uint64_t>::max();
    }
    return left + right;
}

std::string BoundedDetail(std::string detail) {
    if (detail.size() > kMaximumDetailBytes) detail.resize(kMaximumDetailBytes);
    return detail;
}

int TriggerPriority(const RecoveryTrigger value) noexcept {
    switch (value) {
    case RecoveryTrigger::deviceRemoved: return 4;
    case RecoveryTrigger::renderFailure: return 3;
    case RecoveryTrigger::frameLatencyFailure: return 2;
    case RecoveryTrigger::displayChange: return 1;
    case RecoveryTrigger::none: return 0;
    }
    return 0;
}

} // namespace

std::string RecoveryTriggerName(const RecoveryTrigger value) {
    switch (value) {
    case RecoveryTrigger::none: return "none";
    case RecoveryTrigger::displayChange: return "display-change";
    case RecoveryTrigger::frameLatencyFailure: return "frame-latency-failure";
    case RecoveryTrigger::renderFailure: return "render-failure";
    case RecoveryTrigger::deviceRemoved: return "device-removed";
    }
    return "unknown";
}

std::string RecoveryPhaseName(const RecoveryPhase value) {
    switch (value) {
    case RecoveryPhase::idle: return "idle";
    case RecoveryPhase::debouncing: return "debouncing";
    case RecoveryPhase::retryWait: return "retry-wait";
    case RecoveryPhase::attempting: return "attempting";
    case RecoveryPhase::exhausted: return "exhausted";
    }
    return "unknown";
}

void RecoveryPolicy::StartGeneration(const RecoveryTrigger trigger,
                                     const std::uint64_t nowMilliseconds,
                                     std::string detail) {
    ++generation_;
    trigger_ = trigger;
    attempts_ = 0;
    deviceRecreationAttempted_ = false;
    deviceRecreated_ = false;
    triggerDetail_ = BoundedDetail(std::move(detail));
    lastError_.clear();
    const auto debounce = trigger == RecoveryTrigger::displayChange
                              ? kDisplayChangeDebounceMs
                              : 0;
    nextAttemptAtMilliseconds_ = SaturatingAdd(nowMilliseconds, debounce);
    phase_ = debounce == 0 ? RecoveryPhase::retryWait : RecoveryPhase::debouncing;
}

bool RecoveryPolicy::Trigger(const RecoveryTrigger trigger,
                             const std::uint64_t nowMilliseconds,
                             std::string detail) {
    if (trigger == RecoveryTrigger::none) return false;

    if (phase_ == RecoveryPhase::idle || phase_ == RecoveryPhase::exhausted) {
        StartGeneration(trigger, nowMilliseconds, std::move(detail));
        return true;
    }

    const auto incomingPriority = TriggerPriority(trigger);
    const auto activePriority = TriggerPriority(trigger_);
    if (incomingPriority >= activePriority) {
        if (incomingPriority > activePriority) trigger_ = trigger;
        if (!detail.empty()) triggerDetail_ = BoundedDetail(std::move(detail));
    }

    if (trigger_ == RecoveryTrigger::displayChange && attempts_ == 0) {
        // Every window can receive WM_DISPLAYCHANGE. Wait for one quiet period
        // after the final notification rather than rebuilding once per window.
        nextAttemptAtMilliseconds_ = SaturatingAdd(nowMilliseconds,
                                                   kDisplayChangeDebounceMs);
        phase_ = RecoveryPhase::debouncing;
    } else if (trigger != RecoveryTrigger::displayChange &&
               phase_ != RecoveryPhase::attempting) {
        // Present/device failures are already evidence of a broken path and do
        // not need the display-notification quiet period.
        nextAttemptAtMilliseconds_ = nowMilliseconds;
        phase_ = RecoveryPhase::retryWait;
    }
    return false;
}

bool RecoveryPolicy::BeginAttempt(const std::uint64_t nowMilliseconds,
                                  const bool recreatesDevice) noexcept {
    if (phase_ == RecoveryPhase::idle || phase_ == RecoveryPhase::attempting ||
        phase_ == RecoveryPhase::exhausted ||
        nowMilliseconds < nextAttemptAtMilliseconds_) {
        return false;
    }
    ++attempts_;
    deviceRecreationAttempted_ = deviceRecreationAttempted_ || recreatesDevice;
    phase_ = RecoveryPhase::attempting;
    return true;
}

void RecoveryPolicy::FailAttempt(const std::uint64_t nowMilliseconds,
                                 std::string detail) {
    if (phase_ != RecoveryPhase::attempting) return;
    lastError_ = BoundedDetail(std::move(detail));
    if (attempts_ >= kMaximumAttempts) {
        phase_ = RecoveryPhase::exhausted;
        ++exhaustedRecoveries_;
        return;
    }

    const auto exponent = std::min<std::uint32_t>(attempts_ - 1, 31);
    const auto multiplied = kInitialRetryDelayMs << exponent;
    const auto delay = std::min(multiplied, kMaximumRetryDelayMs);
    nextAttemptAtMilliseconds_ = SaturatingAdd(nowMilliseconds, delay);
    phase_ = RecoveryPhase::retryWait;
}

void RecoveryPolicy::Succeed(const bool deviceRecreated) noexcept {
    if (phase_ != RecoveryPhase::attempting) return;
    deviceRecreated_ = deviceRecreated;
    lastError_.clear();
    phase_ = RecoveryPhase::idle;
    ++successfulRecoveries_;
}

RecoverySnapshot RecoveryPolicy::Snapshot(const std::uint64_t nowMilliseconds) const {
    RecoverySnapshot result;
    result.active = Active();
    result.phase = phase_;
    result.trigger = trigger_;
    result.generation = generation_;
    result.attempts = attempts_;
    result.maximumAttempts = kMaximumAttempts;
    if (phase_ == RecoveryPhase::debouncing || phase_ == RecoveryPhase::retryWait) {
        result.retryInMilliseconds = nowMilliseconds >= nextAttemptAtMilliseconds_
                                         ? 0
                                         : nextAttemptAtMilliseconds_ - nowMilliseconds;
    }
    result.exhausted = Exhausted();
    result.deviceRecreationAttempted = deviceRecreationAttempted_;
    result.deviceRecreated = deviceRecreated_;
    result.successfulRecoveries = successfulRecoveries_;
    result.exhaustedRecoveries = exhaustedRecoveries_;
    result.triggerDetail = triggerDetail_;
    result.lastError = lastError_;
    return result;
}

} // namespace pbwin

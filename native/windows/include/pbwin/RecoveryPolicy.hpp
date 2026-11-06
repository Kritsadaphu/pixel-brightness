#pragma once

#include <cstdint>
#include <optional>
#include <string>

namespace pbwin {

enum class RecoveryTrigger {
    none,
    displayChange,
    frameLatencyFailure,
    renderFailure,
    deviceRemoved,
};

enum class RecoveryPhase {
    idle,
    debouncing,
    retryWait,
    attempting,
    exhausted,
};

std::string RecoveryTriggerName(RecoveryTrigger value);
std::string RecoveryPhaseName(RecoveryPhase value);

struct RecoverySnapshot {
    bool active{};
    RecoveryPhase phase{RecoveryPhase::idle};
    RecoveryTrigger trigger{RecoveryTrigger::none};
    std::uint64_t generation{};
    std::uint32_t attempts{};
    std::uint32_t maximumAttempts{};
    std::optional<std::uint64_t> retryInMilliseconds;
    bool exhausted{};
    bool deviceRecreationAttempted{};
    bool deviceRecreated{};
    std::uint64_t successfulRecoveries{};
    std::uint64_t exhaustedRecoveries{};
    std::string triggerDetail;
    std::string lastError;
};

// A clock-injected, platform-neutral recovery state machine. RendererApp owns
// the Windows/DXGI work; this class makes debounce, retry and exhaustion rules
// deterministic and unit-testable without a GPU.
class RecoveryPolicy final {
public:
    static constexpr std::uint64_t kDisplayChangeDebounceMs = 750;
    static constexpr std::uint64_t kInitialRetryDelayMs = 250;
    static constexpr std::uint64_t kMaximumRetryDelayMs = 4000;
    static constexpr std::uint32_t kMaximumAttempts = 10;

    // Returns true only when a new recovery generation was started. Repeated
    // WM_DISPLAYCHANGE notifications before the first attempt extend one quiet
    // window instead of creating more rebuilds.
    bool Trigger(RecoveryTrigger trigger,
                 std::uint64_t nowMilliseconds,
                 std::string detail = {});
    bool BeginAttempt(std::uint64_t nowMilliseconds,
                      bool recreatesDevice) noexcept;
    void FailAttempt(std::uint64_t nowMilliseconds, std::string detail);
    void Succeed(bool deviceRecreated) noexcept;

    [[nodiscard]] bool Active() const noexcept { return phase_ != RecoveryPhase::idle; }
    [[nodiscard]] bool Exhausted() const noexcept { return phase_ == RecoveryPhase::exhausted; }
    [[nodiscard]] RecoveryTrigger TriggerReason() const noexcept { return trigger_; }
    [[nodiscard]] RecoverySnapshot Snapshot(std::uint64_t nowMilliseconds) const;

private:
    void StartGeneration(RecoveryTrigger trigger,
                         std::uint64_t nowMilliseconds,
                         std::string detail);

    RecoveryPhase phase_{RecoveryPhase::idle};
    RecoveryTrigger trigger_{RecoveryTrigger::none};
    std::uint64_t generation_{};
    std::uint32_t attempts_{};
    std::uint64_t nextAttemptAtMilliseconds_{};
    bool deviceRecreationAttempted_{};
    bool deviceRecreated_{};
    std::uint64_t successfulRecoveries_{};
    std::uint64_t exhaustedRecoveries_{};
    std::string triggerDetail_;
    std::string lastError_;
};

} // namespace pbwin

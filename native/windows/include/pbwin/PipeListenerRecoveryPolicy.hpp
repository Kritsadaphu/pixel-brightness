#pragma once

#include <cstddef>
#include <cstdint>
#include <optional>
#include <string>
#include <string_view>

namespace pbwin {

enum class PipeListenerPhase {
    stopped,
    starting,
    listening,
    connected,
    retryWait,
    fatal,
};

enum class PipeListenerFailureStage {
    none,
    createPipe,
    connectionState,
    connectEvent,
    connectStart,
    connectWait,
    connectComplete,
};

[[nodiscard]] std::string_view PipeListenerPhaseName(PipeListenerPhase value) noexcept;
[[nodiscard]] std::string_view PipeListenerFailureStageName(
    PipeListenerFailureStage value) noexcept;

struct PipeListenerRecoverySnapshot {
    PipeListenerPhase phase{PipeListenerPhase::stopped};
    bool healthy{};
    bool degraded{};
    bool fatal{};
    std::uint32_t consecutiveFailures{};
    std::uint32_t maximumFailures{};
    std::uint64_t totalFailures{};
    std::uint64_t successfulRecoveries{};
    std::optional<std::uint64_t> retryInMilliseconds;
    PipeListenerFailureStage lastFailureStage{PipeListenerFailureStage::none};
    std::uint32_t lastErrorCode{};
    std::string lastError;
};

// Platform-neutral policy for the Windows listener setup loop. NamedPipeServer
// owns the actual handles and stop-aware wait; this class makes the bounded
// backoff and exhaustion decision deterministic and independently testable.
class PipeListenerRecoveryPolicy final {
public:
    static constexpr std::uint64_t kInitialRetryDelayMs = 50;
    static constexpr std::uint64_t kMaximumRetryDelayMs = 1000;
    static constexpr std::uint32_t kMaximumFailures = 8;
    static constexpr std::size_t kMaximumErrorBytes = 512;

    void Start() noexcept;
    void MarkListening() noexcept;
    void MarkConnected() noexcept;
    void MarkDisconnected() noexcept;
    void Stop() noexcept;
    void Fail(PipeListenerFailureStage stage,
              std::uint32_t errorCode,
              std::string detail,
              std::uint64_t nowMilliseconds);

    [[nodiscard]] bool Fatal() const noexcept {
        return phase_ == PipeListenerPhase::fatal;
    }
    [[nodiscard]] PipeListenerRecoverySnapshot Snapshot(
        std::uint64_t nowMilliseconds) const;

private:
    PipeListenerPhase phase_{PipeListenerPhase::stopped};
    std::uint32_t consecutiveFailures_{};
    std::uint64_t totalFailures_{};
    std::uint64_t successfulRecoveries_{};
    std::uint64_t retryAtMilliseconds_{};
    PipeListenerFailureStage lastFailureStage_{PipeListenerFailureStage::none};
    std::uint32_t lastErrorCode_{};
    std::string lastError_;
};

} // namespace pbwin

#include "pbwin/RecoveryPolicy.hpp"

#include <cstdint>
#include <iostream>
#include <stdexcept>

namespace {

void Require(const bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

} // namespace

int main() {
    try {
        pbwin::RecoveryPolicy policy;
        Require(policy.Trigger(pbwin::RecoveryTrigger::displayChange, 1'000,
                               "WM_DISPLAYCHANGE"),
                "first display event did not start a generation");
        const auto started = policy.Snapshot(1'000);
        Require(started.triggerDetail == "WM_DISPLAYCHANGE" && started.lastError.empty(),
                "trigger detail was mislabeled as an attempt error");
        Require(!policy.BeginAttempt(1'749, true),
                "display change was attempted before the debounce elapsed");
        Require(!policy.Trigger(pbwin::RecoveryTrigger::displayChange, 1'500,
                                "WM_DISPLAYCHANGE burst"),
                "one display burst created multiple generations");
        Require(!policy.BeginAttempt(2'249, true),
                "the final display event did not extend the quiet window");
        Require(policy.BeginAttempt(2'250, true),
                "display recovery did not become ready after the quiet window");

        policy.FailAttempt(2'250, "target missing");
        auto retry = policy.Snapshot(2'250);
        Require(retry.retryInMilliseconds == 250,
                "first retry delay was not bounded to 250 ms");
        Require(!policy.BeginAttempt(2'499, true), "retry ran before its deadline");
        Require(policy.BeginAttempt(2'500, true), "retry did not run at its deadline");
        policy.FailAttempt(2'500, "target still missing");
        Require(policy.Snapshot(2'500).retryInMilliseconds == 500,
                "second retry did not use deterministic exponential backoff");

        std::uint64_t now = 3'000;
        while (!policy.Exhausted()) {
            Require(policy.BeginAttempt(now, true), "bounded retry was not ready");
            policy.FailAttempt(now, "still unavailable");
            const auto snapshot = policy.Snapshot(now);
            if (snapshot.retryInMilliseconds) {
                Require(*snapshot.retryInMilliseconds <=
                            pbwin::RecoveryPolicy::kMaximumRetryDelayMs,
                        "retry delay exceeded its hard cap");
                now += *snapshot.retryInMilliseconds;
            }
        }
        auto exhausted = policy.Snapshot(now);
        Require(exhausted.attempts == pbwin::RecoveryPolicy::kMaximumAttempts,
                "recovery did not exhaust at the configured attempt bound");
        Require(!policy.BeginAttempt(now + 60'000, true),
                "exhausted recovery continued retrying forever");

        Require(policy.Trigger(pbwin::RecoveryTrigger::displayChange, now + 60'001,
                               "projector reconnected"),
                "a new hardware notification did not re-arm exhausted recovery");
        Require(policy.Snapshot(now + 60'001).attempts == 0,
                "new recovery generation inherited exhausted attempts");

        pbwin::RecoveryPolicy immediate;
        Require(immediate.Trigger(pbwin::RecoveryTrigger::renderFailure, 5'000,
                                  "Present failed"),
                "render failure did not start recovery");
        Require(immediate.BeginAttempt(5'000, true),
                "render failure incorrectly waited for display debounce");
        immediate.Succeed(true);
        const auto succeeded = immediate.Snapshot(5'000);
        Require(!succeeded.active && succeeded.successfulRecoveries == 1,
                "successful recovery did not return to idle");
        Require(succeeded.deviceRecreationAttempted && succeeded.deviceRecreated,
                "device recreation evidence was not retained");

        pbwin::RecoveryPolicy mixed;
        Require(mixed.Trigger(pbwin::RecoveryTrigger::deviceRemoved, 10'000,
                              "device reset"),
                "device removal did not start recovery");
        Require(!mixed.Trigger(pbwin::RecoveryTrigger::displayChange, 10'001,
                               "lower-priority display broadcast"),
                "mixed triggers created an extra generation");
        Require(mixed.BeginAttempt(10'001, true),
                "a lower-priority display broadcast delayed immediate device recovery");
        Require(mixed.Snapshot(10'001).triggerDetail == "device reset",
                "a lower-priority display broadcast replaced the device-failure evidence");

        std::cout << "pbwin recovery policy tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pbwin recovery policy tests failed: " << error.what() << '\n';
        return 1;
    }
}

#include "pbwin/PipeListenerRecoveryPolicy.hpp"

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
        pbwin::PipeListenerRecoveryPolicy recovered;
        recovered.Start();
        Require(recovered.Snapshot(1'000).phase ==
                    pbwin::PipeListenerPhase::starting,
                "listener did not enter starting state");

        recovered.Fail(pbwin::PipeListenerFailureStage::createPipe, 8,
                       "CreateNamedPipeW injected failure", 1'000);
        auto retry = recovered.Snapshot(1'000);
        Require(retry.retryInMilliseconds == 50,
                "first listener retry delay was not 50 ms");
        Require(retry.consecutiveFailures == 1 && retry.degraded && !retry.fatal,
                "first listener failure was not observable as degraded");

        recovered.Fail(pbwin::PipeListenerFailureStage::connectionState, 0,
                       "PipeConnection allocation injected failure", 1'050);
        retry = recovered.Snapshot(1'050);
        Require(retry.retryInMilliseconds == 100,
                "second listener retry did not use exponential backoff");
        recovered.Fail(pbwin::PipeListenerFailureStage::connectEvent, 8,
                       "connect event injected failure", 1'150);
        Require(recovered.Snapshot(1'150).retryInMilliseconds == 200,
                "third listener setup stage did not share the retry budget");

        recovered.MarkListening();
        auto listening = recovered.Snapshot(1'350);
        Require(listening.healthy && listening.degraded &&
                    listening.consecutiveFailures == 3,
                "arming the listener erased failure evidence before a connection proved recovery");
        recovered.MarkConnected();
        const auto connected = recovered.Snapshot(1'350);
        Require(connected.healthy && !connected.degraded &&
                    connected.consecutiveFailures == 0 &&
                    connected.successfulRecoveries == 1,
                "a successful connection did not reset the consecutive failure budget");

        pbwin::PipeListenerRecoveryPolicy exhausted;
        exhausted.Start();
        std::uint64_t now = 5'000;
        for (std::uint32_t attempt = 1;
             attempt <= pbwin::PipeListenerRecoveryPolicy::kMaximumFailures;
             ++attempt) {
            const auto stage = attempt % 3 == 1
                                   ? pbwin::PipeListenerFailureStage::createPipe
                               : attempt % 3 == 2
                                   ? pbwin::PipeListenerFailureStage::connectionState
                                   : pbwin::PipeListenerFailureStage::connectWait;
            exhausted.Fail(stage, 8, "deterministic injected failure", now);
            const auto snapshot = exhausted.Snapshot(now);
            Require(snapshot.consecutiveFailures == attempt,
                    "listener failure count changed non-deterministically");
            if (attempt < pbwin::PipeListenerRecoveryPolicy::kMaximumFailures) {
                Require(snapshot.retryInMilliseconds.has_value() &&
                            *snapshot.retryInMilliseconds <=
                                pbwin::PipeListenerRecoveryPolicy::kMaximumRetryDelayMs,
                        "listener retry was missing or exceeded its hard delay cap");
                now += *snapshot.retryInMilliseconds;
            }
        }
        const auto fatal = exhausted.Snapshot(now);
        Require(fatal.fatal && fatal.phase == pbwin::PipeListenerPhase::fatal,
                "listener did not enter fatal state at the hard failure bound");
        Require(!fatal.retryInMilliseconds.has_value(),
                "fatal listener still advertised another retry");
        exhausted.MarkListening();
        exhausted.MarkConnected();
        Require(exhausted.Snapshot(now + 60'000).fatal,
                "fatal listener was revived without a supervised process restart");

        std::cout << "pbwin pipe listener recovery policy tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pbwin pipe listener recovery policy tests failed: "
                  << error.what() << '\n';
        return 1;
    }
}

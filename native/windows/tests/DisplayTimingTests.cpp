#include "pbwin/DisplayTiming.hpp"

#include <cstdint>
#include <iostream>
#include <limits>
#include <stdexcept>

namespace {

void Require(const bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

} // namespace

int main() {
    try {
        pbwin::DisplayTimingTracker timing;
        auto empty = timing.Snapshot(20'000, 10'000);
        Require(!empty.available, "uninitialized timing was marked available");
        Require(!empty.lastQueryResult.has_value(), "uninitialized timing invented a query result");
        Require(!empty.lastQueryQpc.has_value(), "uninitialized timing invented a query time");
        Require(!empty.presentCount.has_value(), "uninitialized timing invented a present count");
        Require(!empty.droppedPresents.has_value(), "uninitialized timing invented zero drops");

        timing.MarkDisjoint(static_cast<std::int32_t>(0x887A000B), 20'000);
        auto disjoint = timing.Snapshot(20'000, 10'000);
        Require(!disjoint.available && disjoint.status == "disjoint",
                "DXGI disjoint state was not fail-closed");
        Require(disjoint.discontinuities == 1, "discontinuity was not counted");

        timing.Observe({100, 1'000, 1'001, 30'000}, 0, 30'050);
        auto baseline = timing.Snapshot(30'500, 10'000);
        Require(baseline.available && baseline.presentCount == 100,
                "first valid display sample was not published");
        Require(baseline.sampleAgeMilliseconds.has_value() &&
                    *baseline.sampleAgeMilliseconds == 50.0,
                "display sample age did not use the QPC domain");
        Require(baseline.droppedPresents == 0 && baseline.repeatedRefreshes == 0,
                "baseline invented a display glitch");

        timing.Observe({101, 1'001, 1'002, 40'000}, 0, 40'050);
        timing.Observe({103, 1'002, 1'003, 50'000}, 0, 50'050);
        timing.Observe({104, 1'005, 1'006, 60'000}, 0, 60'050);
        const auto glitches = timing.Snapshot(60'100, 10'000);
        Require(glitches.droppedPresents == 1,
                "skipped present IDs were not distinguished from submissions");
        Require(glitches.repeatedRefreshes == 2,
                "held monitor refreshes were not counted");
        Require(glitches.latePresentEvents == 1 &&
                    glitches.maximumLatenessRefreshes == 2,
                "late display interval was not detected");

        const auto sequence = glitches.sampleSequence;
        timing.Observe({104, 1'005, 1'006, 60'000}, 0, 61'000);
        Require(timing.Snapshot(61'000, 10'000).sampleSequence == sequence,
                "re-reading one DXGI sample was mislabeled as new scanout");

        timing.MarkUnavailable("occluded", 0x087A0001, 70'000);
        const auto occluded = timing.Snapshot(70'000, 10'000);
        Require(!occluded.available && !occluded.presentCount.has_value(),
                "occluded output retained stale physical evidence");
        Require(occluded.droppedPresents == 1,
                "historical observed glitches were lost when timing became unavailable");

        timing.Observe({500, 9'000, 9'001, 80'000}, 0, 80'010);
        const auto recovered = timing.Snapshot(80'010, 10'000);
        Require(recovered.droppedPresents == 1 && recovered.repeatedRefreshes == 2,
                "recovery compared counters across an unavailable interval");

        // UINT counters are defined to wrap; the delta across the wrap remains
        // one present and one monitor refresh, not a discontinuity or glitch.
        pbwin::DisplayTimingTracker wrapped;
        constexpr auto maximum = std::numeric_limits<std::uint32_t>::max();
        wrapped.Observe({maximum, maximum, maximum, 90'000}, 0, 90'000);
        wrapped.Observe({0, 0, 0, 100'000}, 0, 100'000);
        const auto wrappedResult = wrapped.Snapshot(100'000, 10'000);
        Require(wrappedResult.droppedPresents == 0 && wrappedResult.repeatedRefreshes == 0,
                "UINT frame-statistics wrap was treated as a glitch");

        std::cout << "pbwin display timing tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pbwin display timing tests failed: " << error.what() << '\n';
        return 1;
    }
}

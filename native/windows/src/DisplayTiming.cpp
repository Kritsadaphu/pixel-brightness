#include "pbwin/DisplayTiming.hpp"

#include <algorithm>

namespace pbwin {
namespace {

std::uint32_t CounterDelta(const std::uint32_t current,
                           const std::uint32_t previous) noexcept {
    // DXGI's frame-statistics members are UINT running counters. Unsigned
    // subtraction preserves the correct delta across their defined wrap.
    return current - previous;
}

} // namespace

void DisplayTimingTracker::Observe(const DisplayTimingSample& sample,
                                   const std::int32_t queryResult,
                                   const std::int64_t queryQpc) noexcept {
    lastQueryResult_ = queryResult;
    lastQueryQpc_ = queryQpc;
    status_ = "available";
    available_ = true;

    const auto changed = !hasBaseline_ ||
                         sample.presentCount != latest_.presentCount ||
                         sample.presentRefreshCount != latest_.presentRefreshCount ||
                         sample.syncRefreshCount != latest_.syncRefreshCount ||
                         sample.syncQpcTime != latest_.syncQpcTime;
    if (!changed) return;

    if (hasBaseline_) {
        const auto presentDelta = CounterDelta(sample.presentCount, latest_.presentCount);
        const auto refreshDelta = CounterDelta(sample.presentRefreshCount,
                                               latest_.presentRefreshCount);
        if (presentDelta > refreshDelta) {
            // Present IDs advanced faster than monitor refreshes: one or more
            // accepted presents never became the image identified on screen.
            droppedPresents_ += static_cast<std::uint64_t>(presentDelta - refreshDelta);
        } else if (refreshDelta > presentDelta) {
            // The previous image remained visible for extra refresh periods.
            const auto lateness = refreshDelta - presentDelta;
            repeatedRefreshes_ += static_cast<std::uint64_t>(lateness);
            ++latePresentEvents_;
            maximumLatenessRefreshes_ = std::max(maximumLatenessRefreshes_, lateness);
        }
    }

    latest_ = sample;
    hasBaseline_ = true;
    ++sampleSequence_;
}

void DisplayTimingTracker::MarkDisjoint(const std::int32_t queryResult,
                                        const std::int64_t queryQpc) noexcept {
    ++discontinuities_;
    MarkUnavailable("disjoint", queryResult, queryQpc);
}

void DisplayTimingTracker::MarkUnavailable(const std::string_view status,
                                           const std::int32_t queryResult,
                                           const std::int64_t queryQpc) noexcept {
    status_ = status;
    lastQueryResult_ = queryResult;
    lastQueryQpc_ = queryQpc;
    available_ = false;
    hasBaseline_ = false;
    ClearCurrentSample();
}

DisplayTimingSnapshot DisplayTimingTracker::Snapshot(const std::int64_t nowQpc,
                                                     const std::int64_t qpcFrequency) const noexcept {
    DisplayTimingSnapshot result;
    result.available = available_;
    result.status = status_;
    result.lastQueryResult = lastQueryResult_;
    result.lastQueryQpc = lastQueryQpc_;
    result.sampleSequence = sampleSequence_;
    result.discontinuities = discontinuities_;
    if (sampleSequence_ != 0) {
        result.droppedPresents = droppedPresents_;
        result.repeatedRefreshes = repeatedRefreshes_;
        result.latePresentEvents = latePresentEvents_;
        result.maximumLatenessRefreshes = maximumLatenessRefreshes_;
    }
    if (!available_ || !hasBaseline_) return result;

    result.presentCount = latest_.presentCount;
    result.presentRefreshCount = latest_.presentRefreshCount;
    result.syncRefreshCount = latest_.syncRefreshCount;
    result.syncQpcTime = latest_.syncQpcTime;
    if (qpcFrequency > 0 && nowQpc >= latest_.syncQpcTime) {
        result.sampleAgeMilliseconds =
            static_cast<double>(nowQpc - latest_.syncQpcTime) * 1000.0 /
            static_cast<double>(qpcFrequency);
    }
    return result;
}

void DisplayTimingTracker::ClearCurrentSample() noexcept {
    latest_ = {};
}

} // namespace pbwin

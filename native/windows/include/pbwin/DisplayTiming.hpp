#pragma once

#include <cstdint>
#include <optional>
#include <string_view>

namespace pbwin {

struct DisplayTimingSample {
    std::uint32_t presentCount{};
    std::uint32_t presentRefreshCount{};
    std::uint32_t syncRefreshCount{};
    std::int64_t syncQpcTime{};
};

struct DisplayTimingSnapshot {
    bool available{};
    std::string_view status{"uninitialized"};
    std::optional<std::int32_t> lastQueryResult;
    std::optional<std::int64_t> lastQueryQpc;
    std::optional<std::uint32_t> presentCount;
    std::optional<std::uint32_t> presentRefreshCount;
    std::optional<std::uint32_t> syncRefreshCount;
    std::optional<std::int64_t> syncQpcTime;
    std::optional<double> sampleAgeMilliseconds;
    std::uint64_t sampleSequence{};
    std::uint64_t discontinuities{};
    std::optional<std::uint64_t> droppedPresents;
    std::optional<std::uint64_t> repeatedRefreshes;
    std::optional<std::uint64_t> latePresentEvents;
    std::optional<std::uint32_t> maximumLatenessRefreshes;
};

// Tracks the DXGI counters which identify images that reached a monitor. This
// deliberately has no Present-submission counter: calls accepted by DXGI and
// images observed in frame statistics are different facts.
class DisplayTimingTracker final {
public:
    void Observe(const DisplayTimingSample& sample,
                 std::int32_t queryResult,
                 std::int64_t queryQpc) noexcept;
    void MarkDisjoint(std::int32_t queryResult, std::int64_t queryQpc) noexcept;
    void MarkUnavailable(std::string_view status,
                         std::int32_t queryResult,
                         std::int64_t queryQpc) noexcept;
    [[nodiscard]] DisplayTimingSnapshot Snapshot(std::int64_t nowQpc,
                                                 std::int64_t qpcFrequency) const noexcept;

private:
    void ClearCurrentSample() noexcept;

    bool available_{};
    bool hasBaseline_{};
    std::string_view status_{"uninitialized"};
    std::optional<std::int32_t> lastQueryResult_;
    std::optional<std::int64_t> lastQueryQpc_;
    DisplayTimingSample latest_{};
    std::uint64_t sampleSequence_{};
    std::uint64_t discontinuities_{};
    std::uint64_t droppedPresents_{};
    std::uint64_t repeatedRefreshes_{};
    std::uint64_t latePresentEvents_{};
    std::uint32_t maximumLatenessRefreshes_{};
};

} // namespace pbwin

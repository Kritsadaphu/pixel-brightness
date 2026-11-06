#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace pbcamera {

struct FrameSize final {
    std::uint32_t width{};
    std::uint32_t height{};

    friend constexpr bool operator==(const FrameSize&, const FrameSize&) = default;
};

struct FullFrameAreaBinPlan final {
    FrameSize source{};
    FrameSize retained{};
    std::uint32_t binX{};
    std::uint32_t binY{};

    friend constexpr bool operator==(const FullFrameAreaBinPlan&,
                                     const FullFrameAreaBinPlan&) = default;
};

// Builds a crop-free, integer full-frame reduction. Partial edge blocks and
// interpolation are intentionally forbidden because either would change the
// optical geometry without an exact provenance record.
FullFrameAreaBinPlan MakeFullFrameAreaBinPlan(
    FrameSize source,
    std::uint32_t binX = 4,
    std::uint32_t binY = 4);

// Chooses the smallest equal integer factor whose crop-free retained frame
// satisfies every caller limit. This makes the transform deterministic while
// allowing the orchestration memory budget to vary by capture plan.
FullFrameAreaBinPlan ChooseFullFrameAreaBinPlan(
    FrameSize source,
    std::uint64_t maximumPixels,
    std::uint32_t maximumWidth,
    std::uint32_t maximumHeight);

// Derives and validates the one equal integer factor that maps the complete
// source frame to an exact lens-profile frame.
FullFrameAreaBinPlan MakeFullFrameAreaBinPlanForRetained(
    FrameSize source,
    FrameSize retained);

// Input and output are tightly packed, row-major linear RGB float samples.
// Every output channel is the fixed-order mean of one complete source block.
std::vector<float> AreaBinLinearRgb(
    std::span<const float> source,
    const FullFrameAreaBinPlan& plan);

} // namespace pbcamera

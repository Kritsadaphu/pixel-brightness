#include "pbcamera/AreaBin.hpp"

#include <cmath>
#include <limits>
#include <stdexcept>

namespace pbcamera {
namespace {

std::size_t CheckedSamples(const FrameSize frame) {
    if (frame.width == 0 || frame.height == 0) {
        throw std::invalid_argument("area-bin frame dimensions must be positive");
    }
    constexpr auto maximum = std::numeric_limits<std::size_t>::max();
    if (frame.width > maximum / frame.height ||
        static_cast<std::size_t>(frame.width) * frame.height > maximum / 3U) {
        throw std::overflow_error("area-bin frame sample count overflowed");
    }
    return static_cast<std::size_t>(frame.width) * frame.height * 3U;
}

} // namespace

FullFrameAreaBinPlan MakeFullFrameAreaBinPlan(
    const FrameSize source,
    const std::uint32_t binX,
    const std::uint32_t binY) {
    (void)CheckedSamples(source);
    if (binX < 2 || binY < 2 || binX > 64 || binY > 64) {
        throw std::invalid_argument("area-bin factors must be between 2 and 64");
    }
    if (source.width % binX != 0 || source.height % binY != 0) {
        throw std::invalid_argument(
            "full-frame area-bin factors must divide the source dimensions exactly");
    }
    FullFrameAreaBinPlan plan{
        .source = source,
        .retained = {source.width / binX, source.height / binY},
        .binX = binX,
        .binY = binY,
    };
    (void)CheckedSamples(plan.retained);
    return plan;
}

FullFrameAreaBinPlan ChooseFullFrameAreaBinPlan(
    const FrameSize source,
    const std::uint64_t maximumPixels,
    const std::uint32_t maximumWidth,
    const std::uint32_t maximumHeight) {
    if (maximumPixels == 0 || maximumWidth == 0 || maximumHeight == 0) {
        throw std::invalid_argument("area-bin limits must be positive");
    }
    for (std::uint32_t factor = 2; factor <= 64; ++factor) {
        if (source.width % factor != 0 || source.height % factor != 0) continue;
        const auto retainedWidth = source.width / factor;
        const auto retainedHeight = source.height / factor;
        const auto retainedPixels =
            static_cast<std::uint64_t>(retainedWidth) * retainedHeight;
        if (retainedPixels <= maximumPixels && retainedWidth <= maximumWidth &&
            retainedHeight <= maximumHeight) {
            return MakeFullFrameAreaBinPlan(source, factor, factor);
        }
    }
    throw std::invalid_argument(
        "no equal integer full-frame area-bin factor satisfies the capture limits");
}

FullFrameAreaBinPlan MakeFullFrameAreaBinPlanForRetained(
    const FrameSize source,
    const FrameSize retained) {
    (void)CheckedSamples(source);
    (void)CheckedSamples(retained);
    if (source.width % retained.width != 0 || source.height % retained.height != 0) {
        throw std::invalid_argument(
            "lens-profile frame is not an exact integer full-frame reduction");
    }
    const auto binX = source.width / retained.width;
    const auto binY = source.height / retained.height;
    if (binX != binY) {
        throw std::invalid_argument(
            "lens-profile frame requires unequal area-bin factors");
    }
    return MakeFullFrameAreaBinPlan(source, binX, binY);
}

std::vector<float> AreaBinLinearRgb(
    const std::span<const float> source,
    const FullFrameAreaBinPlan& plan) {
    const auto canonical = MakeFullFrameAreaBinPlan(
        plan.source, plan.binX, plan.binY);
    if (canonical != plan) {
        throw std::invalid_argument("area-bin plan contains inconsistent retained dimensions");
    }
    if (source.size() != CheckedSamples(plan.source)) {
        throw std::invalid_argument("area-bin source does not match its declared RGB frame");
    }
    for (const float sample : source) {
        if (!std::isfinite(sample)) {
            throw std::invalid_argument("area-bin source contains a non-finite sample");
        }
    }

    std::vector<float> retained(CheckedSamples(plan.retained));
    const double divisor = static_cast<double>(plan.binX) * plan.binY;
    for (std::uint32_t outputY = 0; outputY < plan.retained.height; ++outputY) {
        for (std::uint32_t outputX = 0; outputX < plan.retained.width; ++outputX) {
            for (std::uint32_t channel = 0; channel < 3; ++channel) {
                double sum = 0.0;
                for (std::uint32_t blockY = 0; blockY < plan.binY; ++blockY) {
                    const auto sourceY = outputY * plan.binY + blockY;
                    for (std::uint32_t blockX = 0; blockX < plan.binX; ++blockX) {
                        const auto sourceX = outputX * plan.binX + blockX;
                        const auto index =
                            (static_cast<std::size_t>(sourceY) * plan.source.width + sourceX) * 3U + channel;
                        sum += static_cast<double>(source[index]);
                    }
                }
                const auto outputIndex =
                    (static_cast<std::size_t>(outputY) * plan.retained.width + outputX) * 3U + channel;
                retained[outputIndex] = static_cast<float>(sum / divisor);
            }
        }
    }
    return retained;
}

} // namespace pbcamera

#pragma once

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace pbwin {

// Owned, tightly packed RGBA8. Never hand a mapped D3D buffer to a network
// worker: Map/Unmap and all immediate-context calls belong to the render thread.
struct NetworkVideoFrame {
    std::uint32_t width{};
    std::uint32_t height{};
    std::uint32_t frameRateNum{60};
    std::uint32_t frameRateDen{1};
    std::uint64_t sequence{};
    // Shared by outputs from the same composition frame, in 100 ns units.
    // This is a sender timecode, NOT evidence of synchronized projector scanout.
    std::int64_t timecode{};
    std::vector<std::uint8_t> rgba;

    static std::size_t ByteCount(std::uint32_t width, std::uint32_t height) {
        // Experimental network path has an explicit per-output 4K ceiling.
        if (width < 1 || height < 1 || width > 4096 || height > 2160)
            throw std::invalid_argument("Network output must be within 4096 x 2160");
        return static_cast<std::size_t>(width) * height * 4;
    }

    void Validate() const {
        if (rgba.size() != ByteCount(width, height))
            throw std::invalid_argument("Network frame byte count mismatch");
        if (!frameRateNum || !frameRateDen || frameRateDen > 1001000 ||
            frameRateNum > 240000 ||
            static_cast<std::uint64_t>(frameRateNum) > 240ULL * frameRateDen)
            throw std::invalid_argument("Invalid network frame rate");
        if (timecode < 0) throw std::invalid_argument("Negative network frame timecode");
    }
};

} // namespace pbwin

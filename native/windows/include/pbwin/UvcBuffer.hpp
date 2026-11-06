#pragma once
#include <cstddef>
#include <cstdint>
#include <stdexcept>
#include <vector>

namespace pbwin {
// RGB32 from Media Foundation is B,G,R,X. Preserve encoded values; do not
// pretend this is RAW, linear light, or an independently verified exposure.
inline std::vector<std::uint8_t> UvcRgb24(const std::uint8_t* storage,
    std::size_t storageBytes, std::size_t topRow, std::ptrdiff_t stride,
    unsigned width, unsigned height) {
  if (!storage || width < 1 || width > 1920 || height < 1 || height > 1080
      || stride == 0 || stride < -1048576 || stride > 1048576
      || static_cast<std::size_t>(stride < 0 ? -stride : stride) < width * 4ULL
      || topRow > storageBytes || storageBytes > 64ULL * 1024 * 1024)
    throw std::runtime_error("Invalid UVC frame layout");
  std::vector<std::uint8_t> rgb(static_cast<std::size_t>(width) * height * 3);
  for (unsigned y = 0; y < height; ++y) {
    const auto row = static_cast<std::int64_t>(topRow) + static_cast<std::int64_t>(y) * stride;
    if (row < 0 || static_cast<std::uint64_t>(row) + width * 4ULL > storageBytes)
      throw std::runtime_error("UVC row is outside the supplied buffer");
    for (unsigned x = 0; x < width; ++x) {
      const auto from = static_cast<std::size_t>(row) + x * 4;
      const auto to = (static_cast<std::size_t>(y) * width + x) * 3;
      rgb[to] = storage[from + 2]; rgb[to + 1] = storage[from + 1]; rgb[to + 2] = storage[from];
    }
  }
  return rgb;
}
}

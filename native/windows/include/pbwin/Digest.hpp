#pragma once

#include <cstddef>
#include <span>
#include <string>
#include <string_view>

namespace pbwin {

std::string Sha256Hex(std::span<const std::byte> bytes);
std::string Sha256Hex(std::string_view text);

} // namespace pbwin

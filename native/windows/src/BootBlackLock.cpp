#include "pbwin/BootBlackLock.hpp"

#include <stdexcept>
#include <utility>

namespace pbwin {
namespace {

bool IsLowerHexDigest(const std::string_view value) noexcept {
    if (value.size() != 64) return false;
    for (const auto character : value) {
        if (!((character >= '0' && character <= '9') ||
              (character >= 'a' && character <= 'f'))) {
            return false;
        }
    }
    return true;
}

bool ConstantTimeEqual(const std::string_view left, const std::string_view right) noexcept {
    if (left.size() != right.size()) return false;
    unsigned char difference{};
    for (std::size_t index = 0; index < left.size(); ++index) {
        difference |= static_cast<unsigned char>(left[index]) ^
                      static_cast<unsigned char>(right[index]);
    }
    return difference == 0;
}

} // namespace

BootBlackLock::BootBlackLock(std::string authorizationDigest)
    : authorizationDigest_(std::move(authorizationDigest)) {
    if (!IsLowerHexDigest(authorizationDigest_)) {
        throw std::invalid_argument("Boot-black authorization digest must be lowercase SHA-256");
    }
}

bool BootBlackLock::Authorize(const std::string_view candidateDigest) const noexcept {
    return ConstantTimeEqual(authorizationDigest_, candidateDigest);
}

BootBlackReleaseResult BootBlackLock::Release(const std::string_view candidateDigest) noexcept {
    if (!Authorize(candidateDigest)) {
        return BootBlackReleaseResult::unauthorized;
    }
    if (!locked_) return BootBlackReleaseResult::alreadyReleased;
    locked_ = false;
    releaseCount_ = 1;
    return BootBlackReleaseResult::released;
}

} // namespace pbwin

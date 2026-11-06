#pragma once

#include <cstdint>
#include <string>
#include <string_view>

namespace pbwin {

enum class BootBlackReleaseResult : std::uint32_t {
    released = 0,
    alreadyReleased = 1,
    unauthorized = 2,
};

// One renderer-process latch. The launcher gives Renderer and Node the same
// ephemeral authorization secret, while Renderer retains only its SHA-256
// digest. No ordinary blank/pattern/config command can mutate this latch.
class BootBlackLock final {
public:
    explicit BootBlackLock(std::string authorizationDigest);

    [[nodiscard]] bool Locked() const noexcept { return locked_; }
    [[nodiscard]] std::uint32_t ReleaseCount() const noexcept { return releaseCount_; }
    // Verifies the per-process credential without changing latch state. The
    // same credential authenticates every mutating IPC command for the renderer
    // lifetime while the boot-black latch remains independently one-shot.
    [[nodiscard]] bool Authorize(std::string_view candidateDigest) const noexcept;
    [[nodiscard]] BootBlackReleaseResult Release(std::string_view candidateDigest) noexcept;

private:
    std::string authorizationDigest_;
    bool locked_{true};
    std::uint32_t releaseCount_{};
};

} // namespace pbwin

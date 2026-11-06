#pragma once

#include "pbwin/Config.hpp"

#include <d3d11.h>
#include <wrl/client.h>

#include <chrono>
#include <cstdint>
#include <memory>
#include <string>

namespace pbwin {

enum class InputState { unavailable, waiting, validating, connected, stale, mismatch, error };

struct SpoutInputStatus {
    InputState state{InputState::waiting};
    std::string detail;
    std::uint32_t width{};
    std::uint32_t height{};
    DXGI_FORMAT format{DXGI_FORMAT_UNKNOWN};
    double expectedFps{};
    double senderFps{};
    double frameRateDelta{};
    bool frameRateValidated{};
    std::int64_t senderFrame{-1};
    bool frameNew{};
    std::uint64_t receivedFrames{};
    std::uint64_t rejectedFrames{};
};

class SpoutInput final {
public:
    static constexpr std::uint64_t kFrameRateSettlingFrames = 30;
    static constexpr double kMinimumFrameRateToleranceFps = 0.5;
    static constexpr double kRelativeFrameRateTolerance = 0.01;

    SpoutInput();
    ~SpoutInput();
    SpoutInput(const SpoutInput&) = delete;
    SpoutInput& operator=(const SpoutInput&) = delete;
    SpoutInput(SpoutInput&& other) noexcept;
    SpoutInput& operator=(SpoutInput&& other) noexcept;

    void Initialize(ID3D11Device* device, const SpoutSourceConfig& config);
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> Poll(ID3D11Device* device);
    void Shutdown() noexcept;

    [[nodiscard]] const SpoutInputStatus& Status() const noexcept { return status_; }
    [[nodiscard]] bool IsValid() const noexcept { return status_.state == InputState::connected; }

private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
    SpoutSourceConfig config_;
    SpoutInputStatus status_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> texture_;
    Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> view_;
    Microsoft::WRL::ComPtr<ID3D11Texture2D> validationTexture_;
    std::uint64_t validationFrames_{};
    bool cadenceRejected_{};
    std::chrono::steady_clock::time_point startedAt_{};
    std::chrono::steady_clock::time_point lastFrameAt_{};
};

std::string InputStateName(InputState value);

} // namespace pbwin

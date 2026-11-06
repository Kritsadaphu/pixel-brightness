#include "pbwin/SpoutInput.hpp"

#include "pbwin/Log.hpp"

#include <algorithm>
#include <cmath>
#include <format>
#include <stdexcept>
#include <utility>

#if PB_WITH_SPOUT
#include <SpoutDX.h>
#endif

namespace pbwin {

struct SpoutInput::Impl {
#if PB_WITH_SPOUT
    spoutDX receiver;
#endif
};

SpoutInput::SpoutInput() = default;
SpoutInput::~SpoutInput() { Shutdown(); }

SpoutInput::SpoutInput(SpoutInput&& other) noexcept
    : impl_(std::move(other.impl_)), config_(std::move(other.config_)),
      status_(std::move(other.status_)), texture_(std::move(other.texture_)),
      view_(std::move(other.view_)), validationTexture_(std::move(other.validationTexture_)),
      validationFrames_(other.validationFrames_), cadenceRejected_(other.cadenceRejected_),
      startedAt_(other.startedAt_),
      lastFrameAt_(other.lastFrameAt_) {}

SpoutInput& SpoutInput::operator=(SpoutInput&& other) noexcept {
    if (this != &other) {
        Shutdown();
        impl_ = std::move(other.impl_);
        config_ = std::move(other.config_);
        status_ = std::move(other.status_);
        texture_ = std::move(other.texture_);
        view_ = std::move(other.view_);
        validationTexture_ = std::move(other.validationTexture_);
        validationFrames_ = other.validationFrames_;
        cadenceRejected_ = other.cadenceRejected_;
        startedAt_ = other.startedAt_;
        lastFrameAt_ = other.lastFrameAt_;
    }
    return *this;
}

void SpoutInput::Initialize(ID3D11Device* device, const SpoutSourceConfig& config) {
    Shutdown();
    config_ = config;
    status_ = {};
    status_.expectedFps = static_cast<double>(config_.frameRateNum) / config_.frameRateDen;
    startedAt_ = std::chrono::steady_clock::now();
    lastFrameAt_ = startedAt_;
    impl_ = std::make_unique<Impl>();
#if PB_WITH_SPOUT
    if (!impl_->receiver.OpenDirectX11(device)) {
        impl_.reset();
        throw std::runtime_error("Spout2 could not bind to the Pixel Brightness D3D11 device");
    }
    impl_->receiver.SetAdapterAuto(false);
    impl_->receiver.SetReceiverName(config_.senderName.c_str());
    status_.state = InputState::waiting;
    status_.detail = "waiting for exact sender " + config_.senderName;
#else
    (void)device;
    status_.state = InputState::unavailable;
    status_.detail = "renderer was built without Spout2";
#endif
}

Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> SpoutInput::Poll(ID3D11Device* device) {
#if !PB_WITH_SPOUT
    (void)device;
    return {};
#else
    if (!impl_) return {};
    const auto now = std::chrono::steady_clock::now();
    if (!impl_->receiver.ReceiveTexture()) {
        texture_.Reset();
        view_.Reset();
        validationTexture_.Reset();
        validationFrames_ = 0;
        cadenceRejected_ = false;
        status_.frameNew = false;
        status_.frameRateValidated = false;
        status_.state = now - startedAt_ < std::chrono::milliseconds(config_.startupGraceMs)
                            ? InputState::waiting
                            : InputState::stale;
        status_.detail = "Spout sender not present: " + config_.senderName;
        return {};
    }

    auto* received = impl_->receiver.GetSenderTexture();
    if (!received) {
        status_.state = InputState::error;
        status_.detail = "Spout connected but exposed no D3D11 texture";
        return {};
    }

    D3D11_TEXTURE2D_DESC description{};
    received->GetDesc(&description);
    status_.width = description.Width;
    status_.height = description.Height;
    status_.format = description.Format;
    const auto measuredFps = impl_->receiver.GetSenderFps();
    // Keep telemetry valid JSON even if a faulty sender exposes NaN/Inf.
    // Zero remains the explicit "measurement unavailable" sentinel and is
    // rejected once the settling window has elapsed.
    status_.senderFps = std::isfinite(measuredFps) && measuredFps > 0 ? measuredFps : 0;
    status_.frameRateDelta = std::abs(status_.senderFps - status_.expectedFps);
    status_.senderFrame = impl_->receiver.GetSenderFrame();
    status_.frameNew = impl_->receiver.IsFrameNew();

    const bool sizeMatches = (!config_.width || description.Width == *config_.width) &&
                             (!config_.height || description.Height == *config_.height);
    const bool formatMatches = std::find(config_.acceptedFormats.begin(), config_.acceptedFormats.end(),
                                         description.Format) != config_.acceptedFormats.end();
    if (!sizeMatches || !formatMatches) {
        ++status_.rejectedFrames;
        validationTexture_.Reset();
        validationFrames_ = 0;
        cadenceRejected_ = false;
        status_.frameRateValidated = false;
        status_.state = InputState::mismatch;
        status_.detail = std::format("expected {}x{} accepted format; received {}x{} {}",
                                     config_.width.value_or(0), config_.height.value_or(0),
                                     description.Width, description.Height,
                                     DxgiFormatName(description.Format));
        texture_.Reset();
        view_.Reset();
        return {};
    }

    // A new shared texture can be a restarted/replaced sender even when its
    // name, dimensions and format are identical. Never inherit cadence proof
    // from the previous resource.
    if (validationTexture_.Get() != received) {
        validationTexture_ = received;
        validationFrames_ = 0;
        cadenceRejected_ = false;
        status_.frameRateValidated = false;
        lastFrameAt_ = now;
    }

    if (status_.frameNew) {
        lastFrameAt_ = now;
        ++status_.receivedFrames;
        ++validationFrames_;
    } else if (now - lastFrameAt_ >= std::chrono::milliseconds(config_.timeoutMs)) {
        texture_.Reset();
        view_.Reset();
        validationTexture_.Reset();
        validationFrames_ = 0;
        cadenceRejected_ = false;
        status_.frameRateValidated = false;
        status_.state = InputState::stale;
        status_.detail = "Spout sender stopped producing new frames";
        return {};
    }

    // Fail black through the complete settling window. Size/format alone are
    // insufficient: exposing the SRV here would visibly accept a wrong-rate
    // sender for roughly one second before the cadence check can reject it.
    if (validationFrames_ < kFrameRateSettlingFrames) {
        texture_.Reset();
        view_.Reset();
        status_.state = cadenceRejected_ ? InputState::mismatch : InputState::validating;
        status_.detail = cadenceRejected_
            ? std::format("revalidating rejected {:.3f} fps sender ({}/{})",
                          status_.senderFps, validationFrames_, kFrameRateSettlingFrames)
            : std::format("validating sender cadence ({}/{})",
                          validationFrames_, kFrameRateSettlingFrames);
        return {};
    }

    status_.frameRateValidated = true;
    const auto tolerance = std::max(kMinimumFrameRateToleranceFps,
                                    status_.expectedFps * kRelativeFrameRateTolerance);
    if (status_.senderFps <= 0 || status_.frameRateDelta > tolerance) {
        if (status_.frameNew) ++status_.rejectedFrames;
        status_.state = InputState::mismatch;
        status_.detail = std::format("expected {:.3f} fps; received {:.3f} fps (delta {:.3f})",
                                     status_.expectedFps, status_.senderFps,
                                     status_.frameRateDelta);
        texture_.Reset();
        view_.Reset();
        validationFrames_ = 0;
        cadenceRejected_ = true;
        status_.frameRateValidated = false;
        return {};
    }

    cadenceRejected_ = false;

    if (!view_ || texture_.Get() != received) {
        texture_ = received;
        view_.Reset();
        ThrowIfFailed(device->CreateShaderResourceView(received, nullptr, view_.ReleaseAndGetAddressOf()),
                      "Create Spout shader resource view");
    }
    status_.state = InputState::connected;
    status_.detail = "connected to " + config_.senderName;
    return view_;
#endif
}

void SpoutInput::Shutdown() noexcept {
#if PB_WITH_SPOUT
    if (impl_) {
        impl_->receiver.ReleaseReceiver();
        impl_->receiver.CloseDirectX11();
    }
#endif
    view_.Reset();
    texture_.Reset();
    validationTexture_.Reset();
    validationFrames_ = 0;
    cadenceRejected_ = false;
    impl_.reset();
    status_ = {};
}

std::string InputStateName(const InputState value) {
    switch (value) {
    case InputState::unavailable: return "unavailable";
    case InputState::waiting: return "waiting";
    case InputState::validating: return "validating";
    case InputState::connected: return "connected";
    case InputState::stale: return "stale";
    case InputState::mismatch: return "mismatch";
    case InputState::error: return "error";
    }
    return "unknown";
}

} // namespace pbwin

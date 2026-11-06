#include "pbwin/OffscreenOutput.hpp"
#include "pbwin/Log.hpp"

#include <cstring>
#include <cmath>
#include <utility>
#include <chrono>

namespace pbwin {

void OffscreenOutput::Initialize(ID3D11Device* device, OutputConfig output,
                                 CanvasConfig canvas,
                                 const std::filesystem::path& shaderDirectory,
                                 const std::filesystem::path& assetDirectory) {
    if (!device || target_) throw std::logic_error("OffscreenOutput requires a fresh instance/device");
    const auto& rect = output.sourceViewport;
    if (!canvas.width || !canvas.height || canvas.width > 16384 || canvas.height > 16384 ||
        !std::isfinite(rect.x) || !std::isfinite(rect.y) || !std::isfinite(rect.width) ||
        !std::isfinite(rect.height) || rect.x < 0 || rect.y < 0 || rect.width <= 0 ||
        rect.height <= 0 || rect.x + rect.width > canvas.width ||
        rect.y + rect.height > canvas.height)
        throw std::invalid_argument("Offscreen source viewport is outside the canvas");
    NetworkVideoFrame check;
    check.width = output.resolution.width;
    check.height = output.resolution.height;
    check.frameRateNum = canvas.frameRateNum;
    check.frameRateDen = canvas.frameRateDen;
    check.rgba.resize(NetworkVideoFrame::ByteCount(check.width, check.height));
    check.Validate();
    output_ = std::move(output);
    canvas_ = canvas;
    D3D11_TEXTURE2D_DESC desc{};
    desc.Width = check.width;
    desc.Height = check.height;
    desc.MipLevels = 1;
    desc.ArraySize = 1;
    desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    desc.SampleDesc.Count = 1;
    desc.Usage = D3D11_USAGE_DEFAULT;
    desc.BindFlags = D3D11_BIND_RENDER_TARGET;
    ThrowIfFailed(device->CreateTexture2D(&desc, nullptr, &target_), "Create offscreen RGBA target");
    ThrowIfFailed(device->CreateRenderTargetView(target_.Get(), nullptr, &view_), "Create offscreen RTV");
    desc.Usage = D3D11_USAGE_STAGING;
    desc.BindFlags = 0;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    const D3D11_QUERY_DESC query{D3D11_QUERY_EVENT, 0};
    for (auto& slot : slots_) {
        ThrowIfFailed(device->CreateTexture2D(&desc, nullptr, &slot.texture), "Create readback slot");
        ThrowIfFailed(device->CreateQuery(&query, &slot.completion), "Create readback completion");
    }
    pipeline_.Initialize(device, shaderDirectory, output_);
    pipeline_.LoadCorrectionAssets(device, output_, assetDirectory);
}

bool OffscreenOutput::Submit(ID3D11DeviceContext* context, ID3D11ShaderResourceView* source,
                             bool sourceValid, bool sourceIsSrgb, PatternConfig pattern,
                             bool blank, std::uint64_t sequence, std::int64_t timecode) {
    if (!context || !view_) throw std::logic_error("Offscreen output not initialized");
    if (timecode < 0) throw std::invalid_argument("Negative network frame timecode");
    if (count_ == slots_.size()) return false;
    auto& slot = slots_[(head_ + count_) % slots_.size()];
    pipeline_.Render(context, view_.Get(), source, sourceValid, output_, canvas_,
                     sourceIsSrgb, pattern, blank);
    // Unbind before CopyResource. Both operations still run on the render thread.
    context->OMSetRenderTargets(0, nullptr, nullptr);
    context->CopyResource(slot.texture.Get(), target_.Get());
    context->End(slot.completion.Get());
    context->Flush(); // No Present() exists on the headless path to flush work.
    slot.sequence = sequence;
    slot.timecode = timecode;
    ++count_;
    return true;
}

std::optional<NetworkVideoFrame> OffscreenOutput::TryReadback(ID3D11DeviceContext* context) {
    if (!context || !view_) throw std::logic_error("Offscreen output not initialized");
    if (!count_) return std::nullopt;
    auto& slot = slots_[head_];
    using Clock = std::chrono::steady_clock;
    const auto pollStart = Clock::now();
    BOOL done{};
    const auto ready = context->GetData(slot.completion.Get(), &done, sizeof(done),
                                        D3D11_ASYNC_GETDATA_DONOTFLUSH);
    ThrowIfFailed(ready, "Poll offscreen readback");
    timing_.pollMs += std::chrono::duration<double, std::milli>(Clock::now() - pollStart).count();
    if (ready == S_FALSE || !done) return std::nullopt;
    NetworkVideoFrame frame;
    frame.width = output_.resolution.width;
    frame.height = output_.resolution.height;
    frame.frameRateNum = canvas_.frameRateNum;
    frame.frameRateDen = canvas_.frameRateDen;
    frame.sequence = slot.sequence;
    frame.timecode = slot.timecode;
    // Allocate before Map so allocation failure cannot leave the texture mapped.
    const auto allocationStart = Clock::now();
    frame.rgba.swap(reusable_);
    frame.rgba.resize(NetworkVideoFrame::ByteCount(frame.width, frame.height));
    timing_.allocationMs += std::chrono::duration<double, std::milli>(Clock::now() - allocationStart).count();
    D3D11_MAPPED_SUBRESOURCE mapped{};
    const auto mapStart = Clock::now();
    const auto result = context->Map(slot.texture.Get(), 0, D3D11_MAP_READ,
                                      D3D11_MAP_FLAG_DO_NOT_WAIT, &mapped);
    timing_.mapMs += std::chrono::duration<double, std::milli>(Clock::now() - mapStart).count();
    if (result == DXGI_ERROR_WAS_STILL_DRAWING) { frame.rgba.swap(reusable_); return std::nullopt; }
    ThrowIfFailed(result, "Map offscreen readback");
    const std::size_t rowBytes = static_cast<std::size_t>(frame.width) * 4;
    if (mapped.RowPitch < rowBytes || !mapped.pData) {
        context->Unmap(slot.texture.Get(), 0);
        throw std::runtime_error("Invalid GPU readback row pitch");
    }
    const auto copyStart = Clock::now();
    for (std::size_t row = 0; row < frame.height; ++row)
        std::memcpy(frame.rgba.data() + row * rowBytes,
                    static_cast<const std::uint8_t*>(mapped.pData) + row * mapped.RowPitch,
                    rowBytes);
    context->Unmap(slot.texture.Get(), 0);
    timing_.copyMs += std::chrono::duration<double, std::milli>(Clock::now() - copyStart).count();
    head_ = (head_ + 1) % slots_.size();
    --count_;
    return frame;
}

void OffscreenOutput::DiscardPending() noexcept {
    // Copy/query work remains ordered on the same context; reusing a discarded
    // slot queues its next write after the previous write, never concurrently.
    count_ = 0;
    head_ = 0;
}

} // namespace pbwin

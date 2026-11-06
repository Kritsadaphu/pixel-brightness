#include "pbwin/OutputSurface.hpp"

#include "pbwin/D3DDevice.hpp"
#include "pbwin/Log.hpp"

#include <Windows.h>

#include <chrono>
#include <algorithm>
#include <filesystem>
#include <stdexcept>

namespace pbwin {
namespace {

std::filesystem::path ShaderDirectory() {
    std::wstring buffer(32768, L'\0');
    const auto length = GetModuleFileNameW(nullptr, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) throw std::runtime_error("GetModuleFileNameW failed");
    buffer.resize(length);
    return std::filesystem::path(buffer).parent_path() / L"shaders";
}

bool EqualRefresh(const ResolutionConfig& configured, const DisplayDescriptor& display) {
    if (display.refreshNum == 0) return false;
    const auto left = static_cast<std::uint64_t>(configured.refreshNum) * display.refreshDen;
    const auto right = static_cast<std::uint64_t>(display.refreshNum) * configured.refreshDen;
    const auto difference = left > right ? left - right : right - left;
    // Tolerate EDID 59.94 versus an operator-entered 60/1 selector.
    return difference * 1000 <= std::max(left, right) * 2;
}

} // namespace

OutputSurface::~OutputSurface() { Shutdown(); }

void OutputSurface::Initialize(D3DDevice& graphics, OutputConfig config,
                               const CanvasConfig& canvas, DisplayDescriptor display,
                               const std::filesystem::path& baseDirectory,
                               const bool topmost, const bool vsync) {
    Shutdown();
    config_ = std::move(config);
    canvas_ = canvas;
    display_ = std::move(display);
    vsync_ = vsync;
    occluded_ = false;
    presentAttempts_ = 0;
    acceptedPresentSubmissions_ = 0;
    occludedPresentSubmissions_ = 0;
    otherPresentStatuses_ = 0;
    presentFailures_ = 0;
    lastPresentResult_ = S_OK;
    lastPresentIdResult_ = S_OK;
    lastSubmittedPresentId_.reset();
    lastPresentSubmissionQpc_ = 0;
    lastRenderMilliseconds_ = 0;
    displayTiming_ = {};
    LARGE_INTEGER qpcFrequency{};
    if (!QueryPerformanceFrequency(&qpcFrequency) || qpcFrequency.QuadPart <= 0) {
        throw std::runtime_error("QueryPerformanceFrequency failed");
    }
    qpcFrequency_ = qpcFrequency.QuadPart;
    if (display_.adapterLuid != graphics.AdapterLuid()) {
        throw std::runtime_error("Output " + config_.id + " is attached to a different GPU adapter");
    }
    if (display_.width != config_.resolution.width || display_.height != config_.resolution.height) {
        throw std::runtime_error("Output " + config_.id + " display mode size does not match renderer config");
    }
    if (!EqualRefresh(config_.resolution, display_)) {
        throw std::runtime_error("Output " + config_.id + " refresh rate does not match renderer config");
    }

    window_.Create(L"Pixel Brightness · " + Widen(config_.id), display_.desktopRect, topmost);
    CreateSwapChain(graphics);
    CreateBackBuffer(graphics);
    pipeline_.Initialize(graphics.Device(), ShaderDirectory(), config_);
    pipeline_.LoadCorrectionAssets(graphics.Device(), config_, baseDirectory);
    // This provisional submission happens before the window is shown and is
    // deliberately best-effort. RendererApp must call ValidateBlackPresent
    // after every candidate window is visible and before committing ownership.
    PresentBlack(graphics);
    window_.Show();
    Log::Info("Output {} bound to {} {}x{} @ {}/{}", config_.id, Narrow(display_.gdiName),
              display_.width, display_.height, display_.refreshNum, display_.refreshDen);
}

void OutputSurface::CreateSwapChain(D3DDevice& graphics) {
    const auto dxgiOutput = DisplayRegistry::FindDxgiOutput(graphics.Adapter(), display_);
    DXGI_SWAP_CHAIN_DESC1 description{};
    description.Width = config_.resolution.width;
    description.Height = config_.resolution.height;
    description.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    description.Stereo = FALSE;
    description.SampleDesc.Count = 1;
    description.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    description.BufferCount = 3;
    description.Scaling = DXGI_SCALING_STRETCH;
    description.SwapEffect = DXGI_SWAP_EFFECT_FLIP_DISCARD;
    description.AlphaMode = DXGI_ALPHA_MODE_IGNORE;
    description.Flags = DXGI_SWAP_CHAIN_FLAG_FRAME_LATENCY_WAITABLE_OBJECT;
    if (!vsync_ && graphics.TearingSupported()) description.Flags |= DXGI_SWAP_CHAIN_FLAG_ALLOW_TEARING;
    Microsoft::WRL::ComPtr<IDXGISwapChain1> baseSwapChain;
    ThrowIfFailed(graphics.Factory()->CreateSwapChainForHwnd(
                      graphics.Device(), window_.Handle(), &description, nullptr, dxgiOutput.Get(),
                      baseSwapChain.ReleaseAndGetAddressOf()),
                  "Create projector swapchain");
    ThrowIfFailed(baseSwapChain.As(&swapChain_), "Query IDXGISwapChain4");
    ThrowIfFailed(graphics.Factory()->MakeWindowAssociation(
                      window_.Handle(), DXGI_MWA_NO_ALT_ENTER | DXGI_MWA_NO_WINDOW_CHANGES),
                  "Disable DXGI window changes");
    Microsoft::WRL::ComPtr<IDXGISwapChain2> swapChain2;
    ThrowIfFailed(swapChain_.As(&swapChain2), "Query IDXGISwapChain2");
    ThrowIfFailed(swapChain2->SetMaximumFrameLatency(1), "Set swapchain maximum frame latency");
    frameLatencyHandle_ = swapChain2->GetFrameLatencyWaitableObject();
    if (!frameLatencyHandle_ || frameLatencyHandle_ == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Swapchain did not expose a frame-latency wait handle");
    }
    UINT support{};
    if (SUCCEEDED(swapChain_->CheckColorSpaceSupport(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709, &support)) &&
        (support & DXGI_SWAP_CHAIN_COLOR_SPACE_SUPPORT_FLAG_PRESENT) != 0) {
        ThrowIfFailed(swapChain_->SetColorSpace1(DXGI_COLOR_SPACE_RGB_FULL_G22_NONE_P709),
                      "Set SDR output color space");
    }
}

void OutputSurface::CreateBackBuffer(D3DDevice& graphics) {
    Microsoft::WRL::ComPtr<ID3D11Texture2D> backBuffer;
    ThrowIfFailed(swapChain_->GetBuffer(0, IID_PPV_ARGS(backBuffer.ReleaseAndGetAddressOf())),
                  "Get swapchain back buffer");
    ThrowIfFailed(graphics.Device()->CreateRenderTargetView(
                      backBuffer.Get(), nullptr, renderTarget_.ReleaseAndGetAddressOf()),
                  "Create swapchain render target");
}

void OutputSurface::Render(D3DDevice& graphics, const CanvasConfig& canvas,
                           ID3D11ShaderResourceView* composition, const bool sourceValid,
                           const bool sourceIsSrgb) {
    const auto started = std::chrono::steady_clock::now();
    pipeline_.Render(graphics.Context(), renderTarget_.Get(), composition, sourceValid,
                     config_, canvas, sourceIsSrgb, pattern_, blank_);
    const UINT syncInterval = vsync_ ? 1 : 0;
    const UINT flags = !vsync_ && graphics.TearingSupported() ? DXGI_PRESENT_ALLOW_TEARING : 0;
    ++presentAttempts_;
    lastPresentResult_ = swapChain_->Present(syncInterval, flags);
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    lastPresentSubmissionQpc_ = now.QuadPart;
    if (FAILED(lastPresentResult_)) {
        ++presentFailures_;
        ThrowIfFailed(lastPresentResult_, "Present projector swapchain");
    }
    if (lastPresentResult_ == DXGI_STATUS_OCCLUDED) {
        occluded_ = true;
        ++occludedPresentSubmissions_;
        lastPresentIdResult_ = lastPresentResult_;
        lastSubmittedPresentId_.reset();
        displayTiming_.MarkUnavailable("occluded", static_cast<std::int32_t>(lastPresentResult_),
                                       now.QuadPart);
    } else if (lastPresentResult_ == S_OK) {
        occluded_ = false;
        ++acceptedPresentSubmissions_;
        UINT presentId{};
        lastPresentIdResult_ = swapChain_->GetLastPresentCount(&presentId);
        if (SUCCEEDED(lastPresentIdResult_)) {
            lastSubmittedPresentId_ = presentId;
        } else {
            lastSubmittedPresentId_.reset();
        }
        SampleDisplayTiming();
    } else {
        ++otherPresentStatuses_;
        lastPresentIdResult_ = lastPresentResult_;
        lastSubmittedPresentId_.reset();
        displayTiming_.MarkUnavailable("present-status",
                                       static_cast<std::int32_t>(lastPresentResult_), now.QuadPart);
    }
    lastRenderMilliseconds_ = std::chrono::duration<double, std::milli>(
                                  std::chrono::steady_clock::now() - started)
                                  .count();
}

void OutputSurface::SampleDisplayTiming() noexcept {
    DXGI_FRAME_STATISTICS statistics{};
    const auto result = swapChain_->GetFrameStatistics(&statistics);
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    if (result == DXGI_ERROR_FRAME_STATISTICS_DISJOINT) {
        displayTiming_.MarkDisjoint(static_cast<std::int32_t>(result), now.QuadPart);
        return;
    }
    if (FAILED(result)) {
        const auto status = result == DXGI_ERROR_UNSUPPORTED ? "unsupported"
                            : result == DXGI_ERROR_NOT_CURRENTLY_AVAILABLE ? "not-currently-available"
                                                                           : "query-error";
        displayTiming_.MarkUnavailable(status, static_cast<std::int32_t>(result), now.QuadPart);
        return;
    }
    // A flip-model sample has a QPC value in the same counter domain as
    // QueryPerformanceCounter. Do not publish DXGI's documented all-zero
    // placeholder as physical timing evidence.
    if (statistics.SyncQPCTime.QuadPart <= 0) {
        displayTiming_.MarkUnavailable("zero-statistics", static_cast<std::int32_t>(result),
                                       now.QuadPart);
        return;
    }
    displayTiming_.Observe({statistics.PresentCount, statistics.PresentRefreshCount,
                            statistics.SyncRefreshCount, statistics.SyncQPCTime.QuadPart},
                           static_cast<std::int32_t>(result), now.QuadPart);
}

void OutputSurface::MarkDisplayTimingRecovering() noexcept {
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    displayTiming_.MarkUnavailable("recovering", DXGI_ERROR_NOT_CURRENTLY_AVAILABLE,
                                   now.QuadPart);
}

void OutputSurface::ValidateBlackPresent(D3DDevice& graphics) {
    if (!renderTarget_ || !swapChain_) {
        throw std::runtime_error("Candidate output " + config_.id +
                                 " has no render target or swapchain");
    }
    constexpr float black[4]{0, 0, 0, 1};
    graphics.Context()->ClearRenderTargetView(renderTarget_.Get(), black);
    graphics.Context()->Flush();
    const auto result = swapChain_->Present(
        0, !vsync_ && graphics.TearingSupported() ? DXGI_PRESENT_ALLOW_TEARING : 0);
    if (result != S_OK) {
        if (FAILED(result)) ThrowIfFailed(result, "Validate candidate black present");
        const auto status = result == DXGI_STATUS_OCCLUDED
                                ? "DXGI_STATUS_OCCLUDED"
                                : std::to_string(static_cast<unsigned long>(result));
        throw std::runtime_error("Candidate output " + config_.id +
                                 " black submission was not accepted; DXGI status " + status);
    }
}

void OutputSurface::PresentBlack(D3DDevice& graphics) noexcept {
    try {
        if (!renderTarget_ || !swapChain_) return;
        constexpr float black[4]{0, 0, 0, 1};
        graphics.Context()->ClearRenderTargetView(renderTarget_.Get(), black);
        graphics.Context()->Flush();
        swapChain_->Present(0, !vsync_ && graphics.TearingSupported() ? DXGI_PRESENT_ALLOW_TEARING : 0);
    } catch (...) {
    }
}

void OutputSurface::Shutdown() noexcept {
    if (frameLatencyHandle_ != INVALID_HANDLE_VALUE) CloseHandle(frameLatencyHandle_);
    frameLatencyHandle_ = INVALID_HANDLE_VALUE;
    renderTarget_.Reset();
    swapChain_.Reset();
    window_.Destroy();
}

void OutputSurface::SetPattern(PatternConfig value) noexcept {
    value.cellSize = std::clamp(value.cellSize, 2U, 1024U);
    value.grayBit = std::min(value.grayBit, 31U);
    for (auto& channel : value.solidRgb) channel = std::clamp(channel, 0.0F, 1.0F);
    // Parser validation rejects this combination at the IPC edge. Retain a
    // second fail-closed guard for internal/restored pattern state so a future
    // mode can never inherit corrected rendering accidentally.
    if (!PatternModeSupportsCorrections(value.mode)) value.applyCorrections = false;
    pattern_ = value;
}

OutputTelemetry OutputSurface::Snapshot() const {
    LARGE_INTEGER now{};
    QueryPerformanceCounter(&now);
    return {
        config_.id,
        display_.devicePath,
        display_.gdiName,
        display_.active,
        blank_,
        config_.processingBypass,
        pipeline_.CorrectionBinding(),
        pattern_,
        occluded_,
        presentAttempts_,
        acceptedPresentSubmissions_,
        occludedPresentSubmissions_,
        otherPresentStatuses_,
        presentFailures_,
        lastPresentResult_,
        lastPresentIdResult_,
        lastSubmittedPresentId_,
        lastPresentSubmissionQpc_,
        lastRenderMilliseconds_,
        vsync_,
        displayTiming_.Snapshot(now.QuadPart, qpcFrequency_),
    };
}

} // namespace pbwin

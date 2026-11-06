#include "pbwin/OffscreenOutput.hpp"
#include "pbwin/Log.hpp"
#include "pbwin/D3DDevice.hpp"

#include <chrono>
#include <iostream>
#include <thread>

using namespace pbwin;
using Microsoft::WRL::ComPtr;

namespace {
void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}
template<class F> void Reject(F action) {
    bool rejected{};
    try { action(); } catch (const std::exception&) { rejected = true; }
    Require(rejected, "Invalid frame was accepted");
}
NetworkVideoFrame Read(OffscreenOutput& output, ID3D11DeviceContext* context) {
    const auto deadline = std::chrono::steady_clock::now() + std::chrono::seconds(5);
    while (std::chrono::steady_clock::now() < deadline) {
        auto result = output.TryReadback(context);
        if (result) { result->Validate(); return std::move(*result); }
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
    throw std::runtime_error("GPU readback deadline exceeded");
}
void Pixel(const NetworkVideoFrame& frame, unsigned x, unsigned y,
           unsigned r, unsigned g, unsigned b) {
    const auto i = (static_cast<std::size_t>(y) * frame.width + x) * 4;
    Require(frame.rgba[i] == r && frame.rgba[i + 1] == g &&
            frame.rgba[i + 2] == b && frame.rgba[i + 3] == 255,
            "RGBA pixel/order mismatch");
}
}

int main(int argc, char** argv) {
    try {
        Reject([] { NetworkVideoFrame::ByteCount(0, 10); });
        Reject([] { NetworkVideoFrame::ByteCount(4097, 2160); });
        NetworkVideoFrame invalid;
        invalid.width = 1; invalid.height = 1;
        Reject([&] { invalid.Validate(); });
        invalid.rgba.resize(4); invalid.frameRateDen = 0;
        Reject([&] { invalid.Validate(); });
        invalid.frameRateDen = 1; invalid.timecode = -1;
        Reject([&] { invalid.Validate(); });

        ComPtr<ID3D11Device> device;
        ComPtr<ID3D11DeviceContext> context;
        D3DDevice hardware;
        // WARP makes these deterministic GPU/shader tests independent of which
        // physical monitor is plugged in. They never create a show window.
        if (argc == 2 && std::string(argv[1]) == "--hardware") {
            hardware.Create(std::nullopt);
            device = hardware.Device(); context = hardware.Context();
            std::cout << "test adapter: " << hardware.AdapterName() << '\n';
        } else if (argc == 1) {
            ThrowIfFailed(D3D11CreateDevice(nullptr, D3D_DRIVER_TYPE_WARP, nullptr, 0,
                nullptr, 0, D3D11_SDK_VERSION, &device, nullptr, &context), "Create WARP test device");
            std::cout << "test adapter: D3D11 WARP\n";
        } else {
            throw std::invalid_argument("Usage: pbwin-offscreen-tests [--hardware]");
        }
        CanvasConfig canvas{128, 64, 60000, 1001};
        OutputConfig config;
        config.id = "test-left";
        config.resolution = {64, 64, 60000, 1001};
        config.sourceViewport = {0, 0, 64, 64};
        config.blendEnabled = false;
        OffscreenOutput left;
        left.Initialize(device.Get(), config, canvas, PB_TEST_SHADER_DIR, {});
        OffscreenOutput right;
        config.id = "test-right";
        config.sourceViewport.x = 64;
        right.Initialize(device.Get(), config, canvas, PB_TEST_SHADER_DIR, {});

        std::vector<std::uint8_t> pixels(128 * 64 * 4, 0);
        for (unsigned y = 0; y < 64; ++y) for (unsigned x = 0; x < 128; ++x) {
            auto i = (y * 128 + x) * 4;
            pixels[i + (x < 64 ? 0 : 2)] = 255;
            pixels[i + 3] = 255;
        }
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = 128; desc.Height = 64; desc.MipLevels = 1; desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_IMMUTABLE; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA data{pixels.data(), 128 * 4, 0};
        ComPtr<ID3D11Texture2D> texture;
        ComPtr<ID3D11ShaderResourceView> source;
        ThrowIfFailed(device->CreateTexture2D(&desc, &data, &texture), "Create test source");
        ThrowIfFailed(device->CreateShaderResourceView(texture.Get(), nullptr, &source), "Create test SRV");
        Require(left.Submit(context.Get(), source.Get(), true, true, {}, false, 1, 1000), "Submit left");
        Require(right.Submit(context.Get(), source.Get(), true, true, {}, false, 1, 1000), "Submit right");
        auto a = Read(left, context.Get()); auto b = Read(right, context.Get());
        Pixel(a, 32, 32, 255, 0, 0); Pixel(b, 32, 32, 0, 0, 255);
        Require(a.timecode == b.timecode && a.frameRateNum == 60000 && a.frameRateDen == 1001,
                "Output timestamp/cadence lost");

        Require(left.Submit(context.Get(), source.Get(), true, true, {}, false, 2, 2000), "Queue first");
        Require(left.Submit(context.Get(), source.Get(), true, true, {}, false, 3, 3000), "Queue second");
        Require(!left.Submit(context.Get(), source.Get(), true, true, {}, false, 4, 4000), "Queue unbounded");
        left.DiscardPending();
        Require(left.Submit(context.Get(), source.Get(), true, true, {}, true, 5, 5000), "Submit black");
        a = Read(left, context.Get());
        Require(a.sequence == 5, "Pre-blank frame leaked after discard");
        Pixel(a, 32, 32, 0, 0, 0);
        Require(!left.TryReadback(context.Get()), "Discarded frame remained pending");

        Require(left.Submit(context.Get(), nullptr, false, true, {}, false, 6, 6000), "Submit source loss");
        Pixel(Read(left, context.Get()), 32, 32, 0, 0, 0);
        PatternConfig green; green.mode = PatternMode::green;
        Require(left.Submit(context.Get(), nullptr, false, true, green, false, 7, 7000), "Submit pattern");
        Pixel(Read(left, context.Get()), 32, 32, 0, 255, 0);

        OffscreenOutput blended;
        config.sourceViewport.x = 0;
        config.blendEnabled = true; config.overlap.left = 32;
        blended.Initialize(device.Get(), config, canvas, PB_TEST_SHADER_DIR, {});
        Require(blended.Submit(context.Get(), source.Get(), true, true, {}, false, 1, 1000), "Submit blend");
        a = Read(blended, context.Get());
        Pixel(a, 0, 32, 0, 0, 0); Pixel(a, 48, 32, 255, 0, 0);
        Require(!blended.CorrectionBinding().warpMeshSha256.empty(), "Missing correction evidence");
        OffscreenOutput padded;
        config.blendEnabled = false;
        config.resolution.width = 66; // 264 bytes/row exercises GPU row padding.
        padded.Initialize(device.Get(), config, canvas, PB_TEST_SHADER_DIR, {});
        Require(padded.Submit(context.Get(), source.Get(), true, true, {}, false, 1, 1000), "Submit padded");
        a = Read(padded, context.Get());
        Require(a.rgba.size() == 66 * 64 * 4, "Packed frame retained GPU padding");
        Pixel(a, 32, 0, 255, 0, 0); Pixel(a, 32, 63, 255, 0, 0);
        OffscreenOutput invalidOutput;
        auto invalidCanvas = canvas; invalidCanvas.width = 0;
        Reject([&] { invalidOutput.Initialize(device.Get(), config, invalidCanvas, PB_TEST_SHADER_DIR, {}); });
        std::cout << "offscreen: crop, RGBA, blend, source-loss, blank, queue and cadence passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << error.what() << '\n';
        return 1;
    }
}

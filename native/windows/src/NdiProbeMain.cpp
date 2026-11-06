#include <Processing.NDI.Lib.h>
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstdint>
#include <iostream>
#include <stdexcept>
#include <string>
#include <vector>

// Bounded, read-only diagnostics for the actual show PC. No sender, tally,
// routing, device-control, desktop capture or persistent settings are used.
namespace {
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
struct Runtime {
    Runtime() { if (!NDIlib_initialize()) throw std::runtime_error("NDI initialization failed"); }
    ~Runtime() { NDIlib_destroy(); }
};
struct Finder {
    NDIlib_find_instance_t handle{};
    Finder() {
        NDIlib_find_create_t config{};
        config.show_local_sources = true;
        handle = NDIlib_find_create_v2(&config);
        if (!handle) throw std::runtime_error("NDI discovery initialization failed");
    }
    ~Finder() { NDIlib_find_destroy(handle); }
};
struct Source { std::string name, address; };
std::vector<Source> Discover(Finder& finder) {
    const auto deadline = Clock::now() + std::chrono::seconds(4);
    while (Clock::now() < deadline) NDIlib_find_wait_for_sources(finder.handle, 200);
    std::uint32_t count = 0;
    const auto* found = NDIlib_find_get_current_sources(finder.handle, &count);
    if (count > 4096 || (count && !found)) throw std::runtime_error("Invalid discovery result");
    std::vector<Source> sources;
    for (std::uint32_t i = 0; i < count; ++i) {
        if (!found[i].p_ndi_name) continue;
        sources.push_back({found[i].p_ndi_name, found[i].p_url_address ? found[i].p_url_address : ""});
    }
    return sources;
}
struct Receiver {
    NDIlib_recv_instance_t handle{};
    explicit Receiver(const Source& source) {
        NDIlib_recv_create_v3_t config{};
        config.source_to_connect_to.p_ndi_name = source.name.c_str();
        config.source_to_connect_to.p_url_address = source.address.empty() ? nullptr : source.address.c_str();
        config.color_format = NDIlib_recv_color_format_RGBX_RGBA;
        config.bandwidth = NDIlib_recv_bandwidth_highest;
        config.allow_video_fields = false;
        config.p_ndi_recv_name = "Pixel Brightness bounded receive diagnostic";
        handle = NDIlib_recv_create_v3(&config);
        if (!handle) throw std::runtime_error("NDI receiver initialization failed");
    }
    ~Receiver() { NDIlib_recv_destroy(handle); }
};
Json Receive(const Source& source, int seconds) {
    Receiver receiver(source);
    const auto start = Clock::now(), deadline = start + std::chrono::seconds(seconds);
    std::uint64_t frames = 0, timecodeRegressions = 0;
    std::int64_t previousTimecode = 0;
    Json formats = Json::array();
    Json lastFormat;
    double lastMeanRgb = 0;
    while (Clock::now() < deadline) {
        NDIlib_video_frame_v2_t video{};
        const auto type = NDIlib_recv_capture_v3(receiver.handle, &video, nullptr, nullptr, 100);
        if (type == NDIlib_frame_type_error) throw std::runtime_error("NDI receive error");
        if (type != NDIlib_frame_type_video) continue;
        try {
            if (video.xres < 1 || video.xres > 16384 || video.yres < 1 || video.yres > 8640
                || !video.p_data || video.line_stride_in_bytes < video.xres * 4
                || (video.FourCC != NDIlib_FourCC_type_RGBX && video.FourCC != NDIlib_FourCC_type_RGBA))
                throw std::runtime_error("Unsupported received frame layout");
            Json format = {{"width", video.xres}, {"height", video.yres},
                {"fpsNumerator", video.frame_rate_N}, {"fpsDenominator", video.frame_rate_D},
                {"fourCC", static_cast<int>(video.FourCC)}};
            if (format != lastFormat) {
                if (formats.size() >= 32) throw std::runtime_error("Source format is unstable");
                formats.push_back(format); lastFormat = std::move(format);
            }
            if (frames && video.timecode < previousTimecode) ++timecodeRegressions;
            previousTimecode = video.timecode;
            // Sparse pixel statistics only, not an optical black-level reading.
            std::uint64_t total = 0, samples = 0;
            for (int y = 0; y < video.yres; y += 32) for (int x = 0; x < video.xres; x += 32) {
                const auto* p = video.p_data + static_cast<std::size_t>(y) * video.line_stride_in_bytes + x * 4;
                total += p[0] + p[1] + p[2]; samples += 3;
            }
            lastMeanRgb = static_cast<double>(total) / static_cast<double>(samples);
            ++frames;
        } catch (...) { NDIlib_recv_free_video_v2(receiver.handle, &video); throw; }
        NDIlib_recv_free_video_v2(receiver.handle, &video);
    }
    NDIlib_recv_performance_t total{}, dropped{};
    NDIlib_recv_get_performance(receiver.handle, &total, &dropped);
    return {{"sourceName", source.name}, {"sourceAddress", source.address},
        {"receivedFrames", frames}, {"observedSeconds", std::chrono::duration<double>(Clock::now() - start).count()},
        {"formats", formats}, {"lastSampledMeanRgb8", frames ? Json(lastMeanRgb) : Json(nullptr)},
        {"timecodeRegressions", timecodeRegressions}, {"sdkReceivedVideoFrames", total.video_frames},
        {"sdkDroppedVideoFrames", dropped.video_frames}, {"physicalProjectorVerified", false}};
}
}
int main(int argc, char** argv) {
    try {
        const bool list = argc == 2 && std::string(argv[1]) == "--list";
        const bool receive = (argc == 3 || argc == 5) && std::string(argv[1]) == "--receive" && std::string(argv[2]).size() > 0;
        if (!list && !receive) throw std::invalid_argument("Usage: pixel-brightness-ndi-probe --list | --receive EXACT_SOURCE_NAME [--seconds 5..600]");
        int seconds = 5;
        if (argc == 5) {
            const std::string duration(argv[4]);
            if (std::string(argv[3]) != "--seconds" || duration.empty() || duration.size() > 3
                || duration.find_first_not_of("0123456789") != std::string::npos)
                throw std::invalid_argument("Invalid diagnostic duration");
            seconds = std::stoi(duration);
            if (seconds < 5 || seconds > 600) throw std::invalid_argument("Duration must be 5..600 seconds");
        }
        Runtime runtime;
        Finder finder;
        const auto sources = Discover(finder);
        Json result = {{"schema", "pb-ndi-probe-v1"}, {"sdk", NDIlib_version()}};
        if (list) {
            result["sources"] = Json::array();
            for (const auto& source : sources) result["sources"].push_back({{"name", source.name}, {"address", source.address}});
        } else {
            const Source* selected = nullptr;
            for (const auto& source : sources) if (source.name == argv[2]) {
                if (selected) throw std::runtime_error("Ambiguous source name; no receiver was connected");
                selected = &source;
            }
            if (!selected) throw std::runtime_error("Exact NDI source is not currently discoverable");
            result["receive"] = Receive(*selected, seconds);
            result["ok"] = result["receive"]["receivedFrames"].get<std::uint64_t>() > 0;
        }
        std::cout << result.dump(2) << '\n';
        return receive && !result["ok"].get<bool>() ? 2 : 0;
    } catch (const std::exception& e) {
        std::cerr << Json({{"schema", "pb-ndi-probe-v1"}, {"ok", false}, {"error", e.what()}}).dump() << '\n';
        return 1;
    }
}

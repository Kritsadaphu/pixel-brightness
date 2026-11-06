#include <windows.h>
#include <Processing.NDI.Lib.h>
#include "pbwin/Config.hpp"
#include "pbwin/D3DDevice.hpp"
#include "pbwin/OffscreenOutput.hpp"
#include "pbwin/NdiSender.hpp"
#include "pbwin/NdiOutputWorker.hpp"
#include "pbwin/Log.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <cstring>
#include <fstream>
#include <iostream>
#include <memory>
#include <regex>
#include <set>
#include <thread>

// Supervised headless development renderer. No HWND, monitor binding, Arena
// control, receiver subscription changes, driver changes or power actions.
using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
using namespace pbwin;
namespace {
void Emit(const Json& value) { std::cout << value.dump() << std::endl; }
void Keys(const Json& value, std::initializer_list<std::string_view> keys) {
    if (!value.is_object()) throw std::runtime_error("Expected object");
    for (const auto& [key, ignored] : value.items()) {
        (void)ignored;
        if (std::find(keys.begin(), keys.end(), key) == keys.end()) throw std::runtime_error("Unknown configuration field: " + key);
    }
}
unsigned Integer(const Json& value, const char* name, unsigned lo, unsigned hi) {
    const auto& field = value.at(name);
    if (!field.is_number_integer()) throw std::runtime_error(std::string(name) + " must be an integer");
    const auto number = field.get<std::int64_t>();
    if (number < lo || number > hi) throw std::runtime_error(std::string(name) + " out of range");
    return static_cast<unsigned>(number);
}
struct Receiver {
    NdiRuntimeLease runtime;
    NDIlib_recv_instance_t handle{};
    Receiver(const std::string& name, const std::string& address) {
        NDIlib_recv_create_v3_t config{};
        config.source_to_connect_to = {name.c_str(), address.c_str()};
        config.color_format = NDIlib_recv_color_format_RGBX_RGBA;
        config.bandwidth = NDIlib_recv_bandwidth_highest;
        config.allow_video_fields = false;
        config.p_ndi_recv_name = "Pixel Brightness spatial NDI development";
        handle = NDIlib_recv_create_v3(&config);
        if (!handle) throw std::runtime_error("NDI input creation failed");
    }
    ~Receiver() { if (handle) NDIlib_recv_destroy(handle); }
};
struct Output {
    OutputConfig config;
    std::unique_ptr<OffscreenOutput> render;
    std::unique_ptr<NdiOutputWorker> sender;
    std::uint64_t submitted{}, sent{}, dropped{};
};
struct VideoLease {
    NDIlib_recv_instance_t receiver;
    NDIlib_video_frame_v2_t frame{};
    bool owns{};
    ~VideoLease() { if (owns) NDIlib_recv_free_video_v2(receiver, &frame); }
};
}
int main(int argc, char** argv) {
    try {
        if (argc != 3 || std::string(argv[1]) != "--config-file") throw std::runtime_error("Usage: --config-file ABSOLUTE_JSON_PATH");
        const std::filesystem::path configPath(argv[2]);
        if (!configPath.is_absolute() || std::filesystem::file_size(configPath) > 8 * 1024 * 1024) throw std::runtime_error("Use a bounded absolute config file");
        std::ifstream stream(configPath); Json config; stream >> config;
        Keys(config, {"schema", "prefix", "source", "canvas", "outputs", "shaderDirectory", "assetDirectory", "adapterLuid"});
        if (config.at("schema") != "pb-ndi-video-v1") throw std::runtime_error("Unsupported NDI video configuration");
        const auto prefix = config.at("prefix").get<std::string>();
        if (!std::regex_match(prefix, std::regex("PB-VIDEO-[A-Za-z0-9_-]{1,64}"))) throw std::runtime_error("Use an isolated PB-VIDEO prefix");
        const auto& source = config.at("source");
        Keys(source, {"name", "address", "timeoutMs", "sourceIsSrgb"});
        const auto name = source.at("name").get<std::string>(), address = source.at("address").get<std::string>();
        if (name.empty() || name.size() > 256 || name.find_first_of("\r\n") != std::string::npos || name.find('\0') != std::string::npos ||
            !std::regex_match(address, std::regex("[A-Za-z0-9._:%\\[\\]-]{1,255}:[0-9]{1,5}")))
            throw std::runtime_error("Exact discovered NDI name/address required");
        const auto timeout = std::chrono::milliseconds(Integer(source, "timeoutMs", 100, 5000));
        const auto srgb = source.at("sourceIsSrgb").get<bool>();
        const auto& c = config.at("canvas");
        Keys(c, {"width", "height", "frameRateNum", "frameRateDen"});
        CanvasConfig canvas{Integer(c, "width", 64, 16384), Integer(c, "height", 64, 4320),
                            Integer(c, "frameRateNum", 1, 240000), Integer(c, "frameRateDen", 1, 1001000)};
        if (static_cast<std::uint64_t>(canvas.width) * canvas.height > 33554432 ||
            canvas.frameRateNum < canvas.frameRateDen || canvas.frameRateNum > 120ULL * canvas.frameRateDen)
            throw std::runtime_error("Canvas exceeds 32M pixels or 1-120 fps");
        const std::filesystem::path shaderDirectory(config.at("shaderDirectory").get<std::string>());
        const std::filesystem::path assetDirectory(config.at("assetDirectory").get<std::string>());
        if (!shaderDirectory.is_absolute() || !assetDirectory.is_absolute()) throw std::runtime_error("Absolute shader/asset directories required");
        const auto& items = config.at("outputs");
        if (!items.is_array() || items.empty() || items.size() > 5) throw std::runtime_error("Expected 1-5 network outputs");
        std::set<std::string> ids; std::vector<Output> outputs;
        for (const auto& item : items) {
            Output output;
            output.config = ConfigLoader::NetworkOutputFromJson(item, canvas, assetDirectory);
            if (!ids.insert(output.config.id).second) throw std::runtime_error("Duplicate output identity");
            outputs.push_back(std::move(output));
        }
        std::optional<LuidValue> adapter;
        if (config.contains("adapterLuid")) {
            adapter = ParseLuid(config.at("adapterLuid").get<std::string>());
            if (!adapter) throw std::runtime_error("Invalid adapter LUID");
        }
        D3DDevice gpu; gpu.Create(adapter);
        // Validate/load every correction before creating any NDI sender.
        for (auto& output : outputs) {
            output.render = std::make_unique<OffscreenOutput>();
            output.render->Initialize(gpu.Device(), output.config, canvas, shaderDirectory, assetDirectory);
        }
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width = canvas.width; desc.Height = canvas.height; desc.MipLevels = desc.ArraySize = 1;
        desc.Format = DXGI_FORMAT_R8G8B8A8_UNORM; desc.SampleDesc.Count = 1;
        desc.Usage = D3D11_USAGE_DYNAMIC; desc.BindFlags = D3D11_BIND_SHADER_RESOURCE;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
        Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> view;
        ThrowIfFailed(gpu.Device()->CreateTexture2D(&desc, nullptr, &texture), "NDI input texture");
        ThrowIfFailed(gpu.Device()->CreateShaderResourceView(texture.Get(), nullptr, &view), "NDI input view");
        Json sources = Json::array();
        for (auto& output : outputs) {
            output.sender = std::make_unique<NdiOutputWorker>(prefix + "-" + output.config.id);
            const auto identity = output.sender->SourceIdentity();
            if (identity.name == name) throw std::runtime_error("NDI feedback loop rejected");
            sources.push_back({{"outputId", output.config.id}, {"name", identity.name}, {"address", identity.address}});
        }
        // The receiver owns a runtime lease independently of sender workers.
        Receiver receiver(name, address);
        Emit({{"event", "ready"}, {"sources", sources}, {"adapter", gpu.AdapterName()},
              {"blank", true}, {"physicalPresentationVerified", false}});
        const auto started = Clock::now(); auto lastCommand = started, lastVideo = Clock::time_point{};
        const auto period = std::chrono::nanoseconds(1000000000ULL * canvas.frameRateDen / canvas.frameRateNum);
        bool blank = true, previousBlack = true, formatValid = false;
        std::uint64_t sequence = 0, received = 0, rejected = 0;
        double receiveMs = 0, uploadMs = 0, readbackMs = 0, sendMs = 0, renderMs = 0;
        int stopping = 0; std::string pending;
        const auto input = GetStdHandle(STD_INPUT_HANDLE);
        while (true) {
            const auto tick = Clock::now(); Json response;
            DWORD available = 0;
            if (!PeekNamedPipe(input, nullptr, 0, nullptr, &available, nullptr)) stopping = stopping ? stopping : 3;
            if (available && !stopping) {
                char bytes[4096]; DWORD read = 0;
                if (!ReadFile(input, bytes, std::min<DWORD>(available, sizeof(bytes)), &read, nullptr)) stopping = 3;
                else pending.append(bytes, read);
                if (pending.size() > 16384) throw std::runtime_error("Oversized control message");
            }
            const auto newline = pending.find('\n');
            if (newline != std::string::npos && !stopping) {
                const auto request = Json::parse(pending.substr(0, newline)); pending.erase(0, newline + 1);
                Keys(request, {"command", "blank"});
                const auto command = request.at("command").get<std::string>();
                if (command == "stop") stopping = 3;
                else if (command == "blank") { blank = request.at("blank").get<bool>(); response = {{"event", "blank"}, {"blank", blank}}; }
                else if (command == "status") response = {{"event", "status"}};
                else if (command != "ping") throw std::runtime_error("Unknown command");
                lastCommand = Clock::now();
            }
            if (Clock::now() - lastCommand > std::chrono::seconds(10)) stopping = stopping ? stopping : 3;
            // Bounded work per render tick, never grow a CPU frame queue.
            const auto receiveStart = Clock::now();
            VideoLease latest{receiver.handle};
            for (int i = 0; i < 2 && !stopping; ++i) {
                VideoLease video{receiver.handle};
                const auto kind = NDIlib_recv_capture_v3(receiver.handle, &video.frame, nullptr, nullptr, 0);
                if (kind == NDIlib_frame_type_error) throw std::runtime_error("NDI receive failed");
                if (kind != NDIlib_frame_type_video) break;
                video.owns = true; const auto& f = video.frame;
                formatValid = f.xres == static_cast<int>(canvas.width) && f.yres == static_cast<int>(canvas.height) &&
                    f.frame_rate_N > 0 && f.frame_rate_D > 0 &&
                    static_cast<std::int64_t>(f.frame_rate_N) * canvas.frameRateDen == static_cast<std::int64_t>(canvas.frameRateNum) * f.frame_rate_D &&
                    f.frame_format_type == NDIlib_frame_format_type_progressive && f.p_data &&
                    f.line_stride_in_bytes >= f.xres * 4 && f.line_stride_in_bytes <= f.xres * 4 + 65536 &&
                    (f.FourCC == NDIlib_FourCC_type_RGBX || f.FourCC == NDIlib_FourCC_type_RGBA);
                if (!formatValid) { ++rejected; break; }
                if (latest.owns) NDIlib_recv_free_video_v2(receiver.handle, &latest.frame);
                latest.frame = f; latest.owns = true; video.owns = false;
                lastVideo = Clock::now(); ++received;
            }
            receiveMs += std::chrono::duration<double, std::milli>(Clock::now() - receiveStart).count();
            if (latest.owns && formatValid) {
                // Upload only the latest received frame, once per tick. DISCARD
                // lets D3D rename a resource still being sampled by queued GPU
                // work instead of synchronously overwriting that resource.
                const auto uploadStart = Clock::now();
                D3D11_MAPPED_SUBRESOURCE mapped{};
                ThrowIfFailed(gpu.Context()->Map(texture.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped), "Map NDI upload texture");
                const auto rowBytes = static_cast<std::size_t>(canvas.width) * 4;
                if (!mapped.pData || mapped.RowPitch < rowBytes) {
                    gpu.Context()->Unmap(texture.Get(), 0);
                    throw std::runtime_error("Invalid NDI upload row pitch");
                }
                for (unsigned y = 0; y < canvas.height; ++y)
                    std::memcpy(static_cast<std::uint8_t*>(mapped.pData) + static_cast<std::size_t>(y) * mapped.RowPitch,
                                latest.frame.p_data + static_cast<std::size_t>(y) * latest.frame.line_stride_in_bytes, rowBytes);
                gpu.Context()->Unmap(texture.Get(), 0);
                uploadMs += std::chrono::duration<double, std::milli>(Clock::now() - uploadStart).count();
            }
            const bool valid = formatValid && lastVideo.time_since_epoch().count() && Clock::now() - lastVideo < timeout;
            const bool black = blank || !valid || stopping;
            if (black != previousBlack || stopping) for (auto& output : outputs) {
                output.render->DiscardPending(); output.sender->DiscardPending();
            }
            previousBlack = black;
            const auto timecode = std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - started).count() / 100;
            Json outputStatus = Json::array();
            for (auto& output : outputs) {
                if (stopping) {
                    NetworkVideoFrame frame;
                    frame.width = output.config.resolution.width; frame.height = output.config.resolution.height;
                    frame.frameRateNum = canvas.frameRateNum; frame.frameRateDen = canvas.frameRateDen;
                    frame.sequence = sequence; frame.timecode = timecode;
                    frame.rgba.resize(NetworkVideoFrame::ByteCount(frame.width, frame.height), 0);
                    for (std::size_t i = 3; i < frame.rgba.size(); i += 4) frame.rgba[i] = 255;
                    output.sender->Stop(std::move(frame));
                } else {
                    const auto readStart = Clock::now();
                    output.render->RecycleReadbackBuffer(output.sender->TakeRecycledBuffer());
                    auto frame = output.render->TryReadback(gpu.Context());
                    readbackMs += std::chrono::duration<double, std::milli>(Clock::now() - readStart).count();
                    if (frame) {
                        const auto sendStart = Clock::now();
                        output.sender->Send(std::move(*frame));
                        sendMs += std::chrono::duration<double, std::milli>(Clock::now() - sendStart).count();
                    }
                    const auto renderStart = Clock::now();
                    if (output.render->Submit(gpu.Context(), view.Get(), valid, srgb, {}, black, sequence, timecode)) ++output.submitted;
                    else ++output.dropped;
                    renderMs += std::chrono::duration<double, std::milli>(Clock::now() - renderStart).count();
                }
                output.sent = output.sender->SubmissionCalls();
                if (!response.is_null()) outputStatus.push_back({{"outputId", output.config.id}, {"connections", output.sender->ConnectionCount()},
                    {"submittedFrames", output.submitted}, {"sentFrames", output.sent}, {"readbackBackpressure", output.dropped},
                    {"transportReplacedFrames", output.sender->ReplacedFrames()},
                    {"readbackTimingMs", {{"allocation", output.render->Timing().allocationMs}, {"map", output.render->Timing().mapMs},
                       {"copy", output.render->Timing().copyMs}, {"poll", output.render->Timing().pollMs}}}});
            }
            ++sequence; gpu.CheckRemoved();
            if (!response.is_null()) {
                response["outputs"] = outputStatus; response["sourceValid"] = valid; response["black"] = black;
                response["receivedFrames"] = received; response["rejectedFrames"] = rejected;
                response["elapsedSeconds"] = std::chrono::duration<double>(Clock::now() - started).count();
                response["ticks"] = sequence;
                response["timingMs"] = {{"receive", receiveMs}, {"upload", uploadMs}, {"readback", readbackMs}, {"send", sendMs}, {"render", renderMs}};
                response["physicalPresentationVerified"] = false; Emit(response);
            }
            if (stopping && --stopping == 0) { Emit({{"event", "stopped"}, {"blackSubmitted", true}, {"physicalBlackVerified", false}, {"contentRestored", false}}); break; }
            std::this_thread::sleep_until(tick + period);
        }
        return 0;
    } catch (const std::exception& e) { Emit({{"event", "error"}, {"error", e.what()}, {"physicalBlackVerified", false}}); return 1; }
}

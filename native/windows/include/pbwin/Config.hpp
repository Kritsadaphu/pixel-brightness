#pragma once

#include <dxgiformat.h>
#include <nlohmann/json_fwd.hpp>

#include <array>
#include <compare>
#include <cstdint>
#include <filesystem>
#include <optional>
#include <string>
#include <vector>

namespace pbwin {

inline constexpr std::uint32_t kConfigSchemaVersion = 1;
inline constexpr std::size_t kMaxOutputs = 32;

struct LuidValue {
    std::uint32_t lowPart{};
    std::int32_t highPart{};
    auto operator<=>(const LuidValue&) const = default;
};

struct CanvasConfig {
    std::uint32_t width{1920};
    std::uint32_t height{1080};
    std::uint32_t frameRateNum{60};
    std::uint32_t frameRateDen{1};
};

struct ResolutionConfig {
    std::uint32_t width{1920};
    std::uint32_t height{1080};
    std::uint32_t refreshNum{60};
    std::uint32_t refreshDen{1};
};

struct DisplaySelector {
    std::optional<std::wstring> devicePath;
    std::optional<std::wstring> gdiName;
    std::optional<LuidValue> adapterLuid;
    std::optional<std::uint32_t> targetId;
};

struct SpoutSourceConfig {
    std::string senderName;
    std::optional<std::uint32_t> width;
    std::optional<std::uint32_t> height;
    std::uint32_t frameRateNum{60};
    std::uint32_t frameRateDen{1};
    std::vector<DXGI_FORMAT> acceptedFormats;
    bool sourceIsSrgb{true};
    std::uint32_t timeoutMs{1000};
    std::uint32_t startupGraceMs{10000};
};

struct ViewportConfig {
    float x{};
    float y{};
    float width{1920};
    float height{1080};
};

struct EdgeConfig {
    float left{};
    float right{};
    float top{};
    float bottom{};
};

struct RawTexture2DConfig {
    std::filesystem::path path;
    std::uint32_t width{};
    std::uint32_t height{};
    enum class Format { r32Float, rg32Float, rgba32Float } format{Format::r32Float};
};

struct RawLut3DConfig {
    std::filesystem::path path;
    std::uint32_t size{};
};

struct MaskPointConfig {
    float x{};
    float y{};
};

struct WarpPointConfig {
    float u{};
    float v{};
    float x{};
    float y{};
};

struct WarpMeshConfig {
    bool enabled{};
    std::uint32_t columns{2};
    std::uint32_t rows{2};
    std::string interpolation{"bicubic"};
    std::vector<WarpPointConfig> points;
};

struct OutputConfig {
    std::string id;
    bool enabled{true};
    DisplaySelector display;
    ResolutionConfig resolution;
    ViewportConfig sourceViewport;
    bool processingBypass{};
    EdgeConfig overlap;
    bool blendEnabled{true};
    float blendFeather{0.78F};
    float blendGamma{2.2F};
    std::optional<RawTexture2DConfig> blendMap;
    bool blackMapEnabled{};
    float blackLift{};
    std::optional<RawTexture2DConfig> blackMap;
    std::array<float, 3> gain{1, 1, 1};
    std::array<float, 3> offset{0, 0, 0};
    std::array<float, 3> gamma{1, 1, 1};
    std::optional<RawLut3DConfig> colorLut;
    bool maskEnabled{};
    std::optional<RawTexture2DConfig> maskMap;
    std::vector<MaskPointConfig> maskPath;
    float maskSoftness{};
    WarpMeshConfig warp;
};

struct TelemetryConfig {
    std::optional<std::filesystem::path> path;
    std::uint32_t intervalMs{1000};
};

struct RendererConfig {
    std::uint32_t schemaVersion{kConfigSchemaVersion};
    std::uint64_t revision{1};
    std::string nodeId{"node01"};
    std::optional<LuidValue> adapterLuid;
    std::wstring pipeName;
    bool vsync{true};
    bool topmost{true};
    TelemetryConfig telemetry;
    CanvasConfig canvas;
    SpoutSourceConfig compositionSource;
    std::vector<OutputConfig> outputs;
    std::filesystem::path configDirectory;
};

enum class PatternMode : std::uint32_t {
    content = 0,
    black = 1,
    white = 2,
    gray = 3,
    red = 4,
    green = 5,
    blue = 6,
    grid = 7,
    identify = 8,
    solid = 9,
    grayCode = 10,
};

struct PatternConfig {
    PatternMode mode{PatternMode::content};
    std::uint32_t cellSize{32};
    std::array<float, 3> solidRgb{};
    bool applyCorrections{};
    bool grayAxisY{};
    std::uint32_t grayBit{};
    bool inverse{};
};

class ConfigLoader final {
public:
    // Transport-neutral correction parser for headless network outputs. Rejects
    // display selectors; the DXGI FromJson path still requires physical binding.
    static OutputConfig NetworkOutputFromJson(const nlohmann::json& json,
        const CanvasConfig& canvas, const std::filesystem::path& baseDirectory);
    static RendererConfig LoadFile(const std::filesystem::path& path);
    static RendererConfig FromJson(const nlohmann::json& json,
                                   const std::filesystem::path& baseDirectory = {});
    static nlohmann::json ToJson(const RendererConfig& config);
    static std::wstring DefaultPipeName(const std::string& nodeId);
};

std::string DxgiFormatName(DXGI_FORMAT format);
DXGI_FORMAT ParseDxgiFormat(const std::string& value);
std::string LuidToString(const LuidValue& luid);
std::optional<LuidValue> ParseLuid(const std::string& value);
PatternMode ParsePatternMode(const std::string& value);
std::string PatternModeName(PatternMode value);
PatternConfig ParsePatternCommand(const nlohmann::json& payload);
bool PatternModeSupportsCorrections(PatternMode value) noexcept;
bool PatternCorrectionsBypassed(const PatternConfig& pattern, bool processingBypass) noexcept;

} // namespace pbwin

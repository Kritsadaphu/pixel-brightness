#include "pbwin/Config.hpp"

#include "pbwin/Log.hpp"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <charconv>
#include <cctype>
#include <cmath>
#include <cstddef>
#include <fstream>
#include <initializer_list>
#include <limits>
#include <set>
#include <stdexcept>
#include <string_view>
#include <unordered_set>

namespace pbwin {
namespace {

using json = nlohmann::json;

void RequireOnlyKeys(const json& object, const std::initializer_list<std::string_view> allowed,
                     const std::string_view name) {
    for (const auto& [key, unused] : object.items()) {
        (void)unused;
        const auto found = std::find(allowed.begin(), allowed.end(), key) != allowed.end();
        if (!found) {
            throw std::runtime_error(std::string(name) + " contains unsupported field: " + key);
        }
    }
}

bool StartsWithInsensitive(const std::wstring_view value, const std::wstring_view prefix) {
    if (value.size() < prefix.size()) return false;
    return std::equal(prefix.begin(), prefix.end(), value.begin(), [](wchar_t left, wchar_t right) {
        const auto upper = [](const wchar_t character) {
            return character >= L'a' && character <= L'z' ? character - (L'a' - L'A') : character;
        };
        return upper(left) == upper(right);
    });
}

bool IsIdentifier(const std::string_view value) {
    return !value.empty() && std::all_of(value.begin(), value.end(), [](const unsigned char character) {
        return std::isalnum(character) || character == '.' || character == '_' || character == '-';
    });
}

template <typename T>
T BoundedInteger(const json& object, const char* key, const T fallback,
                 const T minimum, const T maximum, const bool required = false) {
    if (!object.contains(key)) {
        if (required) throw std::runtime_error(std::string(key) + " is required");
        return fallback;
    }
    if (!object.at(key).is_number_unsigned() && !object.at(key).is_number_integer()) {
        throw std::runtime_error(std::string(key) + " must be an integer");
    }
    const auto value = object.at(key).get<std::int64_t>();
    if (value < static_cast<std::int64_t>(minimum) || value > static_cast<std::int64_t>(maximum)) {
        throw std::runtime_error(std::string(key) + " is outside its supported range");
    }
    return static_cast<T>(value);
}

float BoundedFloat(const json& object, const char* key, const float fallback,
                   const float minimum, const float maximum) {
    if (!object.contains(key)) return fallback;
    if (!object.at(key).is_number()) throw std::runtime_error(std::string(key) + " must be numeric");
    const auto value = object.at(key).get<float>();
    if (!std::isfinite(value) || value < minimum || value > maximum) {
        throw std::runtime_error(std::string(key) + " is outside its supported range");
    }
    return value;
}

std::string RequiredString(const json& object, const char* key, const std::size_t maximum) {
    if (!object.contains(key) || !object.at(key).is_string()) {
        throw std::runtime_error(std::string(key) + " is required and must be a string");
    }
    auto result = object.at(key).get<std::string>();
    if (result.empty() || result.size() > maximum || result.find('\0') != std::string::npos) {
        throw std::runtime_error(std::string(key) + " has an invalid length");
    }
    return result;
}

std::optional<std::string> OptionalString(const json& object, const char* key, const std::size_t maximum) {
    if (!object.contains(key) || object.at(key).is_null()) return std::nullopt;
    if (!object.at(key).is_string()) throw std::runtime_error(std::string(key) + " must be a string or null");
    auto result = object.at(key).get<std::string>();
    if (result.empty() || result.size() > maximum || result.find('\0') != std::string::npos) {
        throw std::runtime_error(std::string(key) + " has an invalid length");
    }
    return result;
}

bool Boolean(const json& object, const char* key, const bool fallback) {
    if (!object.contains(key)) return fallback;
    if (!object.at(key).is_boolean()) throw std::runtime_error(std::string(key) + " must be boolean");
    return object.at(key).get<bool>();
}

void RequireObject(const json& value, const std::string& name) {
    if (!value.is_object()) throw std::runtime_error(name + " must be an object");
}

std::array<float, 3> Float3(const json& object, const char* key,
                            const std::array<float, 3>& fallback,
                            const float minimum, const float maximum) {
    if (!object.contains(key)) return fallback;
    const auto& value = object.at(key);
    if (!value.is_array() || value.size() != 3) {
        throw std::runtime_error(std::string(key) + " must contain exactly three numbers");
    }
    std::array<float, 3> result{};
    for (std::size_t index = 0; index < result.size(); ++index) {
        if (!value[index].is_number()) throw std::runtime_error(std::string(key) + " must contain numbers");
        result[index] = value[index].get<float>();
        if (!std::isfinite(result[index]) || result[index] < minimum || result[index] > maximum) {
            throw std::runtime_error(std::string(key) + " contains an unsupported value");
        }
    }
    return result;
}

std::filesystem::path ResolvePath(const std::filesystem::path& base, const std::string& value) {
    auto path = std::filesystem::path(Widen(value));
    if (path.is_relative()) path = base / path;
    return path.lexically_normal();
}

std::optional<RawTexture2DConfig> ParseTexture2D(const json& value,
                                                 const std::filesystem::path& base,
                                                 const RawTexture2DConfig::Format requiredFormat,
                                                 const bool allowRgba = false) {
    if (value.is_null()) return std::nullopt;
    RequireObject(value, "texture asset");
    RequireOnlyKeys(value, {"path", "width", "height", "format"}, "texture asset");
    RawTexture2DConfig result;
    result.path = ResolvePath(base, RequiredString(value, "path", 1024));
    result.width = BoundedInteger<std::uint32_t>(value, "width", 0, 1, 16384, true);
    result.height = BoundedInteger<std::uint32_t>(value, "height", 0, 1, 16384, true);
    const auto format = RequiredString(value, "format", 32);
    result.format = format == "r32_float" ? RawTexture2DConfig::Format::r32Float
                    : format == "rg32_float" ? RawTexture2DConfig::Format::rg32Float
                    : format == "rgba32_float" ? RawTexture2DConfig::Format::rgba32Float
                                                : throw std::runtime_error("Unsupported 2D asset format");
    if (result.format != requiredFormat && !(allowRgba && result.format == RawTexture2DConfig::Format::rgba32Float)) {
        throw std::runtime_error("Correction asset has the wrong format for its slot");
    }
    return result;
}

std::optional<RawLut3DConfig> ParseLut(const json& value, const std::filesystem::path& base) {
    if (value.is_null()) return std::nullopt;
    RequireObject(value, "color LUT");
    RequireOnlyKeys(value, {"path", "size", "format"}, "color LUT");
    if (RequiredString(value, "format", 32) != "rgba32_float") {
        throw std::runtime_error("Color LUT format must be rgba32_float");
    }
    return RawLut3DConfig{
        ResolvePath(base, RequiredString(value, "path", 1024)),
        BoundedInteger<std::uint32_t>(value, "size", 0, 2, 128, true),
    };
}

SpoutSourceConfig ParseCompositionSource(const json& source, const CanvasConfig& canvas) {
    RequireObject(source, "compositionSource");
    RequireOnlyKeys(source,
                    {"type", "senderName", "width", "height", "frameRateNum", "frameRateDen",
                     "acceptedFormats", "colorEncoding", "alphaMode", "timeoutMs",
                     "startupGraceMs", "onMissing", "onMismatch", "allowAutoSelect"},
                    "compositionSource");
    SpoutSourceConfig result;
    if (RequiredString(source, "type", 16) != "spout") {
        throw std::runtime_error("compositionSource.type must be spout");
    }
    result.senderName = RequiredString(source, "senderName", 255);
    result.width = BoundedInteger<std::uint32_t>(source, "width", 0, 1, 16384, true);
    result.height = BoundedInteger<std::uint32_t>(source, "height", 0, 1, 16384, true);
    if (*result.width != canvas.width || *result.height != canvas.height) {
        throw std::runtime_error("compositionSource dimensions must equal the master canvas");
    }
    result.frameRateNum = BoundedInteger<std::uint32_t>(source, "frameRateNum", 0, 1, 240000, true);
    result.frameRateDen = BoundedInteger<std::uint32_t>(source, "frameRateDen", 0, 1, 100000, true);
    if (static_cast<std::uint64_t>(result.frameRateNum) * canvas.frameRateDen !=
        static_cast<std::uint64_t>(canvas.frameRateNum) * result.frameRateDen) {
        throw std::runtime_error("compositionSource frame rate must equal the master canvas frame rate");
    }
    if (!source.contains("acceptedFormats") || !source.at("acceptedFormats").is_array() ||
        source.at("acceptedFormats").empty()) {
        throw std::runtime_error("compositionSource.acceptedFormats must be a non-empty array");
    }
    for (const auto& format : source.at("acceptedFormats")) {
        if (!format.is_string()) throw std::runtime_error("compositionSource.acceptedFormats must contain strings");
        const auto parsed = ParseDxgiFormat(format.get<std::string>());
        if (std::find(result.acceptedFormats.begin(), result.acceptedFormats.end(), parsed) !=
            result.acceptedFormats.end()) {
            throw std::runtime_error("compositionSource.acceptedFormats must not contain duplicates");
        }
        result.acceptedFormats.push_back(parsed);
    }
    const auto encoding = RequiredString(source, "colorEncoding", 16);
    if (encoding != "srgb" && encoding != "linear") {
        throw std::runtime_error("compositionSource.colorEncoding must be srgb or linear");
    }
    result.sourceIsSrgb = encoding == "srgb";
    if (RequiredString(source, "alphaMode", 16) != "ignore") {
        throw std::runtime_error("Only compositionSource.alphaMode=ignore is supported");
    }
    if (RequiredString(source, "onMissing", 16) != "black" ||
        RequiredString(source, "onMismatch", 16) != "black") {
        throw std::runtime_error("Missing or mismatched composition input must fail closed to black");
    }
    if (Boolean(source, "allowAutoSelect", false)) {
        throw std::runtime_error("Spout sender auto-selection is not permitted");
    }
    result.timeoutMs = BoundedInteger<std::uint32_t>(source, "timeoutMs", 1000, 100, 60000);
    result.startupGraceMs = BoundedInteger<std::uint32_t>(source, "startupGraceMs", 10000, 0, 300000);
    return result;
}

OutputConfig ParseOutput(const json& value, const CanvasConfig& canvas,
                         const std::filesystem::path& base, bool requireDisplay = true) {
    RequireObject(value, "output");
    RequireOnlyKeys(value,
                    {"id", "enabled", "display", "resolution", "sourceViewport", "overlap",
                     "processing", "blend", "blackUniformity", "color", "mask", "warp"},
                    "output");
    OutputConfig output;
    output.id = RequiredString(value, "id", 64);
    if (!IsIdentifier(output.id)) {
        throw std::runtime_error("output.id may only contain letters, numbers, dot, underscore and dash");
    }
    if (!value.contains("enabled")) throw std::runtime_error("output.enabled is required");
    output.enabled = Boolean(value, "enabled", true);

    if (!requireDisplay && value.contains("display")) throw std::runtime_error("Network output must not contain a display selector");
    if (requireDisplay) {
    if (!value.contains("display")) throw std::runtime_error("display is required");
    const auto& display = value.at("display");
    RequireObject(display, "display");
    RequireOnlyKeys(display, {"devicePath", "gdiName", "adapterLuid", "targetId"}, "display");
    if (auto path = OptionalString(display, "devicePath", 1024)) output.display.devicePath = Widen(*path);
    if (auto name = OptionalString(display, "gdiName", 32)) output.display.gdiName = Widen(*name);
    if (auto luid = OptionalString(display, "adapterLuid", 17)) {
        output.display.adapterLuid = ParseLuid(*luid);
        if (!output.display.adapterLuid) throw std::runtime_error("display.adapterLuid is invalid");
    }
    if (display.contains("targetId") && !display.at("targetId").is_null()) {
        output.display.targetId = BoundedInteger<std::uint32_t>(display, "targetId", 0, 0,
                                                                 std::numeric_limits<std::uint32_t>::max());
    }
    if (output.display.adapterLuid.has_value() != output.display.targetId.has_value()) {
        throw std::runtime_error("display.adapterLuid and display.targetId must be provided together");
    }
    if (output.display.devicePath &&
        !StartsWithInsensitive(*output.display.devicePath, L"\\\\?\\DISPLAY#")) {
        throw std::runtime_error("display.devicePath must be a Windows monitor device path");
    }
    if (output.display.gdiName) {
        constexpr std::wstring_view prefix = L"\\\\.\\DISPLAY";
        if (!StartsWithInsensitive(*output.display.gdiName, prefix)) {
            throw std::runtime_error("display.gdiName must look like \\\\.\\DISPLAY1");
        }
        const auto digits = output.display.gdiName->size() - prefix.size();
        if (digits == 0 || digits > 4 || (*output.display.gdiName)[prefix.size()] == L'0' ||
            !std::all_of(output.display.gdiName->begin() + static_cast<std::ptrdiff_t>(prefix.size()),
                         output.display.gdiName->end(), [](const wchar_t character) {
                             return character >= L'0' && character <= L'9';
                         })) {
            throw std::runtime_error("display.gdiName must look like \\\\.\\DISPLAY1");
        }
    }
    if (!output.display.devicePath && !output.display.gdiName &&
        !(output.display.adapterLuid && output.display.targetId)) {
        throw std::runtime_error("display needs devicePath, gdiName, or adapterLuid + targetId");
    }
    }

    if (!value.contains("resolution")) throw std::runtime_error("resolution is required");
    const auto& resolution = value.at("resolution");
    RequireObject(resolution, "resolution");
    RequireOnlyKeys(resolution, {"width", "height", "refreshNum", "refreshDen"}, "resolution");
    output.resolution.width = BoundedInteger<std::uint32_t>(resolution, "width", 0, 64, 16384, true);
    output.resolution.height = BoundedInteger<std::uint32_t>(resolution, "height", 0, 64, 16384, true);
    output.resolution.refreshNum = BoundedInteger<std::uint32_t>(resolution, "refreshNum", 0, 1, 240000, true);
    output.resolution.refreshDen = BoundedInteger<std::uint32_t>(resolution, "refreshDen", 0, 1, 100000, true);

    if (!value.contains("sourceViewport")) throw std::runtime_error("sourceViewport is required");
    const auto& viewport = value.at("sourceViewport");
    RequireObject(viewport, "sourceViewport");
    RequireOnlyKeys(viewport, {"x", "y", "width", "height"}, "sourceViewport");
    output.sourceViewport.x = BoundedFloat(viewport, "x", 0, 0, static_cast<float>(canvas.width));
    output.sourceViewport.y = BoundedFloat(viewport, "y", 0, 0, static_cast<float>(canvas.height));
    output.sourceViewport.width = BoundedFloat(viewport, "width", 0, 0.001F, static_cast<float>(canvas.width));
    output.sourceViewport.height = BoundedFloat(viewport, "height", 0, 0.001F, static_cast<float>(canvas.height));
    if (output.sourceViewport.x + output.sourceViewport.width > canvas.width + 0.01F ||
        output.sourceViewport.y + output.sourceViewport.height > canvas.height + 0.01F) {
        throw std::runtime_error("sourceViewport exceeds the master canvas");
    }

    if (value.contains("processing")) {
        const auto& processing = value.at("processing");
        RequireObject(processing, "processing");
        RequireOnlyKeys(processing, {"bypass", "order"}, "processing");
        output.processingBypass = Boolean(processing, "bypass", false);
        if (processing.contains("order")) {
            constexpr std::array<std::string_view, 6> expected{
                "sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"};
            const auto& order = processing.at("order");
            if (!order.is_array() || order.size() != expected.size()) {
                throw std::runtime_error("processing.order must describe the fixed final pipeline");
            }
            for (std::size_t index = 0; index < expected.size(); ++index) {
                if (!order[index].is_string() || order[index].get<std::string>() != expected[index]) {
                    throw std::runtime_error("processing.order cannot reorder the native final pipeline");
                }
            }
        }
    }

    if (value.contains("overlap")) {
        const auto& overlap = value.at("overlap");
        RequireObject(overlap, "overlap");
        RequireOnlyKeys(overlap, {"left", "right", "top", "bottom"}, "overlap");
        output.overlap.left = BoundedFloat(overlap, "left", 0, 0, static_cast<float>(output.resolution.width));
        output.overlap.right = BoundedFloat(overlap, "right", 0, 0, static_cast<float>(output.resolution.width));
        output.overlap.top = BoundedFloat(overlap, "top", 0, 0, static_cast<float>(output.resolution.height));
        output.overlap.bottom = BoundedFloat(overlap, "bottom", 0, 0, static_cast<float>(output.resolution.height));
        if (output.overlap.left + output.overlap.right >= output.resolution.width ||
            output.overlap.top + output.overlap.bottom >= output.resolution.height) {
            throw std::runtime_error("overlap edges must leave at least one unfeathered output pixel");
        }
    }
    if (value.contains("blend")) {
        const auto& blend = value.at("blend");
        RequireObject(blend, "blend");
        RequireOnlyKeys(blend, {"enabled", "feather", "gamma", "map"}, "blend");
        output.blendEnabled = Boolean(blend, "enabled", true);
        output.blendFeather = BoundedFloat(blend, "feather", 0.78F, 0.01F, 1);
        // Values close to zero collapse almost the entire feather into a
        // numerically unstable step. Keep parity with the controller DTO and
        // retain a useful, symmetric transition for the fallback blend curve.
        output.blendGamma = BoundedFloat(blend, "gamma", 2.2F, 0.1F, 8);
        if (blend.contains("map")) {
            output.blendMap = ParseTexture2D(blend.at("map"), base, RawTexture2DConfig::Format::r32Float);
        }
    }
    if (value.contains("blackUniformity")) {
        const auto& black = value.at("blackUniformity");
        RequireObject(black, "blackUniformity");
        RequireOnlyKeys(black, {"enabled", "lift", "map"}, "blackUniformity");
        output.blackMapEnabled = Boolean(black, "enabled", false);
        output.blackLift = BoundedFloat(black, "lift", 0, 0, 1);
        if (black.contains("map")) {
            output.blackMap = ParseTexture2D(black.at("map"), base,
                                             RawTexture2DConfig::Format::r32Float, true);
        }
    }
    if (value.contains("color")) {
        const auto& color = value.at("color");
        RequireObject(color, "color");
        RequireOnlyKeys(color, {"gain", "offset", "gamma", "lut"}, "color");
        output.gain = Float3(color, "gain", output.gain, 0, 8);
        output.offset = Float3(color, "offset", output.offset, -1, 1);
        output.gamma = Float3(color, "gamma", output.gamma, 0.1F, 8);
        if (color.contains("lut")) output.colorLut = ParseLut(color.at("lut"), base);
    }
    if (value.contains("mask")) {
        const auto& mask = value.at("mask");
        RequireObject(mask, "mask");
        RequireOnlyKeys(mask, {"enabled", "map", "path", "softness"}, "mask");
        output.maskEnabled = Boolean(mask, "enabled", false);
        if (mask.contains("map")) output.maskMap = ParseTexture2D(mask.at("map"), base, RawTexture2DConfig::Format::r32Float);
        if (mask.contains("path") && !mask.at("path").is_null()) {
            if (!mask.at("path").is_array() || mask.at("path").size() < 3 ||
                mask.at("path").size() > 4096) {
                throw std::runtime_error("mask.path must contain 3-4096 points");
            }
            for (const auto& point : mask.at("path")) {
                RequireObject(point, "mask point");
                RequireOnlyKeys(point, {"x", "y"}, "mask point");
                output.maskPath.push_back({BoundedFloat(point, "x", 0, -2, 3),
                                           BoundedFloat(point, "y", 0, -2, 3)});
            }
        }
        output.maskSoftness = BoundedFloat(mask, "softness", 0, 0, 1);
        if (output.maskEnabled && !output.maskMap && output.maskPath.size() < 3) {
            throw std::runtime_error("Enabled mask needs an r32_float map or polygon path");
        }
    }
    if (value.contains("warp")) {
        const auto& warp = value.at("warp");
        RequireObject(warp, "warp");
        RequireOnlyKeys(warp, {"enabled", "columns", "rows", "interpolation", "points"}, "warp");
        if (!warp.contains("enabled") || !warp.contains("columns") || !warp.contains("rows")) {
            throw std::runtime_error("warp.enabled, warp.columns and warp.rows are required");
        }
        output.warp.enabled = Boolean(warp, "enabled", false);
        output.warp.columns = BoundedInteger<std::uint32_t>(warp, "columns", 2, 2, 128);
        output.warp.rows = BoundedInteger<std::uint32_t>(warp, "rows", 2, 2, 128);
        output.warp.interpolation = RequiredString(warp, "interpolation", 16);
        if (output.warp.interpolation != "bilinear" && output.warp.interpolation != "bicubic") {
            throw std::runtime_error("warp.interpolation must be bilinear or bicubic");
        }
        if (!warp.contains("points") || !warp.at("points").is_array()) {
            throw std::runtime_error("warp.points must be an array");
        }
        const auto expected = static_cast<std::size_t>(output.warp.columns + 1) * (output.warp.rows + 1);
        if (warp.at("points").size() != expected) {
            throw std::runtime_error("warp.points count must equal (columns+1)*(rows+1)");
        }
        for (const auto& point : warp.at("points")) {
            RequireObject(point, "warp point");
            RequireOnlyKeys(point, {"u", "v", "x", "y"}, "warp point");
            output.warp.points.push_back({BoundedFloat(point, "u", 0, 0, 1),
                                          BoundedFloat(point, "v", 0, 0, 1),
                                          BoundedFloat(point, "x", 0, -2, 3),
                                          BoundedFloat(point, "y", 0, -2, 3)});
        }
        if (output.warp.enabled) {
            constexpr float minimumArea = 1.0e-8F;
            const auto orientation = [](const WarpPointConfig& a, const WarpPointConfig& b,
                                        const WarpPointConfig& c, const bool source) {
                const auto ax = source ? a.u : a.x;
                const auto ay = source ? a.v : a.y;
                const auto bx = source ? b.u : b.x;
                const auto by = source ? b.v : b.y;
                const auto cx = source ? c.u : c.x;
                const auto cy = source ? c.v : c.y;
                return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
            };
            const auto stride = static_cast<std::size_t>(output.warp.columns) + 1;
            for (std::uint32_t row = 0; row < output.warp.rows; ++row) {
                for (std::uint32_t column = 0; column < output.warp.columns; ++column) {
                    const auto topLeft = static_cast<std::size_t>(row) * stride + column;
                    const auto topRight = topLeft + 1;
                    const auto bottomLeft = topLeft + stride;
                    const auto bottomRight = bottomLeft + 1;
                    const auto validTriangle = [&](const std::size_t a, const std::size_t b,
                                                   const std::size_t c) {
                        return orientation(output.warp.points[a], output.warp.points[b],
                                           output.warp.points[c], true) > minimumArea &&
                               orientation(output.warp.points[a], output.warp.points[b],
                                           output.warp.points[c], false) > minimumArea;
                    };
                    if (!validTriangle(topLeft, topRight, bottomLeft) ||
                        !validTriangle(topRight, bottomRight, bottomLeft)) {
                        throw std::runtime_error("warp mesh contains a folded or degenerate cell");
                    }
                }
            }
        }
    } else {
        output.warp.columns = 2;
        output.warp.rows = 2;
        for (std::uint32_t row = 0; row <= 2; ++row) {
            for (std::uint32_t column = 0; column <= 2; ++column) {
                const auto u = static_cast<float>(column) / 2;
                const auto v = static_cast<float>(row) / 2;
                output.warp.points.push_back({u, v, u, v});
            }
        }
    }
    return output;
}

} // namespace

RendererConfig ConfigLoader::LoadFile(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    if (!stream) throw std::runtime_error("Unable to open renderer config: " + Narrow(path.wstring()));
    json value;
    stream >> value;
    return FromJson(value, std::filesystem::absolute(path).parent_path());
}

OutputConfig ConfigLoader::NetworkOutputFromJson(const json& value, const CanvasConfig& canvas,
                                                const std::filesystem::path& baseDirectory) {
    auto output = ParseOutput(value, canvas, baseDirectory, false);
    if (!output.enabled || output.resolution.width > 4096 || output.resolution.width % 2 ||
        output.resolution.height > 2160 ||
        static_cast<std::uint64_t>(output.resolution.refreshNum) * canvas.frameRateDen !=
        static_cast<std::uint64_t>(canvas.frameRateNum) * output.resolution.refreshDen) {
        throw std::runtime_error("Network output requires enabled even-width <=4K and canvas cadence");
    }
    return output;
}

RendererConfig ConfigLoader::FromJson(const json& value, const std::filesystem::path& baseDirectory) {
    RequireObject(value, "renderer config");
    RequireOnlyKeys(value,
                    {"$schema", "schemaVersion", "revision", "nodeId", "adapterLuid", "pipeName",
                     "vsync", "topmost", "telemetry", "canvas", "compositionSource", "outputs"},
                    "renderer config");
    if (value.contains("$schema")) (void)RequiredString(value, "$schema", 1024);
    RendererConfig config;
    config.configDirectory = baseDirectory.empty() ? std::filesystem::current_path() : baseDirectory;
    config.schemaVersion = BoundedInteger<std::uint32_t>(value, "schemaVersion", 0, 1, 1, true);
    config.revision = BoundedInteger<std::uint64_t>(value, "revision", 0, 1,
                                                    std::numeric_limits<std::int64_t>::max(), true);
    config.nodeId = RequiredString(value, "nodeId", 64);
    if (!IsIdentifier(config.nodeId)) {
        throw std::runtime_error("nodeId may only contain letters, numbers, dot, underscore and dash");
    }
    if (auto luid = OptionalString(value, "adapterLuid", 17)) {
        config.adapterLuid = ParseLuid(*luid);
        if (!config.adapterLuid) throw std::runtime_error("adapterLuid is invalid");
    }
    config.pipeName = value.contains("pipeName")
                          ? Widen(RequiredString(value, "pipeName", 256))
                          : DefaultPipeName(config.nodeId);
    constexpr std::wstring_view pipePrefix = L"\\\\.\\pipe\\";
    if (!config.pipeName.starts_with(pipePrefix) || config.pipeName.size() == pipePrefix.size()) {
        throw std::runtime_error("pipeName must be a local Windows named-pipe path");
    }
    config.vsync = Boolean(value, "vsync", true);
    config.topmost = Boolean(value, "topmost", true);

    if (!value.contains("canvas")) throw std::runtime_error("canvas is required");
    const auto& canvas = value.at("canvas");
    RequireObject(canvas, "canvas");
    RequireOnlyKeys(canvas, {"width", "height", "frameRateNum", "frameRateDen"}, "canvas");
    config.canvas.width = BoundedInteger<std::uint32_t>(canvas, "width", 0, 64, 16384, true);
    config.canvas.height = BoundedInteger<std::uint32_t>(canvas, "height", 0, 64, 16384, true);
    config.canvas.frameRateNum = BoundedInteger<std::uint32_t>(canvas, "frameRateNum", 0, 1, 240000, true);
    config.canvas.frameRateDen = BoundedInteger<std::uint32_t>(canvas, "frameRateDen", 0, 1, 100000, true);

    if (value.contains("telemetry")) {
        const auto& telemetry = value.at("telemetry");
        RequireObject(telemetry, "telemetry");
        RequireOnlyKeys(telemetry, {"path", "intervalMs"}, "telemetry");
        if (auto path = OptionalString(telemetry, "path", 1024)) {
            config.telemetry.path = ResolvePath(config.configDirectory, *path);
        }
        config.telemetry.intervalMs = BoundedInteger<std::uint32_t>(telemetry, "intervalMs", 1000, 100, 60000);
    }

    if (!value.contains("compositionSource")) throw std::runtime_error("compositionSource is required");
    config.compositionSource = ParseCompositionSource(value.at("compositionSource"), config.canvas);

    if (!value.contains("outputs") || !value.at("outputs").is_array() || value.at("outputs").empty()) {
        throw std::runtime_error("outputs must be a non-empty array");
    }
    if (value.at("outputs").size() > kMaxOutputs) throw std::runtime_error("Too many outputs for one renderer");
    std::unordered_set<std::string> ids;
    std::size_t enabledOutputs{};
    for (const auto& item : value.at("outputs")) {
        auto output = ParseOutput(item, config.canvas, config.configDirectory);
        if (!ids.insert(output.id).second) throw std::runtime_error("Duplicate output id: " + output.id);
        if (config.adapterLuid && output.display.adapterLuid &&
            *config.adapterLuid != *output.display.adapterLuid) {
            throw std::runtime_error("Output " + output.id + " selects a different GPU adapter");
        }
        if (output.enabled) ++enabledOutputs;
        config.outputs.push_back(std::move(output));
    }
    if (enabledOutputs == 0) throw std::runtime_error("Renderer config needs at least one enabled output");
    return config;
}

json ConfigLoader::ToJson(const RendererConfig& config) {
    const auto texture = [](const std::optional<RawTexture2DConfig>& asset) -> json {
        if (!asset) return nullptr;
        const char* format = "r32_float";
        if (asset->format == RawTexture2DConfig::Format::rg32Float) format = "rg32_float";
        if (asset->format == RawTexture2DConfig::Format::rgba32Float) format = "rgba32_float";
        return {{"path", Narrow(asset->path.wstring())}, {"width", asset->width},
                {"height", asset->height}, {"format", format}};
    };
    const auto lut = [](const std::optional<RawLut3DConfig>& asset) -> json {
        if (!asset) return nullptr;
        return {{"path", Narrow(asset->path.wstring())}, {"size", asset->size},
                {"format", "rgba32_float"}};
    };

    json outputs = json::array();
    for (const auto& output : config.outputs) {
        json display = json::object();
        if (output.display.devicePath) display["devicePath"] = Narrow(*output.display.devicePath);
        if (output.display.gdiName) display["gdiName"] = Narrow(*output.display.gdiName);
        if (output.display.adapterLuid) display["adapterLuid"] = LuidToString(*output.display.adapterLuid);
        if (output.display.targetId) display["targetId"] = *output.display.targetId;

        json points = json::array();
        for (const auto& point : output.warp.points) {
            points.push_back({{"u", point.u}, {"v", point.v}, {"x", point.x}, {"y", point.y}});
        }
        json maskPath = nullptr;
        if (!output.maskPath.empty()) {
            maskPath = json::array();
            for (const auto& point : output.maskPath) maskPath.push_back({{"x", point.x}, {"y", point.y}});
        }
        outputs.push_back({
            {"id", output.id}, {"enabled", output.enabled}, {"display", std::move(display)},
            {"resolution", {{"width", output.resolution.width}, {"height", output.resolution.height},
                            {"refreshNum", output.resolution.refreshNum}, {"refreshDen", output.resolution.refreshDen}}},
            {"sourceViewport", {{"x", output.sourceViewport.x}, {"y", output.sourceViewport.y},
                                {"width", output.sourceViewport.width}, {"height", output.sourceViewport.height}}},
            {"processing", {{"bypass", output.processingBypass},
                            {"order", {"sourceViewport", "warp", "blend", "blackUniformity", "color", "mask"}}}},
            {"overlap", {{"left", output.overlap.left}, {"right", output.overlap.right},
                         {"top", output.overlap.top}, {"bottom", output.overlap.bottom}}},
            {"blend", {{"enabled", output.blendEnabled}, {"feather", output.blendFeather},
                       {"gamma", output.blendGamma}, {"map", texture(output.blendMap)}}},
            {"blackUniformity", {{"enabled", output.blackMapEnabled}, {"lift", output.blackLift},
                                 {"map", texture(output.blackMap)}}},
            {"color", {{"gain", output.gain}, {"offset", output.offset}, {"gamma", output.gamma},
                       {"lut", lut(output.colorLut)}}},
            {"mask", {{"enabled", output.maskEnabled}, {"map", texture(output.maskMap)},
                      {"path", std::move(maskPath)}, {"softness", output.maskSoftness}}},
            {"warp", {{"enabled", output.warp.enabled}, {"columns", output.warp.columns},
                      {"rows", output.warp.rows}, {"interpolation", output.warp.interpolation},
                      {"points", std::move(points)}}},
        });
    }
    json acceptedFormats = json::array();
    for (const auto format : config.compositionSource.acceptedFormats) {
        acceptedFormats.push_back(DxgiFormatName(format));
    }
    json telemetry = {{"intervalMs", config.telemetry.intervalMs}};
    telemetry["path"] = config.telemetry.path ? json(Narrow(config.telemetry.path->wstring())) : json(nullptr);
    return {
        {"schemaVersion", config.schemaVersion}, {"revision", config.revision}, {"nodeId", config.nodeId},
        {"adapterLuid", config.adapterLuid ? json(LuidToString(*config.adapterLuid)) : json(nullptr)},
        {"pipeName", Narrow(config.pipeName)},
        {"vsync", config.vsync}, {"topmost", config.topmost}, {"telemetry", std::move(telemetry)},
        {"compositionSource", {{"type", "spout"}, {"senderName", config.compositionSource.senderName},
                               {"width", config.compositionSource.width.value_or(config.canvas.width)},
                               {"height", config.compositionSource.height.value_or(config.canvas.height)},
                               {"frameRateNum", config.compositionSource.frameRateNum},
                               {"frameRateDen", config.compositionSource.frameRateDen},
                               {"acceptedFormats", std::move(acceptedFormats)},
                               {"colorEncoding", config.compositionSource.sourceIsSrgb ? "srgb" : "linear"},
                               {"alphaMode", "ignore"}, {"timeoutMs", config.compositionSource.timeoutMs},
                               {"startupGraceMs", config.compositionSource.startupGraceMs},
                               {"onMissing", "black"}, {"onMismatch", "black"},
                               {"allowAutoSelect", false}}},
        {"canvas", {{"width", config.canvas.width}, {"height", config.canvas.height},
                    {"frameRateNum", config.canvas.frameRateNum}, {"frameRateDen", config.canvas.frameRateDen}}},
        {"outputs", std::move(outputs)},
    };
}

std::wstring ConfigLoader::DefaultPipeName(const std::string& nodeId) {
    return L"\\\\.\\pipe\\pixel-brightness-renderer-" + Widen(nodeId);
}

std::string DxgiFormatName(const DXGI_FORMAT format) {
    switch (format) {
    case DXGI_FORMAT_R16G16B16A16_FLOAT: return "DXGI_FORMAT_R16G16B16A16_FLOAT";
    case DXGI_FORMAT_R8G8B8A8_UNORM: return "DXGI_FORMAT_R8G8B8A8_UNORM";
    case DXGI_FORMAT_B8G8R8A8_UNORM: return "DXGI_FORMAT_B8G8R8A8_UNORM";
    default: return "DXGI_FORMAT_UNKNOWN";
    }
}

DXGI_FORMAT ParseDxgiFormat(const std::string& value) {
    if (value == "DXGI_FORMAT_R16G16B16A16_FLOAT") return DXGI_FORMAT_R16G16B16A16_FLOAT;
    if (value == "DXGI_FORMAT_R8G8B8A8_UNORM") return DXGI_FORMAT_R8G8B8A8_UNORM;
    if (value == "DXGI_FORMAT_B8G8R8A8_UNORM") return DXGI_FORMAT_B8G8R8A8_UNORM;
    throw std::runtime_error("Unsupported Spout DXGI format: " + value);
}

std::string LuidToString(const LuidValue& luid) {
    return std::format("{:08X}:{:08X}", static_cast<std::uint32_t>(luid.highPart), luid.lowPart);
}

std::optional<LuidValue> ParseLuid(const std::string& value) {
    if (value.size() != 17 || value[8] != ':') return std::nullopt;
    std::uint32_t high{};
    std::uint32_t low{};
    const auto parse = [](const std::string_view text, std::uint32_t& output) {
        const auto result = std::from_chars(text.data(), text.data() + text.size(), output, 16);
        return result.ec == std::errc{} && result.ptr == text.data() + text.size();
    };
    if (!parse(std::string_view(value).substr(0, 8), high) ||
        !parse(std::string_view(value).substr(9, 8), low)) return std::nullopt;
    return LuidValue{low, static_cast<std::int32_t>(high)};
}

PatternMode ParsePatternMode(const std::string& value) {
    if (value == "content") return PatternMode::content;
    if (value == "black") return PatternMode::black;
    if (value == "white") return PatternMode::white;
    if (value == "gray" || value == "grey") return PatternMode::gray;
    if (value == "red") return PatternMode::red;
    if (value == "green") return PatternMode::green;
    if (value == "blue") return PatternMode::blue;
    if (value == "grid") return PatternMode::grid;
    if (value == "identify") return PatternMode::identify;
    if (value == "solid") return PatternMode::solid;
    if (value == "gray-code") return PatternMode::grayCode;
    throw std::runtime_error("Unsupported pattern mode: " + value);
}

std::string PatternModeName(const PatternMode value) {
    switch (value) {
    case PatternMode::content: return "content";
    case PatternMode::black: return "black";
    case PatternMode::white: return "white";
    case PatternMode::gray: return "gray";
    case PatternMode::red: return "red";
    case PatternMode::green: return "green";
    case PatternMode::blue: return "blue";
    case PatternMode::grid: return "grid";
    case PatternMode::identify: return "identify";
    case PatternMode::solid: return "solid";
    case PatternMode::grayCode: return "gray-code";
    }
    return "unknown";
}

PatternConfig ParsePatternCommand(const nlohmann::json& payload) {
    RequireOnlyKeys(payload,
                    {"mode", "cellSize", "axis", "bit", "inverse", "rgb",
                     "applyCorrections", "outputId"},
                    "set-pattern");
    if (payload.contains("mode") && !payload.at("mode").is_string()) {
        throw std::runtime_error("set-pattern.mode must be a string");
    }
    PatternConfig pattern;
    pattern.mode = ParsePatternMode(payload.value("mode", "content"));
    if (payload.contains("applyCorrections")) {
        if (pattern.mode != PatternMode::solid) {
            throw std::runtime_error("set-pattern.applyCorrections is only valid for solid mode");
        }
        if (!payload.at("applyCorrections").is_boolean()) {
            throw std::runtime_error("set-pattern.applyCorrections must be boolean");
        }
        pattern.applyCorrections = payload.at("applyCorrections").get<bool>();
    }
    if (payload.contains("cellSize")) {
        if (!payload.at("cellSize").is_number_integer() &&
            !payload.at("cellSize").is_number_unsigned()) {
            throw std::runtime_error("set-pattern.cellSize must be an integer");
        }
        const auto value = payload.at("cellSize").get<std::int64_t>();
        if (value < 2 || value > 1024) {
            throw std::runtime_error("set-pattern.cellSize must be 2-1024");
        }
        pattern.cellSize = static_cast<std::uint32_t>(value);
    }
    if (pattern.mode == PatternMode::solid) {
        if (!payload.contains("rgb") || !payload.at("rgb").is_array() ||
            payload.at("rgb").size() != 3) {
            throw std::runtime_error(
                "set-pattern solid mode requires rgb with three linear channels");
        }
        for (std::size_t index = 0; index < pattern.solidRgb.size(); ++index) {
            const auto& channel = payload.at("rgb")[index];
            if (!channel.is_number()) {
                throw std::runtime_error("set-pattern.rgb must contain numbers");
            }
            const auto value = channel.get<float>();
            if (!std::isfinite(value) || value < 0 || value > 1) {
                throw std::runtime_error(
                    "set-pattern.rgb channels must be in the 0-1 linear range");
            }
            pattern.solidRgb[index] = value;
        }
    } else if (payload.contains("rgb")) {
        throw std::runtime_error("set-pattern.rgb is only valid for solid mode");
    }
    if (pattern.mode == PatternMode::grayCode) {
        if (!payload.contains("axis") || !payload.at("axis").is_string()) {
            throw std::runtime_error("set-pattern gray-code mode requires axis x or y");
        }
        const auto axis = payload.at("axis").get<std::string>();
        if (axis != "x" && axis != "y") {
            throw std::runtime_error("set-pattern.axis must be x or y");
        }
        pattern.grayAxisY = axis == "y";
        if (!payload.contains("bit") ||
            (!payload.at("bit").is_number_integer() &&
             !payload.at("bit").is_number_unsigned())) {
            throw std::runtime_error("set-pattern gray-code mode requires integer bit");
        }
        const auto bit = payload.at("bit").get<std::int64_t>();
        if (bit < 0 || bit > 31) {
            throw std::runtime_error("set-pattern.bit must be 0-31");
        }
        pattern.grayBit = static_cast<std::uint32_t>(bit);
        if (payload.contains("inverse") && !payload.at("inverse").is_boolean()) {
            throw std::runtime_error("set-pattern.inverse must be boolean");
        }
        pattern.inverse = payload.value("inverse", false);
    } else if (payload.contains("axis") || payload.contains("bit") ||
               payload.contains("inverse")) {
        throw std::runtime_error(
            "set-pattern axis, bit and inverse are only valid for gray-code mode");
    }
    return pattern;
}

bool PatternModeSupportsCorrections(const PatternMode value) noexcept {
    return value == PatternMode::solid;
}

bool PatternCorrectionsBypassed(const PatternConfig& pattern,
                                const bool processingBypass) noexcept {
    if (processingBypass) return true;
    if (pattern.mode == PatternMode::content) return false;
    return !PatternModeSupportsCorrections(pattern.mode) || !pattern.applyCorrections;
}

} // namespace pbwin

#include "pbwin/DisplayRegistry.hpp"

#include "pbwin/Log.hpp"

#include <algorithm>
#include <cwchar>
#include <stdexcept>

namespace pbwin {
namespace {

LuidValue ConvertLuid(const LUID luid) {
    return {luid.LowPart, luid.HighPart};
}

bool EqualInsensitive(const std::wstring& left, const std::wstring& right) {
    return _wcsicmp(left.c_str(), right.c_str()) == 0;
}

} // namespace

std::vector<DisplayDescriptor> DisplayRegistry::EnumerateActive() {
    std::vector<DISPLAYCONFIG_PATH_INFO> paths;
    std::vector<DISPLAYCONFIG_MODE_INFO> modes;
    LONG result = ERROR_INSUFFICIENT_BUFFER;
    UINT32 pathCount{};
    UINT32 modeCount{};
    // The active path count can change between the sizing and query calls
    // during a monitor hot-plug. Retry that documented race a few times so a
    // transient count change does not latch the whole node in display-error.
    for (int attempt = 0; attempt < 3 && result == ERROR_INSUFFICIENT_BUFFER; ++attempt) {
        result = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, &pathCount, &modeCount);
        if (result != ERROR_SUCCESS) break;
        paths.resize(pathCount);
        modes.resize(modeCount);
        result = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, &pathCount, paths.data(), &modeCount,
                                    modes.data(), nullptr);
    }
    if (result != ERROR_SUCCESS) {
        throw std::runtime_error("Query active display configuration failed: " + std::to_string(result));
    }
    paths.resize(pathCount);

    std::vector<DisplayDescriptor> displays;
    displays.reserve(paths.size());
    for (const auto& path : paths) {
        DISPLAYCONFIG_SOURCE_DEVICE_NAME source{};
        source.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_SOURCE_NAME;
        source.header.size = sizeof(source);
        source.header.adapterId = path.sourceInfo.adapterId;
        source.header.id = path.sourceInfo.id;
        if (DisplayConfigGetDeviceInfo(&source.header) != ERROR_SUCCESS) continue;

        DISPLAYCONFIG_TARGET_DEVICE_NAME target{};
        target.header.type = DISPLAYCONFIG_DEVICE_INFO_GET_TARGET_NAME;
        target.header.size = sizeof(target);
        target.header.adapterId = path.targetInfo.adapterId;
        target.header.id = path.targetInfo.id;
        if (DisplayConfigGetDeviceInfo(&target.header) != ERROR_SUCCESS) continue;

        DEVMODEW mode{};
        mode.dmSize = sizeof(mode);
        if (!EnumDisplaySettingsExW(source.viewGdiDeviceName, ENUM_CURRENT_SETTINGS, &mode, 0)) continue;

        DisplayDescriptor display;
        display.devicePath = target.monitorDevicePath;
        display.gdiName = source.viewGdiDeviceName;
        display.friendlyName = target.monitorFriendlyDeviceName;
        display.adapterLuid = ConvertLuid(path.targetInfo.adapterId);
        display.sourceId = path.sourceInfo.id;
        display.targetId = path.targetInfo.id;
        display.desktopRect = {
            mode.dmPosition.x,
            mode.dmPosition.y,
            mode.dmPosition.x + static_cast<LONG>(mode.dmPelsWidth),
            mode.dmPosition.y + static_cast<LONG>(mode.dmPelsHeight),
        };
        display.width = mode.dmPelsWidth;
        display.height = mode.dmPelsHeight;
        display.refreshNum = path.targetInfo.refreshRate.Numerator;
        display.refreshDen = path.targetInfo.refreshRate.Denominator == 0 ? 1 : path.targetInfo.refreshRate.Denominator;
        display.active = (path.flags & DISPLAYCONFIG_PATH_ACTIVE) != 0;
        displays.push_back(std::move(display));
    }
    std::sort(displays.begin(), displays.end(), [](const auto& left, const auto& right) {
        if (left.desktopRect.left != right.desktopRect.left) return left.desktopRect.left < right.desktopRect.left;
        return left.desktopRect.top < right.desktopRect.top;
    });
    return displays;
}

std::optional<DisplayDescriptor> DisplayRegistry::Resolve(
    const DisplaySelector& selector, const std::vector<DisplayDescriptor>& displays) {
    if (selector.adapterLuid.has_value() != selector.targetId.has_value()) return std::nullopt;
    if (!selector.devicePath && !selector.gdiName && !selector.adapterLuid) return std::nullopt;

    // Treat every configured identifier as an assertion about one physical
    // target. Falling back from a stale devicePath to a recycled DISPLAYn name
    // can silently put show content on the wrong projector after hot-plugging.
    // An ambiguity or disagreement therefore fails closed and requires rebind.
    const DisplayDescriptor* resolved{};
    for (const auto& display : displays) {
        if (selector.devicePath && !EqualInsensitive(display.devicePath, *selector.devicePath)) continue;
        if (selector.gdiName && !EqualInsensitive(display.gdiName, *selector.gdiName)) continue;
        if (selector.adapterLuid &&
            (display.adapterLuid != *selector.adapterLuid || display.targetId != *selector.targetId)) continue;
        if (resolved) return std::nullopt;
        resolved = &display;
    }
    return resolved ? std::optional<DisplayDescriptor>(*resolved) : std::nullopt;
}

Microsoft::WRL::ComPtr<IDXGIOutput6> DisplayRegistry::FindDxgiOutput(
    IDXGIAdapter1* adapter, const DisplayDescriptor& display) {
    for (UINT index = 0;; ++index) {
        Microsoft::WRL::ComPtr<IDXGIOutput> output;
        const auto result = adapter->EnumOutputs(index, output.ReleaseAndGetAddressOf());
        if (result == DXGI_ERROR_NOT_FOUND) break;
        ThrowIfFailed(result, "IDXGIAdapter::EnumOutputs");
        DXGI_OUTPUT_DESC description{};
        ThrowIfFailed(output->GetDesc(&description), "IDXGIOutput::GetDesc");
        if (_wcsicmp(description.DeviceName, display.gdiName.c_str()) != 0) continue;
        Microsoft::WRL::ComPtr<IDXGIOutput6> output6;
        ThrowIfFailed(output.As(&output6), "Query IDXGIOutput6");
        return output6;
    }
    throw std::runtime_error("DXGI output not found for " + Narrow(display.gdiName));
}

} // namespace pbwin

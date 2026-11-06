#pragma once

#include "pbwin/Config.hpp"

#include <Windows.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <optional>
#include <string>
#include <vector>

namespace pbwin {

struct DisplayDescriptor {
    std::wstring devicePath;
    std::wstring gdiName;
    std::wstring friendlyName;
    LuidValue adapterLuid;
    std::uint32_t sourceId{};
    std::uint32_t targetId{};
    RECT desktopRect{};
    std::uint32_t width{};
    std::uint32_t height{};
    std::uint32_t refreshNum{};
    std::uint32_t refreshDen{1};
    bool active{};
};

class DisplayRegistry final {
public:
    static std::vector<DisplayDescriptor> EnumerateActive();
    static std::optional<DisplayDescriptor> Resolve(
        const DisplaySelector& selector,
        const std::vector<DisplayDescriptor>& displays);
    static Microsoft::WRL::ComPtr<IDXGIOutput6> FindDxgiOutput(
        IDXGIAdapter1* adapter,
        const DisplayDescriptor& display);
};

} // namespace pbwin

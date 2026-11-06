#include "pbwin/D3DDevice.hpp"

#include "pbwin/Log.hpp"

#include <Windows.h>

#include <array>
#include <stdexcept>
#include <utility>

namespace pbwin {

void D3DDevice::Create(const std::optional<LuidValue>& requestedAdapter) {
    UINT factoryFlags{};
#if defined(_DEBUG)
    if constexpr (PB_ENABLE_D3D_DEBUG != 0) factoryFlags |= DXGI_CREATE_FACTORY_DEBUG;
#endif
    auto result = CreateDXGIFactory2(factoryFlags, IID_PPV_ARGS(factory_.ReleaseAndGetAddressOf()));
    if (FAILED(result) && factoryFlags != 0) {
        Log::Warning("DXGI debug factory unavailable; retrying without debug layer");
        ThrowIfFailed(CreateDXGIFactory2(0, IID_PPV_ARGS(factory_.ReleaseAndGetAddressOf())),
                      "CreateDXGIFactory2");
    } else {
        ThrowIfFailed(result, "CreateDXGIFactory2");
    }

    for (UINT index = 0;; ++index) {
        Microsoft::WRL::ComPtr<IDXGIAdapter1> candidate;
        const auto enumeration = factory_->EnumAdapterByGpuPreference(
            index, DXGI_GPU_PREFERENCE_HIGH_PERFORMANCE,
            IID_PPV_ARGS(candidate.ReleaseAndGetAddressOf()));
        if (enumeration == DXGI_ERROR_NOT_FOUND) break;
        ThrowIfFailed(enumeration, "EnumAdapterByGpuPreference");
        DXGI_ADAPTER_DESC1 description{};
        ThrowIfFailed(candidate->GetDesc1(&description), "IDXGIAdapter1::GetDesc1");
        if ((description.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) != 0) continue;
        const LuidValue luid{description.AdapterLuid.LowPart, description.AdapterLuid.HighPart};
        if (requestedAdapter && luid != *requestedAdapter) continue;
        adapter_ = std::move(candidate);
        adapterLuid_ = luid;
        adapterName_ = Narrow(description.Description);
        break;
    }
    if (!adapter_) {
        throw std::runtime_error(requestedAdapter ? "Configured GPU adapter LUID was not found"
                                                   : "No hardware DXGI adapter was found");
    }

    constexpr std::array featureLevels{
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
    };
    UINT deviceFlags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
#if defined(_DEBUG)
    if constexpr (PB_ENABLE_D3D_DEBUG != 0) deviceFlags |= D3D11_CREATE_DEVICE_DEBUG;
#endif
    Microsoft::WRL::ComPtr<ID3D11Device> baseDevice;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext> baseContext;
    D3D_FEATURE_LEVEL createdLevel{};
    result = D3D11CreateDevice(adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, deviceFlags,
                               featureLevels.data(), static_cast<UINT>(featureLevels.size()),
                               D3D11_SDK_VERSION, baseDevice.ReleaseAndGetAddressOf(), &createdLevel,
                               baseContext.ReleaseAndGetAddressOf());
    if (FAILED(result) && (deviceFlags & D3D11_CREATE_DEVICE_DEBUG) != 0) {
        Log::Warning("D3D debug layer unavailable; retrying production device creation");
        deviceFlags &= ~D3D11_CREATE_DEVICE_DEBUG;
        result = D3D11CreateDevice(adapter_.Get(), D3D_DRIVER_TYPE_UNKNOWN, nullptr, deviceFlags,
                                   featureLevels.data(), static_cast<UINT>(featureLevels.size()),
                                   D3D11_SDK_VERSION, baseDevice.ReleaseAndGetAddressOf(), &createdLevel,
                                   baseContext.ReleaseAndGetAddressOf());
    }
    ThrowIfFailed(result, "D3D11CreateDevice");
    ThrowIfFailed(baseDevice.As(&device_), "Query ID3D11Device5");
    ThrowIfFailed(baseContext.As(&context_), "Query ID3D11DeviceContext4");

    BOOL allowTearing{};
    tearingSupported_ = SUCCEEDED(factory_->CheckFeatureSupport(
                            DXGI_FEATURE_PRESENT_ALLOW_TEARING, &allowTearing, sizeof(allowTearing))) &&
                        allowTearing;
    Log::Info("D3D11 device ready: {} LUID={} feature=0x{:X}", adapterName_,
              LuidToString(adapterLuid_), static_cast<unsigned>(createdLevel));
}

void D3DDevice::CheckRemoved() const {
    const auto reason = DeviceRemovedReason();
    if (FAILED(reason)) ThrowIfFailed(reason, "D3D11 device removed");
}

HRESULT D3DDevice::DeviceRemovedReason() const noexcept {
    return device_ ? device_->GetDeviceRemovedReason() : DXGI_ERROR_DEVICE_REMOVED;
}

void D3DDevice::Swap(D3DDevice& other) noexcept {
    factory_.Swap(other.factory_);
    adapter_.Swap(other.adapter_);
    device_.Swap(other.device_);
    context_.Swap(other.context_);
    std::swap(adapterLuid_, other.adapterLuid_);
    adapterName_.swap(other.adapterName_);
    std::swap(tearingSupported_, other.tearingSupported_);
}

} // namespace pbwin

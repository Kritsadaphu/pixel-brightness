#pragma once

#include "pbwin/Config.hpp"

#include <d3d11_4.h>
#include <dxgi1_6.h>
#include <wrl/client.h>

#include <optional>
#include <string>

namespace pbwin {

class D3DDevice final {
public:
    D3DDevice() = default;
    D3DDevice(const D3DDevice&) = delete;
    D3DDevice& operator=(const D3DDevice&) = delete;

    void Create(const std::optional<LuidValue>& requestedAdapter);
    void CheckRemoved() const;
    void Swap(D3DDevice& other) noexcept;

    [[nodiscard]] ID3D11Device5* Device() const noexcept { return device_.Get(); }
    [[nodiscard]] ID3D11DeviceContext4* Context() const noexcept { return context_.Get(); }
    [[nodiscard]] IDXGIFactory6* Factory() const noexcept { return factory_.Get(); }
    [[nodiscard]] IDXGIAdapter1* Adapter() const noexcept { return adapter_.Get(); }
    [[nodiscard]] const LuidValue& AdapterLuid() const noexcept { return adapterLuid_; }
    [[nodiscard]] const std::string& AdapterName() const noexcept { return adapterName_; }
    [[nodiscard]] bool TearingSupported() const noexcept { return tearingSupported_; }
    [[nodiscard]] HRESULT DeviceRemovedReason() const noexcept;

private:
    Microsoft::WRL::ComPtr<IDXGIFactory6> factory_;
    Microsoft::WRL::ComPtr<IDXGIAdapter1> adapter_;
    Microsoft::WRL::ComPtr<ID3D11Device5> device_;
    Microsoft::WRL::ComPtr<ID3D11DeviceContext4> context_;
    LuidValue adapterLuid_{};
    std::string adapterName_;
    bool tearingSupported_{};
};

} // namespace pbwin

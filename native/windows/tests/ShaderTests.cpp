#include <d3d11shader.h>
#include <d3dcompiler.h>
#include <wrl/client.h>

#include <array>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>

namespace {

using Microsoft::WRL::ComPtr;

void Require(const bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

ComPtr<ID3DBlob> Compile(const std::filesystem::path& path, const char* target) {
    ComPtr<ID3DBlob> bytecode;
    ComPtr<ID3DBlob> errors;
    const auto result = D3DCompileFromFile(path.c_str(), nullptr, D3D_COMPILE_STANDARD_FILE_INCLUDE,
                                           "main", target, D3DCOMPILE_ENABLE_STRICTNESS, 0,
                                           bytecode.ReleaseAndGetAddressOf(),
                                           errors.ReleaseAndGetAddressOf());
    if (FAILED(result)) {
        const auto detail = errors
                                ? std::string(static_cast<const char*>(errors->GetBufferPointer()),
                                              errors->GetBufferSize())
                                : "no compiler diagnostic";
        throw std::runtime_error(path.string() + " failed to compile: " + detail);
    }
    return bytecode;
}

void RequireVariable(ID3D11ShaderReflectionConstantBuffer* buffer, const char* name,
                     const UINT expectedOffset) {
    const auto variable = buffer->GetVariableByName(name);
    Require(variable != nullptr, "shader constant is missing");
    D3D11_SHADER_VARIABLE_DESC description{};
    Require(SUCCEEDED(variable->GetDesc(&description)), "shader constant reflection failed");
    if (description.StartOffset != expectedOffset) {
        throw std::runtime_error(std::string(name) + " has the wrong native ABI offset");
    }
}

} // namespace

int main() {
    try {
        const std::filesystem::path directory(PB_TEST_SHADER_DIR);
        (void)Compile(directory / L"fullscreen_vs.hlsl", "vs_5_0");
        const auto pixel = Compile(directory / L"final_ps.hlsl", "ps_5_0");

        ComPtr<ID3D11ShaderReflection> reflection;
        const auto result = D3DReflect(pixel->GetBufferPointer(), pixel->GetBufferSize(),
                                       IID_ID3D11ShaderReflection,
                                       reinterpret_cast<void**>(reflection.ReleaseAndGetAddressOf()));
        Require(SUCCEEDED(result), "pixel shader reflection failed");
        const auto constants = reflection->GetConstantBufferByName("OutputConstants");
        Require(constants != nullptr, "OutputConstants was not found");
        D3D11_SHADER_BUFFER_DESC bufferDescription{};
        Require(SUCCEEDED(constants->GetDesc(&bufferDescription)), "constant buffer reflection failed");
        Require(bufferDescription.Size == 144, "OutputConstants size differs from FinalPipeline::Constants");

        constexpr std::array expected{
            std::pair{"sourceRect", 0U}, std::pair{"overlapPixels", 16U},
            std::pair{"outputSize", 32U}, std::pair{"blendFeather", 40U},
            std::pair{"blendGamma", 44U}, std::pair{"lutSize", 48U},
            std::pair{"patternCellSize", 52U}, std::pair{"flags", 56U},
            std::pair{"patternMode", 60U}, std::pair{"patternAxis", 64U},
            std::pair{"patternBit", 68U}, std::pair{"patternInverse", 72U},
            std::pair{"solidRgb", 80U}, std::pair{"gain", 96U},
            std::pair{"offset", 112U}, std::pair{"gammaValue", 128U},
        };
        for (const auto& [name, offset] : expected) RequireVariable(constants, name, offset);

        std::cout << "pbwin shader compilation and ABI tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pbwin shader tests failed: " << error.what() << '\n';
        return 1;
    }
}

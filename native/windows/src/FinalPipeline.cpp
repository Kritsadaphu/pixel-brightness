#include "pbwin/FinalPipeline.hpp"

#include "pbwin/Digest.hpp"
#include "pbwin/Log.hpp"

#include <d3dcompiler.h>
#include <nlohmann/json.hpp>

#include <array>
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <fstream>
#include <limits>
#include <stdexcept>
#include <vector>

namespace pbwin {
namespace {

using Microsoft::WRL::ComPtr;

struct MeshVertex {
    float position[2];
    float uv[2];
};

template <typename T>
std::string VectorSha256(const std::vector<T>& values) {
    return Sha256Hex(std::as_bytes(std::span(values.data(), values.size())));
}

struct LoadedFloats {
    std::vector<float> values;
    std::string sha256;
};

ComPtr<ID3DBlob> CompileShader(const std::filesystem::path& path, const char* target) {
    UINT flags = D3DCOMPILE_ENABLE_STRICTNESS;
#if defined(_DEBUG)
    flags |= D3DCOMPILE_DEBUG | D3DCOMPILE_SKIP_OPTIMIZATION;
#else
    flags |= D3DCOMPILE_OPTIMIZATION_LEVEL3;
#endif
    ComPtr<ID3DBlob> bytecode;
    ComPtr<ID3DBlob> errors;
    const auto result = D3DCompileFromFile(path.c_str(), nullptr, D3D_COMPILE_STANDARD_FILE_INCLUDE,
                                           "main", target, flags, 0,
                                           bytecode.ReleaseAndGetAddressOf(),
                                           errors.ReleaseAndGetAddressOf());
    if (FAILED(result)) {
        const auto detail = errors ? std::string(static_cast<const char*>(errors->GetBufferPointer()),
                                                  errors->GetBufferSize())
                                   : HResultMessage(result);
        throw std::runtime_error("Shader compilation failed for " + Narrow(path.wstring()) + ": " + detail);
    }
    return bytecode;
}

LoadedFloats ReadFloats(const std::filesystem::path& path, const std::size_t count,
                        const bool unitRange) {
    if (count > std::numeric_limits<std::size_t>::max() / sizeof(float)) {
        throw std::runtime_error("Correction asset size overflow");
    }
    const auto bytes = count * sizeof(float);
    constexpr std::size_t maximumAssetBytes = 256ULL * 1024 * 1024;
    if (bytes > maximumAssetBytes) throw std::runtime_error("Correction asset exceeds the 256 MiB safety limit");
    std::error_code error;
    const auto actualBytes = std::filesystem::file_size(path, error);
    if (error || actualBytes != bytes) {
        throw std::runtime_error("Correction asset byte count mismatch: " + Narrow(path.wstring()));
    }
    std::vector<float> data(count);
    std::ifstream stream(path, std::ios::binary);
    if (!stream || !stream.read(reinterpret_cast<char*>(data.data()), static_cast<std::streamsize>(bytes))) {
        throw std::runtime_error("Unable to read correction asset: " + Narrow(path.wstring()));
    }
    for (const auto value : data) {
        if (!std::isfinite(value) || (unitRange && (value < 0 || value > 1))) {
            throw std::runtime_error("Correction asset contains an invalid float: " + Narrow(path.wstring()));
        }
    }
    auto digest = VectorSha256(data);
    return {std::move(data), std::move(digest)};
}

ComPtr<ID3D11ShaderResourceView> CreateScalarTexture2D(ID3D11Device* device,
                                                       const std::uint32_t width,
                                                       const std::uint32_t height,
                                                       const std::vector<float>& data) {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = width;
    description.Height = height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_R32_FLOAT;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_IMMUTABLE;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{
        data.data(), static_cast<UINT>(width * sizeof(float)), 0};
    ComPtr<ID3D11Texture2D> texture;
    ThrowIfFailed(device->CreateTexture2D(&description, &initial, texture.ReleaseAndGetAddressOf()),
                  "Create rasterized polygon mask");
    ComPtr<ID3D11ShaderResourceView> view;
    ThrowIfFailed(device->CreateShaderResourceView(texture.Get(), nullptr, view.ReleaseAndGetAddressOf()),
                  "Create rasterized polygon mask view");
    return view;
}

ComPtr<ID3D11ShaderResourceView> RasterizePolygonMask(ID3D11Device* device,
                                                      const OutputConfig& output,
                                                      std::string& digest) {
    constexpr std::uint32_t maximumDimension = 2048;
    const auto width = std::min(output.resolution.width, maximumDimension);
    const auto height = std::min(output.resolution.height, maximumDimension);
    std::vector<float> mask(static_cast<std::size_t>(width) * height, 0.0F);
    std::vector<float> intersections;
    intersections.reserve(output.maskPath.size());

    // Even-odd scanline fill is O(rows * edges + pixels) and remains bounded
    // for the Web UI's maximum 4096-point polygon.
    for (std::uint32_t row = 0; row < height; ++row) {
        const auto y = (static_cast<float>(row) + 0.5F) / height;
        intersections.clear();
        for (std::size_t index = 0; index < output.maskPath.size(); ++index) {
            const auto& a = output.maskPath[index];
            const auto& b = output.maskPath[(index + 1) % output.maskPath.size()];
            if ((a.y > y) == (b.y > y)) continue;
            intersections.push_back(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
        }
        std::sort(intersections.begin(), intersections.end());
        for (std::size_t pair = 0; pair + 1 < intersections.size(); pair += 2) {
            const auto first = static_cast<std::int32_t>(
                std::ceil(intersections[pair] * width - 0.5F));
            const auto last = static_cast<std::int32_t>(
                std::floor(intersections[pair + 1] * width - 0.5F));
            const auto begin = std::max(0, first);
            const auto end = std::min(static_cast<std::int32_t>(width) - 1, last);
            for (auto column = begin; column <= end; ++column) {
                mask[static_cast<std::size_t>(row) * width + column] = 1.0F;
            }
        }
    }

    if (output.maskSoftness > 0) {
        constexpr float infinity = std::numeric_limits<float>::infinity();
        constexpr float diagonal = 1.41421356237F;
        std::vector<float> distance(mask.size(), infinity);
        for (std::size_t index = 0; index < mask.size(); ++index) {
            if (mask[index] == 0) distance[index] = 0;
        }
        const auto relax = [&](const std::int32_t x, const std::int32_t y,
                               const std::int32_t nx, const std::int32_t ny,
                               const float cost) {
            if (nx < 0 || ny < 0 || nx >= static_cast<std::int32_t>(width) ||
                ny >= static_cast<std::int32_t>(height)) return;
            auto& value = distance[static_cast<std::size_t>(y) * width + x];
            value = std::min(value, distance[static_cast<std::size_t>(ny) * width + nx] + cost);
        };
        for (std::int32_t y = 0; y < static_cast<std::int32_t>(height); ++y) {
            for (std::int32_t x = 0; x < static_cast<std::int32_t>(width); ++x) {
                if (mask[static_cast<std::size_t>(y) * width + x] == 0) continue;
                relax(x, y, x - 1, y, 1); relax(x, y, x, y - 1, 1);
                relax(x, y, x - 1, y - 1, diagonal); relax(x, y, x + 1, y - 1, diagonal);
            }
        }
        for (std::int32_t y = static_cast<std::int32_t>(height) - 1; y >= 0; --y) {
            for (std::int32_t x = static_cast<std::int32_t>(width) - 1; x >= 0; --x) {
                if (mask[static_cast<std::size_t>(y) * width + x] == 0) continue;
                relax(x, y, x + 1, y, 1); relax(x, y, x, y + 1, 1);
                relax(x, y, x + 1, y + 1, diagonal); relax(x, y, x - 1, y + 1, diagonal);
            }
        }
        const auto softnessPixels = std::max(1.0F, output.maskSoftness * std::min(width, height));
        for (std::size_t index = 0; index < mask.size(); ++index) {
            mask[index] = mask[index] == 0 ? 0.0F : std::min(1.0F, distance[index] / softnessPixels);
        }
    }
    auto view = CreateScalarTexture2D(device, width, height, mask);
    digest = VectorSha256(mask);
    return view;
}

ComPtr<ID3D11ShaderResourceView> CreateTexture2D(ID3D11Device* device,
                                                 const RawTexture2DConfig& asset,
                                                 const bool unitRange,
                                                 std::string& digest) {
    const auto components = asset.format == RawTexture2DConfig::Format::r32Float ? 1U
                            : asset.format == RawTexture2DConfig::Format::rg32Float ? 2U : 4U;
    const auto count = static_cast<std::size_t>(asset.width) * asset.height * components;
    const auto loaded = ReadFloats(asset.path, count, unitRange);
    D3D11_TEXTURE2D_DESC description{};
    description.Width = asset.width;
    description.Height = asset.height;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = components == 1 ? DXGI_FORMAT_R32_FLOAT
                         : components == 2 ? DXGI_FORMAT_R32G32_FLOAT
                                           : DXGI_FORMAT_R32G32B32A32_FLOAT;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_IMMUTABLE;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{};
    initial.pSysMem = loaded.values.data();
    initial.SysMemPitch = asset.width * components * sizeof(float);
    ComPtr<ID3D11Texture2D> texture;
    ThrowIfFailed(device->CreateTexture2D(&description, &initial, texture.ReleaseAndGetAddressOf()),
                  "Create correction texture");
    ComPtr<ID3D11ShaderResourceView> view;
    ThrowIfFailed(device->CreateShaderResourceView(texture.Get(), nullptr, view.ReleaseAndGetAddressOf()),
                  "Create correction texture view");
    digest = loaded.sha256;
    return view;
}

ComPtr<ID3D11ShaderResourceView> CreateScalarTexture(ID3D11Device* device, const float value,
                                                     std::string& digest) {
    D3D11_TEXTURE2D_DESC description{};
    description.Width = 1;
    description.Height = 1;
    description.MipLevels = 1;
    description.ArraySize = 1;
    description.Format = DXGI_FORMAT_R32_FLOAT;
    description.SampleDesc.Count = 1;
    description.Usage = D3D11_USAGE_IMMUTABLE;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{&value, sizeof(float), 0};
    ComPtr<ID3D11Texture2D> texture;
    ThrowIfFailed(device->CreateTexture2D(&description, &initial, texture.ReleaseAndGetAddressOf()),
                  "Create scalar correction texture");
    ComPtr<ID3D11ShaderResourceView> view;
    ThrowIfFailed(device->CreateShaderResourceView(texture.Get(), nullptr, view.ReleaseAndGetAddressOf()),
                  "Create scalar correction texture view");
    digest = Sha256Hex(std::as_bytes(std::span(&value, 1)));
    return view;
}

ComPtr<ID3D11ShaderResourceView> CreateLut(ID3D11Device* device, const RawLut3DConfig& asset,
                                          std::string& digest) {
    const auto texels = static_cast<std::size_t>(asset.size) * asset.size * asset.size;
    const auto loaded = ReadFloats(asset.path, texels * 4, false);
    D3D11_TEXTURE3D_DESC description{};
    description.Width = asset.size;
    description.Height = asset.size;
    description.Depth = asset.size;
    description.MipLevels = 1;
    description.Format = DXGI_FORMAT_R32G32B32A32_FLOAT;
    description.Usage = D3D11_USAGE_IMMUTABLE;
    description.BindFlags = D3D11_BIND_SHADER_RESOURCE;
    D3D11_SUBRESOURCE_DATA initial{};
    initial.pSysMem = loaded.values.data();
    initial.SysMemPitch = asset.size * 4 * sizeof(float);
    initial.SysMemSlicePitch = asset.size * asset.size * 4 * sizeof(float);
    ComPtr<ID3D11Texture3D> texture;
    ThrowIfFailed(device->CreateTexture3D(&description, &initial, texture.ReleaseAndGetAddressOf()),
                  "Create color LUT texture");
    ComPtr<ID3D11ShaderResourceView> view;
    ThrowIfFailed(device->CreateShaderResourceView(texture.Get(), nullptr, view.ReleaseAndGetAddressOf()),
                  "Create color LUT view");
    digest = loaded.sha256;
    return view;
}

} // namespace

void FinalPipeline::Initialize(ID3D11Device* device, const std::filesystem::path& shaderDirectory,
                               const OutputConfig& output) {
    static_assert(sizeof(Constants) == 144, "OutputConstants C++ ABI changed; update final_ps.hlsl and ShaderTests");
    const auto vertexBytecode = CompileShader(shaderDirectory / L"fullscreen_vs.hlsl", "vs_5_0");
    const auto pixelBytecode = CompileShader(shaderDirectory / L"final_ps.hlsl", "ps_5_0");
    ThrowIfFailed(device->CreateVertexShader(vertexBytecode->GetBufferPointer(), vertexBytecode->GetBufferSize(),
                                             nullptr, vertexShader_.ReleaseAndGetAddressOf()),
                  "Create final vertex shader");
    ThrowIfFailed(device->CreatePixelShader(pixelBytecode->GetBufferPointer(), pixelBytecode->GetBufferSize(),
                                            nullptr, pixelShader_.ReleaseAndGetAddressOf()),
                  "Create final pixel shader");
    constexpr std::array<D3D11_INPUT_ELEMENT_DESC, 2> elements{{
        {"POSITION", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 0, D3D11_INPUT_PER_VERTEX_DATA, 0},
        {"TEXCOORD", 0, DXGI_FORMAT_R32G32_FLOAT, 0, 8, D3D11_INPUT_PER_VERTEX_DATA, 0},
    }};
    ThrowIfFailed(device->CreateInputLayout(elements.data(), static_cast<UINT>(elements.size()),
                                             vertexBytecode->GetBufferPointer(), vertexBytecode->GetBufferSize(),
                                             inputLayout_.ReleaseAndGetAddressOf()),
                  "Create warp mesh input layout");

    const auto columns = output.warp.enabled ? output.warp.columns : 1U;
    const auto rows = output.warp.enabled ? output.warp.rows : 1U;
    std::vector<MeshVertex> vertices;
    vertices.reserve(static_cast<std::size_t>(columns + 1) * (rows + 1));
    for (std::uint32_t row = 0; row <= rows; ++row) {
        for (std::uint32_t column = 0; column <= columns; ++column) {
            const auto index = static_cast<std::size_t>(row) * (columns + 1) + column;
            const auto point = output.warp.enabled
                                   ? output.warp.points.at(index)
                                   : WarpPointConfig{static_cast<float>(column), static_cast<float>(row),
                                                     static_cast<float>(column), static_cast<float>(row)};
            vertices.push_back({{point.x, point.y},
                                {output.warp.enabled ? point.u : static_cast<float>(column) / columns,
                                 output.warp.enabled ? point.v : static_cast<float>(row) / rows}});
        }
    }
    std::vector<std::uint32_t> indices;
    indices.reserve(static_cast<std::size_t>(columns) * rows * 6);
    for (std::uint32_t row = 0; row < rows; ++row) {
        for (std::uint32_t column = 0; column < columns; ++column) {
            const auto topLeft = row * (columns + 1) + column;
            const auto topRight = topLeft + 1;
            const auto bottomLeft = topLeft + columns + 1;
            const auto bottomRight = bottomLeft + 1;
            indices.insert(indices.end(), {topLeft, topRight, bottomLeft,
                                            topRight, bottomRight, bottomLeft});
        }
    }
    indexCount_ = static_cast<std::uint32_t>(indices.size());
    D3D11_BUFFER_DESC vertexDescription{};
    vertexDescription.ByteWidth = static_cast<UINT>(vertices.size() * sizeof(MeshVertex));
    vertexDescription.Usage = D3D11_USAGE_IMMUTABLE;
    vertexDescription.BindFlags = D3D11_BIND_VERTEX_BUFFER;
    D3D11_SUBRESOURCE_DATA vertexData{vertices.data(), 0, 0};
    ThrowIfFailed(device->CreateBuffer(&vertexDescription, &vertexData, vertices_.ReleaseAndGetAddressOf()),
                  "Create warp mesh vertex buffer");
    D3D11_BUFFER_DESC indexDescription{};
    indexDescription.ByteWidth = static_cast<UINT>(indices.size() * sizeof(std::uint32_t));
    indexDescription.Usage = D3D11_USAGE_IMMUTABLE;
    indexDescription.BindFlags = D3D11_BIND_INDEX_BUFFER;
    D3D11_SUBRESOURCE_DATA indexData{indices.data(), 0, 0};
    ThrowIfFailed(device->CreateBuffer(&indexDescription, &indexData, indices_.ReleaseAndGetAddressOf()),
                  "Create warp mesh index buffer");
    const nlohmann::json meshEvidence{
        {"columns", columns},
        {"rows", rows},
        {"verticesSha256", VectorSha256(vertices)},
        {"indicesSha256", VectorSha256(indices)},
    };
    correctionBinding_ = {};
    correctionBinding_.warpMeshSha256 = Sha256Hex(meshEvidence.dump());

    D3D11_SAMPLER_DESC samplerDescription{};
    samplerDescription.Filter = D3D11_FILTER_MIN_MAG_MIP_LINEAR;
    samplerDescription.AddressU = D3D11_TEXTURE_ADDRESS_CLAMP;
    samplerDescription.AddressV = D3D11_TEXTURE_ADDRESS_CLAMP;
    samplerDescription.AddressW = D3D11_TEXTURE_ADDRESS_CLAMP;
    samplerDescription.MaxLOD = D3D11_FLOAT32_MAX;
    ThrowIfFailed(device->CreateSamplerState(&samplerDescription, sampler_.ReleaseAndGetAddressOf()),
                  "Create final sampler");
    D3D11_BUFFER_DESC constantDescription{};
    constantDescription.ByteWidth = sizeof(Constants);
    constantDescription.Usage = D3D11_USAGE_DYNAMIC;
    constantDescription.BindFlags = D3D11_BIND_CONSTANT_BUFFER;
    constantDescription.CPUAccessFlags = D3D11_CPU_ACCESS_WRITE;
    ThrowIfFailed(device->CreateBuffer(&constantDescription, nullptr, constants_.ReleaseAndGetAddressOf()),
                  "Create output constant buffer");
}

void FinalPipeline::LoadCorrectionAssets(ID3D11Device* device, const OutputConfig& output,
                                         const std::filesystem::path&) {
    blackMap_.Reset();
    blendMap_.Reset();
    maskMap_.Reset();
    colorLut_.Reset();
    correctionBinding_.blendMapSha256.reset();
    correctionBinding_.blackMapSha256.reset();
    correctionBinding_.maskSha256.reset();
    correctionBinding_.colorLutSha256.reset();
    // Bypass is also a recovery path: a disabled correction must not prevent
    // an otherwise valid crop/mesh output from starting because its stale
    // asset is missing. Turning bypass off applies a new config and rebuilds
    // the surface, which validates and loads every enabled asset.
    if (output.processingBypass) return;
    if (output.blackMapEnabled) {
        std::string digest;
        blackMap_ = output.blackMap ? CreateTexture2D(device, *output.blackMap, true, digest)
                                    : CreateScalarTexture(device, output.blackLift, digest);
        correctionBinding_.blackMapSha256 = std::move(digest);
    }
    if (output.blendEnabled && output.blendMap) {
        std::string digest;
        blendMap_ = CreateTexture2D(device, *output.blendMap, true, digest);
        correctionBinding_.blendMapSha256 = std::move(digest);
    }
    if (output.maskEnabled) {
        std::string digest;
        maskMap_ = output.maskMap ? CreateTexture2D(device, *output.maskMap, true, digest)
                                  : RasterizePolygonMask(device, output, digest);
        correctionBinding_.maskSha256 = std::move(digest);
    }
    if (output.colorLut) {
        std::string digest;
        colorLut_ = CreateLut(device, *output.colorLut, digest);
        correctionBinding_.colorLutSha256 = std::move(digest);
    }
}

void FinalPipeline::Render(ID3D11DeviceContext* context, ID3D11RenderTargetView* target,
                           ID3D11ShaderResourceView* source, const bool sourceValid,
                           const OutputConfig& output, const CanvasConfig& canvas,
                           const bool sourceIsSrgb, const PatternConfig& pattern,
                           const bool blank) {
    constexpr float clear[4]{0, 0, 0, 1};
    context->ClearRenderTargetView(target, clear);
    Constants values{};
    values.sourceRect[0] = output.sourceViewport.x / canvas.width;
    values.sourceRect[1] = output.sourceViewport.y / canvas.height;
    values.sourceRect[2] = output.sourceViewport.width / canvas.width;
    values.sourceRect[3] = output.sourceViewport.height / canvas.height;
    values.overlapPixels[0] = output.overlap.left;
    values.overlapPixels[1] = output.overlap.right;
    values.overlapPixels[2] = output.overlap.top;
    values.overlapPixels[3] = output.overlap.bottom;
    values.outputSize[0] = static_cast<float>(output.resolution.width);
    values.outputSize[1] = static_cast<float>(output.resolution.height);
    values.blendFeather = output.blendFeather;
    values.blendGamma = output.blendGamma;
    values.lutSize = output.colorLut ? static_cast<float>(output.colorLut->size) : 2.0F;
    values.patternCellSize = static_cast<float>(pattern.cellSize);
    values.patternMode = static_cast<std::uint32_t>(pattern.mode);
    values.patternAxis = pattern.grayAxisY ? 1U : 0U;
    values.patternBit = pattern.grayBit;
    values.patternInverse = pattern.inverse ? 1U : 0U;
    std::copy(pattern.solidRgb.begin(), pattern.solidRgb.end(), values.solidRgb);
    // Calibration capture remains raw by default. Only an explicitly marked
    // solid verification frame may traverse the already-applied optical
    // correction stack; unsupported modes are forced through the bypass path.
    const auto correctionBypass = PatternCorrectionsBypassed(pattern, output.processingBypass);
    if (correctionBypass) {
        std::fill_n(values.gain, 3, 1.0F);
        std::fill_n(values.gamma, 3, 1.0F);
    } else {
        std::copy(output.gain.begin(), output.gain.end(), values.gain);
        std::copy(output.offset.begin(), output.offset.end(), values.offset);
        std::copy(output.gamma.begin(), output.gamma.end(), values.gamma);
    }
    if (sourceIsSrgb) values.flags |= 1U << 0;
    if (!correctionBypass && output.blendEnabled && !blendMap_) values.flags |= 1U << 1;
    if (!correctionBypass && blackMap_) values.flags |= 1U << 2;
    if (!correctionBypass && maskMap_) values.flags |= 1U << 3;
    if (!correctionBypass && colorLut_) values.flags |= 1U << 4;
    if (!correctionBypass && output.blendEnabled && blendMap_) values.flags |= 1U << 5;
    if (sourceValid && source) values.flags |= 1U << 6;
    if (blank) values.flags |= 1U << 7;
    if (!correctionBypass && output.blackMap &&
        output.blackMap->format == RawTexture2DConfig::Format::rgba32Float) {
        values.flags |= 1U << 8;
    }
    // Polygon masks are rasterized into a bounded texture that may be smaller
    // than a 4K/8K output. Linear sampling is still useful for deliberately
    // soft masks, but it would turn a zero-softness polygon edge into fractional
    // light outside the hard boundary. Tell the shader to restore a binary edge
    // only for the generated hard-polygon case; measured/soft map values retain
    // their existing linear interpolation.
    if (!correctionBypass && maskMap_ && output.maskEnabled && !output.maskMap &&
        output.maskSoftness == 0.0F) {
        values.flags |= 1U << 9;
    }

    D3D11_MAPPED_SUBRESOURCE mapped{};
    ThrowIfFailed(context->Map(constants_.Get(), 0, D3D11_MAP_WRITE_DISCARD, 0, &mapped),
                  "Map output constants");
    std::memcpy(mapped.pData, &values, sizeof(values));
    context->Unmap(constants_.Get(), 0);

    D3D11_VIEWPORT viewport{0, 0, static_cast<float>(output.resolution.width),
                            static_cast<float>(output.resolution.height), 0, 1};
    context->RSSetViewports(1, &viewport);
    context->OMSetRenderTargets(1, &target, nullptr);
    constexpr UINT stride = sizeof(MeshVertex);
    constexpr UINT offset = 0;
    auto* vertexBuffer = vertices_.Get();
    context->IASetInputLayout(inputLayout_.Get());
    context->IASetVertexBuffers(0, 1, &vertexBuffer, &stride, &offset);
    context->IASetIndexBuffer(indices_.Get(), DXGI_FORMAT_R32_UINT, 0);
    context->IASetPrimitiveTopology(D3D11_PRIMITIVE_TOPOLOGY_TRIANGLELIST);
    context->VSSetShader(vertexShader_.Get(), nullptr, 0);
    context->PSSetShader(pixelShader_.Get(), nullptr, 0);
    auto* constant = constants_.Get();
    auto* sampler = sampler_.Get();
    context->PSSetConstantBuffers(0, 1, &constant);
    context->PSSetSamplers(0, 1, &sampler);
    ID3D11ShaderResourceView* resources[5]{source, blackMap_.Get(), maskMap_.Get(), colorLut_.Get(), blendMap_.Get()};
    context->PSSetShaderResources(0, 5, resources);
    context->DrawIndexed(indexCount_, 0, 0);
    ID3D11ShaderResourceView* empty[5]{};
    context->PSSetShaderResources(0, 5, empty);
}

} // namespace pbwin

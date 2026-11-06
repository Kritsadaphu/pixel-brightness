#include "pbwin/Digest.hpp"

#include <Windows.h>
#include <bcrypt.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <format>
#include <stdexcept>
#include <vector>

namespace pbwin {
namespace {

void RequireSuccess(const NTSTATUS status, const char* operation) {
    if (status < 0) {
        throw std::runtime_error(std::format("{} failed with NTSTATUS 0x{:08X}", operation,
                                             static_cast<std::uint32_t>(status)));
    }
}

} // namespace

std::string Sha256Hex(const std::span<const std::byte> bytes) {
    BCRYPT_ALG_HANDLE algorithm{};
    BCRYPT_HASH_HANDLE hash{};
    try {
        RequireSuccess(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0),
                       "BCryptOpenAlgorithmProvider(SHA-256)");
        DWORD objectBytes{};
        DWORD hashBytes{};
        DWORD copied{};
        RequireSuccess(BCryptGetProperty(algorithm, BCRYPT_OBJECT_LENGTH,
                                         reinterpret_cast<PUCHAR>(&objectBytes), sizeof(objectBytes),
                                         &copied, 0),
                       "BCryptGetProperty(BCRYPT_OBJECT_LENGTH)");
        RequireSuccess(BCryptGetProperty(algorithm, BCRYPT_HASH_LENGTH,
                                         reinterpret_cast<PUCHAR>(&hashBytes), sizeof(hashBytes),
                                         &copied, 0),
                       "BCryptGetProperty(BCRYPT_HASH_LENGTH)");
        if (hashBytes != 32) throw std::runtime_error("Windows SHA-256 provider returned the wrong digest size");
        std::vector<UCHAR> object(objectBytes);
        RequireSuccess(BCryptCreateHash(algorithm, &hash, object.data(), objectBytes,
                                        nullptr, 0, 0),
                       "BCryptCreateHash(SHA-256)");
        constexpr std::size_t maximumChunk = 64ULL * 1024 * 1024;
        for (std::size_t offset = 0; offset < bytes.size();) {
            const auto count = std::min(maximumChunk, bytes.size() - offset);
            auto* data = const_cast<PUCHAR>(reinterpret_cast<const UCHAR*>(bytes.data() + offset));
            RequireSuccess(BCryptHashData(hash, data, static_cast<ULONG>(count), 0),
                           "BCryptHashData(SHA-256)");
            offset += count;
        }
        std::array<UCHAR, 32> digest{};
        RequireSuccess(BCryptFinishHash(hash, digest.data(), static_cast<ULONG>(digest.size()), 0),
                       "BCryptFinishHash(SHA-256)");
        BCryptDestroyHash(hash);
        hash = nullptr;
        BCryptCloseAlgorithmProvider(algorithm, 0);
        algorithm = nullptr;
        std::string result;
        result.reserve(digest.size() * 2);
        constexpr char alphabet[] = "0123456789abcdef";
        for (const auto value : digest) {
            result.push_back(alphabet[value >> 4]);
            result.push_back(alphabet[value & 0x0f]);
        }
        return result;
    } catch (...) {
        if (hash) BCryptDestroyHash(hash);
        if (algorithm) BCryptCloseAlgorithmProvider(algorithm, 0);
        throw;
    }
}

std::string Sha256Hex(const std::string_view text) {
    return Sha256Hex(std::as_bytes(std::span(text.data(), text.size())));
}

} // namespace pbwin

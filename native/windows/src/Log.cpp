#include "pbwin/Log.hpp"

#include <Windows.h>

#include <cstdio>
#include <vector>

namespace pbwin {

std::mutex Log::mutex_;
void* Log::file_ = INVALID_HANDLE_VALUE;

void Log::SetFile(const std::wstring& path) {
    std::scoped_lock lock(mutex_);
    auto next = CreateFileW(path.c_str(), FILE_APPEND_DATA, FILE_SHARE_READ, nullptr,
                            OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (next == INVALID_HANDLE_VALUE) {
        throw std::runtime_error("Unable to open log file: " + Narrow(path));
    }
    if (file_ != INVALID_HANDLE_VALUE) CloseHandle(static_cast<HANDLE>(file_));
    file_ = next;
}

void Log::Write(const LogLevel level, const std::string_view message) noexcept {
    try {
        SYSTEMTIME now{};
        GetLocalTime(&now);
        const char* levelName = "INFO";
        switch (level) {
        case LogLevel::debug: levelName = "DEBUG"; break;
        case LogLevel::info: levelName = "INFO"; break;
        case LogLevel::warning: levelName = "WARN"; break;
        case LogLevel::error: levelName = "ERROR"; break;
        }
        char prefix[64]{};
        std::snprintf(prefix, sizeof(prefix), "%04u-%02u-%02uT%02u:%02u:%02u.%03u [%s] ",
                      now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute,
                      now.wSecond, now.wMilliseconds, levelName);
        std::string line(prefix);
        line.append(message);
        line.push_back('\n');

        std::scoped_lock lock(mutex_);
        OutputDebugStringA(line.c_str());
        if (file_ != INVALID_HANDLE_VALUE) {
            DWORD written{};
            WriteFile(static_cast<HANDLE>(file_), line.data(),
                      static_cast<DWORD>(line.size()), &written, nullptr);
        }
    } catch (...) {
        OutputDebugStringA("Pixel Brightness logging failure\n");
    }
}

std::string Narrow(const std::wstring_view value) {
    if (value.empty()) return {};
    const auto bytes = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                                            static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (bytes <= 0) throw std::runtime_error("WideCharToMultiByte failed");
    std::string result(static_cast<std::size_t>(bytes), '\0');
    if (WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), result.data(), bytes,
                            nullptr, nullptr) != bytes) {
        throw std::runtime_error("WideCharToMultiByte failed");
    }
    return result;
}

std::wstring Widen(const std::string_view value) {
    if (value.empty()) return {};
    const auto characters = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                                                 static_cast<int>(value.size()), nullptr, 0);
    if (characters <= 0) throw std::runtime_error("Invalid UTF-8 text");
    std::wstring result(static_cast<std::size_t>(characters), L'\0');
    if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, value.data(),
                            static_cast<int>(value.size()), result.data(), characters) != characters) {
        throw std::runtime_error("MultiByteToWideChar failed");
    }
    return result;
}

std::string HResultMessage(const long result) {
    wchar_t* buffer{};
    const auto count = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER |
                                          FORMAT_MESSAGE_FROM_SYSTEM |
                                          FORMAT_MESSAGE_IGNORE_INSERTS,
                                      nullptr, static_cast<DWORD>(result), 0,
                                      reinterpret_cast<wchar_t*>(&buffer), 0, nullptr);
    std::string message = count && buffer ? Narrow({buffer, count}) : "unknown HRESULT";
    if (buffer) LocalFree(buffer);
    while (!message.empty() && (message.back() == '\r' || message.back() == '\n')) message.pop_back();
    return std::format("0x{:08X}: {}", static_cast<unsigned long>(result), message);
}

HResultError::HResultError(const long result, const std::string_view operation)
    : std::runtime_error(std::string(operation) + " failed (" + HResultMessage(result) + ")"),
      result_(result) {}

void ThrowIfFailed(const long result, const std::string_view operation) {
    if (result < 0) throw HResultError(result, operation);
}

} // namespace pbwin

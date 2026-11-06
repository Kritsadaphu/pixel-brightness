#pragma once

#include <format>
#include <mutex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace pbwin {

enum class LogLevel { debug, info, warning, error };

class Log final {
public:
    static void SetFile(const std::wstring& path);
    static void Write(LogLevel level, std::string_view message) noexcept;

    template <typename... Args>
    static void Debug(std::format_string<Args...> format, Args&&... args) {
        Write(LogLevel::debug, std::format(format, std::forward<Args>(args)...));
    }

    template <typename... Args>
    static void Info(std::format_string<Args...> format, Args&&... args) {
        Write(LogLevel::info, std::format(format, std::forward<Args>(args)...));
    }

    template <typename... Args>
    static void Warning(std::format_string<Args...> format, Args&&... args) {
        Write(LogLevel::warning, std::format(format, std::forward<Args>(args)...));
    }

    template <typename... Args>
    static void Error(std::format_string<Args...> format, Args&&... args) {
        Write(LogLevel::error, std::format(format, std::forward<Args>(args)...));
    }

private:
    static std::mutex mutex_;
    static void* file_;
};

std::string Narrow(std::wstring_view value);
std::wstring Widen(std::string_view value);
std::string HResultMessage(long result);

class HResultError final : public std::runtime_error {
public:
    HResultError(long result, std::string_view operation);
    [[nodiscard]] long Result() const noexcept { return result_; }

private:
    long result_;
};

void ThrowIfFailed(long result, std::string_view operation);

} // namespace pbwin

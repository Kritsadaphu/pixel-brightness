#pragma once

#include <nlohmann/json.hpp>

#include <stdexcept>
#include <string>
#include <string_view>

namespace pbcamera {

class HelperFailure final : public std::runtime_error {
public:
    HelperFailure(std::string code,
                  std::string message,
                  nlohmann::json details = nullptr,
                  bool retryable = false);

    [[nodiscard]] const std::string& Code() const noexcept { return code_; }
    [[nodiscard]] const nlohmann::json& Details() const noexcept { return details_; }
    [[nodiscard]] bool Retryable() const noexcept { return retryable_; }

private:
    std::string code_;
    nlohmann::json details_;
    bool retryable_{};
};

[[noreturn]] void Fail(std::string_view code,
                       std::string_view message,
                       nlohmann::json details = nullptr,
                       bool retryable = false);

class ICanonCameraProvider {
public:
    virtual ~ICanonCameraProvider() = default;

    virtual nlohmann::json Detect(const nlohmann::json& params) = 0;
    virtual nlohmann::json Open(const nlohmann::json& params) = 0;
    virtual nlohmann::json LockManualSettings(const nlohmann::json& params) = 0;
    virtual nlohmann::json Capture(const nlohmann::json& params,
                                   bool surveyPreview) = 0;
    virtual nlohmann::json Close() = 0;
};

} // namespace pbcamera

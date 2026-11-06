#pragma once

#include <nlohmann/json.hpp>

#include <string>
#include <string_view>

namespace pbcamera::contract {

inline constexpr std::string_view kCameraModel = "EOS R50";
inline constexpr std::string_view kLensModel = "RF-S10-18mm F4.5-6.3 IS STM";
inline constexpr std::string_view kSourceKind = "single-shot-linear-raw-decode-v1";
inline constexpr std::string_view kTransformKind = "full-frame-area-bin-v1";

void ExactKeys(const nlohmann::json& value,
               std::initializer_list<std::string_view> expected,
               std::string_view field);
std::string Text(const nlohmann::json& value,
                 std::string_view field,
                 std::size_t maximum = 256);
void ExpectedBoolean(const nlohmann::json& value,
                     bool expected,
                     std::string_view field,
                     std::string_view code = "CAMERA_HELPER_PROTOCOL_ERROR");
void Equal(const nlohmann::json& actual,
           const nlohmann::json& expected,
           std::string_view code,
           std::string_view message);

void ValidateRequestParams(const std::string& method,
                           const nlohmann::json& params);
void ValidateDetectionResult(const nlohmann::json& result);
void ValidateOpenResult(const nlohmann::json& result);
void ValidateLockResult(const nlohmann::json& result,
                        const nlohmann::json& requestedSettings,
                        const nlohmann::json& openedCamera,
                        const nlohmann::json& openedLens);
nlohmann::json ValidateCaptureResult(
    const nlohmann::json& result,
    bool surveyPreview,
    const nlohmann::json& openedCamera,
    const nlohmann::json& openedLens,
    const nlohmann::json& manualSettings,
    const nlohmann::json& sourcePolicy,
    const nlohmann::json& sdkProvenance,
    const std::string& helperVersion,
    const nlohmann::json& requestParams);

nlohmann::json CameraWithoutLens(nlohmann::json camera);

} // namespace pbcamera::contract

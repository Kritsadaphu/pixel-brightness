#include "pbcamera/Provider.hpp"

#include <utility>

namespace pbcamera {

HelperFailure::HelperFailure(std::string code,
                             std::string message,
                             nlohmann::json details,
                             const bool retryable)
    : std::runtime_error(std::move(message)),
      code_(std::move(code)),
      details_(std::move(details)),
      retryable_(retryable) {}

[[noreturn]] void Fail(const std::string_view code,
                       const std::string_view message,
                       nlohmann::json details,
                       const bool retryable) {
    throw HelperFailure(std::string(code), std::string(message),
                        std::move(details), retryable);
}

} // namespace pbcamera

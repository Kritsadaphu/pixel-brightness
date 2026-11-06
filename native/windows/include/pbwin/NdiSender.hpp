#pragma once

#include "pbwin/NetworkVideoFrame.hpp"
#include <memory>
#include <string>

namespace pbwin {

// All SDK objects in this process hold a lease, including receivers. Worker
// failure or shutdown must not destroy the runtime under another SDK object.
class NdiRuntimeLease final {
public:
    NdiRuntimeLease();
    ~NdiRuntimeLease();
    NdiRuntimeLease(const NdiRuntimeLease&) = delete;
    NdiRuntimeLease& operator=(const NdiRuntimeLease&) = delete;
};

struct NdiSourceIdentity {
    std::string name;
    std::string address;
};

// Optional SDK-backed transport; not linked into the installed DXGI renderer.
// Construct, Send and destroy on a dedicated transport thread/process. Sending
// is synchronous so frame storage is never reused while the SDK owns it.
class NdiSender final {
public:
    explicit NdiSender(const std::string& sourceName);
    ~NdiSender();
    NdiSender(const NdiSender&) = delete;
    NdiSender& operator=(const NdiSender&) = delete;
    void Send(const NetworkVideoFrame& frame);
    [[nodiscard]] std::uint64_t SubmissionCalls() const noexcept;
    // Discovery connections are not proof that a Magewell displayed the frame.
    [[nodiscard]] int ConnectionCount() const;
    [[nodiscard]] NdiSourceIdentity SourceIdentity() const;
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

} // namespace pbwin

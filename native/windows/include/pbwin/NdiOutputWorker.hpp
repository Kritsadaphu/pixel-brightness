#pragma once
#include "pbwin/NdiSender.hpp"
#include <atomic>
#include <condition_variable>
#include <exception>
#include <future>
#include <mutex>
#include <optional>
#include <thread>

namespace pbwin {
// One owning SDK thread per output, at most one queued frame plus one in flight.
// Slow encoding replaces queued frames instead of stalling the D3D owner.
// A blocked SDK is still bounded by the parent process's heartbeat supervision;
// no thread is detached and no physical black/scanout guarantee is claimed.
class NdiOutputWorker final {
public:
    explicit NdiOutputWorker(const std::string& name);
    ~NdiOutputWorker();
    NdiOutputWorker(const NdiOutputWorker&) = delete;
    NdiOutputWorker& operator=(const NdiOutputWorker&) = delete;
    void Send(NetworkVideoFrame frame);
    std::vector<std::uint8_t> TakeRecycledBuffer();
    void DiscardPending();
    void Stop(NetworkVideoFrame black);
    NdiSourceIdentity SourceIdentity() const { return identity_; }
    int ConnectionCount() const { Check(); return connections_.load(); }
    std::uint64_t SubmissionCalls() const { Check(); return sent_.load(); }
    std::uint64_t ReplacedFrames() const { return replaced_.load(); }
private:
    void Run(std::string name, std::promise<NdiSourceIdentity> ready) noexcept;
    void Check() const;
    mutable std::mutex mutex_;
    std::condition_variable wake_;
    std::optional<NetworkVideoFrame> pending_, stopping_;
    // Only a completed synchronous SDK send (or a never-sent replaced frame)
    // may donate memory. One retained buffer, never an unbounded frame pool.
    std::vector<std::uint8_t> recycled_;
    std::exception_ptr failure_;
    bool closed_{};
    NdiSourceIdentity identity_;
    std::atomic<int> connections_{};
    std::atomic<std::uint64_t> sent_{}, replaced_{};
    std::atomic<bool> blackSubmitted_{};
    std::jthread thread_;
};
}

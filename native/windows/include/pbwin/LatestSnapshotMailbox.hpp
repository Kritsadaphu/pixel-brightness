#pragma once

#include <condition_variable>
#include <cstddef>
#include <memory>
#include <mutex>
#include <optional>
#include <utility>

namespace pbwin {

// A latest-value, single-consumer handoff. The producer never waits for the
// consumer or for storage I/O: if the tiny coordination mutex is busy it drops
// the new value, and if a value is already queued it replaces that stale value.
// Values are immutable and the queue owns at most one shared pointer.
template <typename T>
class LatestSnapshotMailbox final {
public:
    static constexpr std::size_t kCapacity = 1;

    enum class PublishResult {
        accepted,
        coalesced,
        contended,
        closed,
    };

    using Value = std::shared_ptr<const T>;

    [[nodiscard]] PublishResult TryPublish(Value value) noexcept {
        if (!value) return PublishResult::closed;
        std::unique_lock lock(mutex_, std::try_to_lock);
        if (!lock.owns_lock()) return PublishResult::contended;
        if (closed_) return PublishResult::closed;
        const auto result = pending_ ? PublishResult::coalesced
                                     : PublishResult::accepted;
        pending_ = std::move(value);
        lock.unlock();
        ready_.notify_one();
        return result;
    }

    // Returns null only after CloseAndDiscard() and once no value remains.
    // The consumer owns the returned immutable value before the lock releases.
    [[nodiscard]] Value WaitTake() {
        std::unique_lock lock(mutex_);
        ready_.wait(lock, [&] { return closed_ || pending_.has_value(); });
        if (!pending_) return {};
        auto value = std::move(*pending_);
        pending_.reset();
        return value;
    }

    // Shutdown is not a render-path operation, so it may take the coordination
    // mutex. Pending persistence is deliberately discarded: shutdown has a
    // deadline and must not turn a stale telemetry sample into an exit barrier.
    [[nodiscard]] bool CloseAndDiscard() noexcept {
        bool discarded{};
        {
            std::scoped_lock lock(mutex_);
            if (closed_) return false;
            closed_ = true;
            discarded = pending_.has_value();
            pending_.reset();
        }
        ready_.notify_all();
        return discarded;
    }

    // Status readers also never wait behind the consumer. A null result means
    // the coordination mutex was momentarily busy, not that the queue is empty.
    [[nodiscard]] std::optional<std::size_t> TryDepth() const noexcept {
        std::unique_lock lock(mutex_, std::try_to_lock);
        if (!lock.owns_lock()) return std::nullopt;
        return pending_ ? 1U : 0U;
    }

private:
    mutable std::mutex mutex_;
    std::condition_variable ready_;
    std::optional<Value> pending_;
    bool closed_{};
};

} // namespace pbwin

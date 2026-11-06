#pragma once

#include "pbwin/LatestSnapshotMailbox.hpp"

#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <filesystem>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>

namespace pbwin {

class TelemetryPersistence final {
public:
    static constexpr std::size_t kMaximumSerializedBytes = 1024ULL * 1024;
    static constexpr std::uint32_t kShutdownDrainDeadlineMs = 750;
    static constexpr std::uint32_t kShutdownCancelGraceMs = 750;
    static constexpr std::uint32_t kWriterStallWarningMs = 5000;

    TelemetryPersistence();
    ~TelemetryPersistence();
    TelemetryPersistence(const TelemetryPersistence&) = delete;
    TelemetryPersistence& operator=(const TelemetryPersistence&) = delete;

    void Configure(bool enabled);
    [[nodiscard]] bool TryPublish(
        const std::filesystem::path& path,
        std::shared_ptr<const nlohmann::json> snapshot) noexcept;
    [[nodiscard]] bool TryPublishAndWait(
        const std::filesystem::path& path,
        std::shared_ptr<const nlohmann::json> snapshot,
        std::chrono::milliseconds timeout) noexcept;
    [[nodiscard]] nlohmann::json StatusJson() const;
    void Shutdown(
        std::chrono::milliseconds drainDeadline =
            std::chrono::milliseconds(kShutdownDrainDeadlineMs)) noexcept;

private:
    struct Job;
    struct Completion;

    [[nodiscard]] std::optional<std::uint64_t> TryEnqueue(
        const std::filesystem::path& path,
        std::shared_ptr<const nlohmann::json> snapshot) noexcept;
    void WriterRun() noexcept;
    void Process(const Job& job) noexcept;
    void RecordSuccess(const Job& job) noexcept;
    void RecordFailure(const Job& job, std::string error) noexcept;
    void RecordCancelled(const Job& job, bool staleGeneration) noexcept;
    [[nodiscard]] bool JobIsCurrent(const Job& job) const noexcept;
    void CancelActiveIo() noexcept;

    LatestSnapshotMailbox<Job> mailbox_;
    std::thread writerThread_;
    std::atomic<std::shared_ptr<const Completion>> completion_;
    std::atomic_uint64_t configGeneration_{1};
    std::atomic_uint64_t nextSequence_{1};
    std::atomic_uint64_t latestPublishedSequence_{};
    std::atomic_uint64_t publishedSnapshots_{};
    std::atomic_uint64_t coalescedSnapshots_{};
    std::atomic_uint64_t contentionDrops_{};
    std::atomic_uint64_t allocationDrops_{};
    std::atomic_uint64_t allocationDropGeneration_{};
    std::atomic_uint64_t staleGenerationDrops_{};
    std::atomic_uint64_t shutdownDrops_{};
    std::atomic_uint64_t oversizeDrops_{};
    std::atomic_uint64_t writeAttempts_{};
    std::atomic_uint64_t writeSuccesses_{};
    std::atomic_uint64_t writeFailures_{};
    std::atomic_uint64_t cancelledWrites_{};
    std::atomic_uint64_t diagnosticStateFailures_{};
    std::atomic_uint64_t diagnosticFailureGeneration_{};
    std::atomic_uint64_t shutdownCancelRequests_{};
    std::atomic_int64_t latestPublishedSteadyMilliseconds_{};
    std::atomic_int64_t inFlightStartedSteadyMilliseconds_{};
    std::atomic_uint64_t inFlightSequence_{};
    std::atomic_bool enabled_{};
    std::atomic_bool inFlight_{};
    std::atomic_bool stopRequested_{};
    std::atomic_bool shutdownStarted_{};
    std::atomic_bool writerBackgroundMode_{};
    std::atomic_bool writerFatal_{};
    std::atomic_bool writerPriorityReduced_{};
    std::atomic_bool writerDone_{};
    mutable std::mutex activeFileMutex_;
    void* activeFile_{};
    mutable std::mutex doneMutex_;
    std::condition_variable doneReady_;
};

} // namespace pbwin

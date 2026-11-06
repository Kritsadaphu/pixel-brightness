#include "pbwin/TelemetryPersistence.hpp"

#include <Windows.h>

#include <algorithm>
#include <format>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>

namespace pbwin {
namespace {

constexpr std::size_t kMaximumErrorCharacters = 512;
constexpr DWORD kWriteChunkBytes = 64U * 1024U;

std::int64_t SteadyMilliseconds() noexcept {
    return std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch())
        .count();
}

std::string UtcTimestamp() {
    SYSTEMTIME value{};
    GetSystemTime(&value);
    return std::format("{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
                       value.wYear, value.wMonth, value.wDay, value.wHour,
                       value.wMinute, value.wSecond, value.wMilliseconds);
}

std::string Win32Error(const std::string_view operation) {
    return std::format("{} failed (win32Error={})", operation, GetLastError());
}

std::string BoundedError(std::string error) {
    if (error.size() > kMaximumErrorCharacters) {
        error.resize(kMaximumErrorCharacters);
    }
    return error;
}

class TemporaryFile final {
public:
    explicit TemporaryFile(std::filesystem::path path) : path_(std::move(path)) {}
    ~TemporaryFile() {
        if (owned_) DeleteFileW(path_.c_str());
    }
    TemporaryFile(const TemporaryFile&) = delete;
    TemporaryFile& operator=(const TemporaryFile&) = delete;
    [[nodiscard]] const std::filesystem::path& Path() const noexcept { return path_; }
    void Release() noexcept { owned_ = false; }

private:
    std::filesystem::path path_;
    bool owned_{true};
};

} // namespace

struct TelemetryPersistence::Job final {
    std::uint64_t sequence{};
    std::uint64_t configGeneration{};
    std::filesystem::path path;
    std::shared_ptr<const nlohmann::json> snapshot;
};

struct TelemetryPersistence::Completion final {
    enum class Outcome {
        none,
        success,
        failure,
    };

    std::uint64_t configGeneration{};
    std::uint64_t sequence{};
    Outcome outcome{Outcome::none};
    std::string completedAt;
    std::string error;
    std::int64_t completedSteadyMilliseconds{};
    std::int64_t successSteadyMilliseconds{};
    std::string successAt;
};

TelemetryPersistence::TelemetryPersistence() {
    auto initial = std::make_shared<Completion>();
    initial->configGeneration = configGeneration_.load();
    completion_.store(std::move(initial));
    writerThread_ = std::thread([this] { WriterRun(); });
}

TelemetryPersistence::~TelemetryPersistence() { Shutdown(); }

void TelemetryPersistence::Configure(const bool enabled) {
    if (shutdownStarted_.load()) {
        throw std::runtime_error("Telemetry persistence is already shutting down");
    }
    auto reset = std::make_shared<Completion>();
    const auto generation = configGeneration_.load() + 1;
    reset->configGeneration = generation;
    configGeneration_.store(generation);
    enabled_.store(enabled);
    completion_.store(std::move(reset));
}

bool TelemetryPersistence::TryPublish(
    const std::filesystem::path& path,
    std::shared_ptr<const nlohmann::json> snapshot) noexcept {
    return TryEnqueue(path, std::move(snapshot)).has_value();
}

std::optional<std::uint64_t> TelemetryPersistence::TryEnqueue(
    const std::filesystem::path& path,
    std::shared_ptr<const nlohmann::json> snapshot) noexcept {
    if (!snapshot || path.empty() || !enabled_.load() ||
        shutdownStarted_.load()) {
        return std::nullopt;
    }

    try {
        auto job = std::make_shared<Job>();
        const auto sequence = nextSequence_.fetch_add(1);
        job->sequence = sequence;
        job->configGeneration = configGeneration_.load();
        job->path = path;
        job->snapshot = std::move(snapshot);

        const auto result = mailbox_.TryPublish(std::move(job));
        using Result = LatestSnapshotMailbox<Job>::PublishResult;
        if (result == Result::contended) {
            contentionDrops_.fetch_add(1);
            return std::nullopt;
        }
        if (result == Result::closed) {
            shutdownDrops_.fetch_add(1);
            return std::nullopt;
        }
        if (result == Result::coalesced) coalescedSnapshots_.fetch_add(1);
        publishedSnapshots_.fetch_add(1);
        latestPublishedSequence_.store(sequence);
        latestPublishedSteadyMilliseconds_.store(SteadyMilliseconds());
        return sequence;
    } catch (...) {
        allocationDrops_.fetch_add(1);
        allocationDropGeneration_.store(configGeneration_.load());
        return std::nullopt;
    }
}

bool TelemetryPersistence::TryPublishAndWait(
    const std::filesystem::path& path,
    std::shared_ptr<const nlohmann::json> snapshot,
    const std::chrono::milliseconds timeout) noexcept {
    const auto sequence = TryEnqueue(path, std::move(snapshot));
    if (!sequence) return false;
    try {
        const auto generation = configGeneration_.load();
        const auto completed = [&] {
            const auto value = completion_.load();
            return writerFatal_.load() || writerDone_.load() ||
                   (value && value->configGeneration == generation &&
                    value->sequence >= *sequence &&
                    value->outcome != Completion::Outcome::none);
        };
        std::unique_lock lock(doneMutex_);
        if (!doneReady_.wait_for(lock, timeout, completed)) return false;
        const auto value = completion_.load();
        return value && value->configGeneration == generation &&
               value->sequence >= *sequence &&
               value->outcome == Completion::Outcome::success;
    } catch (...) {
        return false;
    }
}

nlohmann::json TelemetryPersistence::StatusJson() const {
    const auto completion = completion_.load();
    const auto currentGeneration = configGeneration_.load();
    const auto completionCurrent = completion &&
                                   completion->configGeneration == currentGeneration;
    const auto diagnosticUnavailable =
        diagnosticFailureGeneration_.load() == currentGeneration;
    const auto now = SteadyMilliseconds();
    const auto inFlightStarted = inFlightStartedSteadyMilliseconds_.load();
    const auto stalled = inFlight_.load() && inFlightStarted > 0 &&
                         now - inFlightStarted >
                             static_cast<std::int64_t>(kWriterStallWarningMs);

    std::string health;
    if (writerFatal_.load()) {
        health = "failed";
    } else if (writerDone_.load()) {
        health = "stopped";
    } else if (shutdownStarted_.load()) {
        health = "stopping";
    } else if (!enabled_.load()) {
        health = "disabled";
    } else if (stalled) {
        health = "stalled";
    } else if (diagnosticUnavailable) {
        health = "unknown";
    } else if (completionCurrent &&
               completion->outcome == Completion::Outcome::failure) {
        health = "degraded";
    } else if ((!completionCurrent ||
                completion->outcome == Completion::Outcome::none) &&
               allocationDropGeneration_.load() == currentGeneration) {
        health = "degraded";
    } else if (!completionCurrent ||
               completion->outcome == Completion::Outcome::none) {
        health = "starting";
    } else {
        health = "healthy";
    }

    nlohmann::json lastSuccessAge = nullptr;
    nlohmann::json lastCompletedAge = nullptr;
    nlohmann::json lastSuccessAt = nullptr;
    nlohmann::json lastCompletedAt = nullptr;
    nlohmann::json lastError = nullptr;
    const auto lastCompletedSequence = completionCurrent ? completion->sequence : 0;
    const auto completionDetailAvailable = completionCurrent &&
        completion->outcome != Completion::Outcome::none && !diagnosticUnavailable;
    if (completionCurrent) {
        if (completionDetailAvailable && !completion->completedAt.empty()) {
            lastCompletedAt = completion->completedAt;
        }
        if (completionDetailAvailable && completion->completedSteadyMilliseconds > 0) {
            lastCompletedAge = static_cast<std::uint64_t>(
                std::max<std::int64_t>(0, now - completion->completedSteadyMilliseconds));
        }
        if (completionDetailAvailable &&
            completion->outcome == Completion::Outcome::failure &&
            !completion->error.empty()) {
            lastError = completion->error;
        }
        if (!completion->successAt.empty()) lastSuccessAt = completion->successAt;
        if (completion->successSteadyMilliseconds > 0) {
            lastSuccessAge = static_cast<std::uint64_t>(
                std::max<std::int64_t>(0, now - completion->successSteadyMilliseconds));
        }
    }

    const auto coalesced = coalescedSnapshots_.load();
    const auto contention = contentionDrops_.load();
    const auto allocation = allocationDrops_.load();
    const auto stale = staleGenerationDrops_.load();
    const auto shutdown = shutdownDrops_.load();
    const auto oversize = oversizeDrops_.load();
    const auto latestPublishedAt = latestPublishedSteadyMilliseconds_.load();
    const auto latestPublishAge = latestPublishedAt > 0
                                      ? nlohmann::json(static_cast<std::uint64_t>(
                                            std::max<std::int64_t>(0, now - latestPublishedAt)))
                                      : nlohmann::json(nullptr);
    const auto queueDepth = mailbox_.TryDepth();
    if (writerFatal_.load()) {
        lastError = "telemetry writer synchronization failed";
    }
    return {
        {"mode", "async-latest-only"},
        {"counterScope", "process-lifetime"},
        {"health", health},
        {"enabled", enabled_.load()},
        {"configGeneration", currentGeneration},
        {"queueCapacity", LatestSnapshotMailbox<Job>::kCapacity},
        {"queueDepth", queueDepth ? nlohmann::json(*queueDepth)
                                    : nlohmann::json(nullptr)},
        {"queueDepthKnown", queueDepth.has_value()},
        {"inFlight", inFlight_.load()},
        {"inFlightSequence", inFlight_.load()
                                 ? nlohmann::json(inFlightSequence_.load())
                                 : nlohmann::json(nullptr)},
        {"backgroundIoScheduling", writerBackgroundMode_.load()},
        {"priorityReduced", writerPriorityReduced_.load()},
        {"writerFatal", writerFatal_.load()},
        {"writerStalled", stalled},
        {"writerStallWarningMilliseconds", kWriterStallWarningMs},
        {"maximumSerializedBytes", kMaximumSerializedBytes},
        {"publishedSnapshots", publishedSnapshots_.load()},
        {"latestPublishedSequence", latestPublishedSequence_.load()},
        {"latestPublishAgeMilliseconds", latestPublishAge},
        {"lastCompletedSequence", lastCompletedSequence},
        {"completionDetailAvailable", completionDetailAvailable},
        {"diagnosticStateFailures", diagnosticStateFailures_.load()},
        {"lastCompletedAt", std::move(lastCompletedAt)},
        {"lastCompletedAgeMilliseconds", std::move(lastCompletedAge)},
        {"lastSuccessAt", std::move(lastSuccessAt)},
        {"lastSuccessAgeMilliseconds", std::move(lastSuccessAge)},
        {"lastError", std::move(lastError)},
        {"writeAttempts", writeAttempts_.load()},
        {"writeSuccesses", writeSuccesses_.load()},
        {"writeFailures", writeFailures_.load()},
        {"cancelledWrites", cancelledWrites_.load()},
        {"drops", {
            {"total", coalesced + contention + allocation + stale + shutdown + oversize},
            {"coalescedStale", coalesced},
            {"producerContention", contention},
            {"producerAllocation", allocation},
            {"staleConfiguration", stale},
            {"shutdown", shutdown},
            {"oversize", oversize},
        }},
        {"shutdown", {
            {"drainDeadlineMilliseconds", kShutdownDrainDeadlineMs},
            {"cancelGraceMilliseconds", kShutdownCancelGraceMs},
            {"cancelRequests", shutdownCancelRequests_.load()},
            {"complete", writerDone_.load()},
        }},
        {"statusSemantics",
         "in-memory latest completed attempt; persisted payload does not claim its own write"},
    };
}

void TelemetryPersistence::Shutdown(
    const std::chrono::milliseconds drainDeadline) noexcept {
    if (shutdownStarted_.exchange(true)) return;
    enabled_.store(false);
    stopRequested_.store(true);
    if (mailbox_.CloseAndDiscard()) shutdownDrops_.fetch_add(1);

    if (!writerThread_.joinable()) return;
    bool completed{};
    {
        std::unique_lock lock(doneMutex_);
        completed = doneReady_.wait_for(lock, drainDeadline,
                                        [&] { return writerDone_.load(); });
    }
    if (!completed) {
        shutdownCancelRequests_.fetch_add(1);
        CancelActiveIo();
        CancelSynchronousIo(writerThread_.native_handle());
        std::unique_lock lock(doneMutex_);
        (void)doneReady_.wait_for(
            lock, std::chrono::milliseconds(kShutdownCancelGraceMs),
            [&] { return writerDone_.load(); });
    }
    // Never detach: the worker owns references to this object. Cancellation is
    // requested at the bounded deadline; joining is the use-after-free barrier.
    writerThread_.join();
}

void TelemetryPersistence::WriterRun() noexcept {
    const auto background =
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN) != FALSE;
    writerBackgroundMode_.store(background);
    writerPriorityReduced_.store(
        background || SetThreadPriority(GetCurrentThread(),
                                        THREAD_PRIORITY_BELOW_NORMAL) != FALSE);
    try {
        while (const auto job = mailbox_.WaitTake()) {
            Process(*job);
        }
    } catch (...) {
        writerFatal_.store(true);
    }
    if (background) {
        (void)SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_END);
    }
    inFlight_.store(false);
    writerDone_.store(true);
    doneReady_.notify_all();
}

void TelemetryPersistence::Process(const Job& job) noexcept {
    if (!JobIsCurrent(job)) {
        RecordCancelled(job, !stopRequested_.load());
        return;
    }
    inFlightSequence_.store(job.sequence);
    inFlightStartedSteadyMilliseconds_.store(SteadyMilliseconds());
    inFlight_.store(true);
    writeAttempts_.fetch_add(1);

    try {
        auto payload = *job.snapshot;
        auto persistence = StatusJson();
        persistence["payloadSequence"] = job.sequence;
        persistence["statusCaptured"] = "before-this-write-completed";
        const auto completed = completion_.load();
        persistence["completedThroughSequence"] =
            completed && completed->configGeneration == job.configGeneration
                ? completed->sequence
                : 0;
        payload["telemetryPersistence"] = std::move(persistence);
        auto text = payload.dump(2);
        text.push_back('\n');
        if (text.size() > kMaximumSerializedBytes) {
            oversizeDrops_.fetch_add(1);
            throw std::runtime_error(std::format(
                "serialized telemetry is {} bytes; maximum is {}",
                text.size(), kMaximumSerializedBytes));
        }
        if (!JobIsCurrent(job)) {
            RecordCancelled(job, !stopRequested_.load());
            return;
        }

        if (job.path.has_parent_path()) {
            std::error_code directoryError;
            std::filesystem::create_directories(job.path.parent_path(), directoryError);
            if (directoryError) {
                throw std::runtime_error("create telemetry directory failed: " +
                                         directoryError.message());
            }
        }
        auto temporaryPath = job.path;
        temporaryPath += std::format(L".tmp.{}.{}", GetCurrentProcessId(), job.sequence);
        TemporaryFile temporary(std::move(temporaryPath));
        const auto file = CreateFileW(
            temporary.Path().c_str(), GENERIC_WRITE, FILE_SHARE_READ,
            nullptr, CREATE_ALWAYS,
            FILE_ATTRIBUTE_TEMPORARY | FILE_FLAG_SEQUENTIAL_SCAN |
                FILE_FLAG_WRITE_THROUGH,
            nullptr);
        if (file == INVALID_HANDLE_VALUE) throw std::runtime_error(Win32Error("CreateFileW"));
        {
            std::scoped_lock lock(activeFileMutex_);
            activeFile_ = file;
        }

        bool fileClosed{};
        const auto closeFile = [&] {
            std::scoped_lock lock(activeFileMutex_);
            if (!fileClosed) {
                activeFile_ = nullptr;
                CloseHandle(file);
                fileClosed = true;
            }
        };
        try {
            std::size_t offset{};
            while (offset < text.size()) {
                if (!JobIsCurrent(job)) {
                    closeFile();
                    RecordCancelled(job, !stopRequested_.load());
                    return;
                }
                const auto remaining = text.size() - offset;
                const auto requested = static_cast<DWORD>(
                    std::min<std::size_t>(remaining, kWriteChunkBytes));
                DWORD written{};
                if (!WriteFile(file, text.data() + offset, requested, &written, nullptr) ||
                    written == 0) {
                    throw std::runtime_error(Win32Error("WriteFile"));
                }
                offset += written;
            }
            if (!FlushFileBuffers(file)) {
                throw std::runtime_error(Win32Error("FlushFileBuffers"));
            }
            closeFile();
        } catch (...) {
            closeFile();
            throw;
        }

        if (!JobIsCurrent(job)) {
            RecordCancelled(job, !stopRequested_.load());
            return;
        }
        if (!MoveFileExW(temporary.Path().c_str(), job.path.c_str(),
                         MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            throw std::runtime_error(Win32Error("MoveFileExW"));
        }
        temporary.Release();
        RecordSuccess(job);
    } catch (const std::exception& error) {
        if (!JobIsCurrent(job)) RecordCancelled(job, !stopRequested_.load());
        else RecordFailure(job, error.what());
    } catch (...) {
        if (!JobIsCurrent(job)) RecordCancelled(job, !stopRequested_.load());
        else RecordFailure(job, "unknown telemetry persistence failure");
    }
}

void TelemetryPersistence::RecordSuccess(const Job& job) noexcept {
    writeSuccesses_.fetch_add(1);
    const auto succeededAt = SteadyMilliseconds();
    if (!JobIsCurrent(job)) {
        if (stopRequested_.load()) shutdownDrops_.fetch_add(1);
        else staleGenerationDrops_.fetch_add(1);
        inFlight_.store(false);
        return;
    }
    try {
        auto next = std::make_shared<Completion>();
        next->configGeneration = job.configGeneration;
        next->sequence = job.sequence;
        next->outcome = Completion::Outcome::success;
        next->completedAt = UtcTimestamp();
        next->successAt = next->completedAt;
        next->completedSteadyMilliseconds = succeededAt;
        next->successSteadyMilliseconds = succeededAt;
        if (job.configGeneration == configGeneration_.load()) {
            completion_.store(std::move(next));
            diagnosticFailureGeneration_.store(0);
        }
    } catch (...) {
        // The durable write succeeded. Allocation failure while publishing its
        // diagnostic state must not relabel or retry that completed write.
        diagnosticStateFailures_.fetch_add(1);
        diagnosticFailureGeneration_.store(job.configGeneration);
    }
    inFlight_.store(false);
    doneReady_.notify_all();
}

void TelemetryPersistence::RecordFailure(const Job& job, std::string error) noexcept {
    writeFailures_.fetch_add(1);
    try {
        const auto previous = completion_.load();
        auto next = std::make_shared<Completion>();
        next->configGeneration = job.configGeneration;
        next->sequence = job.sequence;
        next->outcome = Completion::Outcome::failure;
        next->completedAt = UtcTimestamp();
        next->completedSteadyMilliseconds = SteadyMilliseconds();
        next->error = BoundedError(std::move(error));
        if (previous && previous->configGeneration == job.configGeneration) {
            next->successAt = previous->successAt;
            next->successSteadyMilliseconds = previous->successSteadyMilliseconds;
        }
        if (job.configGeneration == configGeneration_.load()) {
            completion_.store(std::move(next));
            diagnosticFailureGeneration_.store(0);
        }
    } catch (...) {
        diagnosticStateFailures_.fetch_add(1);
        diagnosticFailureGeneration_.store(job.configGeneration);
    }
    inFlight_.store(false);
    doneReady_.notify_all();
}

void TelemetryPersistence::RecordCancelled(
    const Job&, const bool staleGeneration) noexcept {
    cancelledWrites_.fetch_add(1);
    if (staleGeneration) staleGenerationDrops_.fetch_add(1);
    else shutdownDrops_.fetch_add(1);
    inFlight_.store(false);
    doneReady_.notify_all();
}

bool TelemetryPersistence::JobIsCurrent(const Job& job) const noexcept {
    return !stopRequested_.load() && enabled_.load() &&
           job.configGeneration == configGeneration_.load();
}

void TelemetryPersistence::CancelActiveIo() noexcept {
    std::scoped_lock lock(activeFileMutex_);
    if (activeFile_) CancelIoEx(static_cast<HANDLE>(activeFile_), nullptr);
}

} // namespace pbwin

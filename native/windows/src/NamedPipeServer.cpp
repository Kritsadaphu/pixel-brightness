#include "pbwin/NamedPipeServer.hpp"

#include "pbwin/Log.hpp"

#include <Sddl.h>

#include <algorithm>
#include <array>
#include <format>
#include <limits>
#include <new>
#include <stdexcept>
#include <string_view>
#include <utility>
#include <vector>

namespace pbwin {

class PipeConnectionCreationError final : public std::runtime_error {
public:
    PipeConnectionCreationError(const DWORD value, const char* message)
        : std::runtime_error(message), win32Error(value) {}

    DWORD win32Error{};
};

struct PipeConnection final {
    PipeConnection(const std::uint64_t value, const HANDLE pipeHandle)
        : id(value), pipe(pipeHandle) {
        abortEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!abortEvent) {
            throw PipeConnectionCreationError(
                GetLastError(), "Create named-pipe abort event failed");
        }
        terminalWrittenEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
        if (!terminalWrittenEvent) {
            const auto error = GetLastError();
            CloseHandle(abortEvent);
            abortEvent = nullptr;
            throw PipeConnectionCreationError(
                error, "Create named-pipe terminal-write event failed");
        }
    }

    ~PipeConnection() {
        const auto handle = pipe.exchange(INVALID_HANDLE_VALUE);
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        if (abortEvent) CloseHandle(abortEvent);
        if (terminalWrittenEvent) CloseHandle(terminalWrittenEvent);
    }

    PipeConnection(const PipeConnection&) = delete;
    PipeConnection& operator=(const PipeConnection&) = delete;

    [[nodiscard]] HANDLE Handle() const noexcept { return pipe.load(); }

    void RequestDisconnect() noexcept {
        disconnectRequested.store(true);
        if (abortEvent) SetEvent(abortEvent);
    }

    void MarkTerminalWritten() noexcept {
        if (terminalWrittenEvent) SetEvent(terminalWrittenEvent);
    }

    bool BeginWrite() noexcept {
        std::scoped_lock lock(writeStateMutex);
        if (closing || disconnectRequested.load() || writeActive) return false;
        writeActive = true;
        return true;
    }

    void EndWrite() noexcept {
        {
            std::scoped_lock lock(writeStateMutex);
            writeActive = false;
        }
        writeStateChanged.notify_all();
    }

    void CloseAfterIo() noexcept {
        RequestDisconnect();
        connected.store(false);
        HANDLE handle{INVALID_HANDLE_VALUE};
        {
            std::unique_lock lock(writeStateMutex);
            closing = true;
            writeStateChanged.wait(lock, [&] { return !writeActive; });
            handle = pipe.exchange(INVALID_HANDLE_VALUE);
        }
        if (handle != INVALID_HANDLE_VALUE) {
            DisconnectNamedPipe(handle);
            CloseHandle(handle);
        }
    }

    std::uint64_t id{};
    std::atomic<HANDLE> pipe{INVALID_HANDLE_VALUE};
    HANDLE abortEvent{};
    HANDLE terminalWrittenEvent{};
    std::atomic_bool connected{};
    std::atomic_bool disconnectRequested{};
    std::atomic_bool terminalCloseQueued{};
    std::mutex writeStateMutex;
    std::condition_variable writeStateChanged;
    bool writeActive{};
    bool closing{};
};

namespace {

class PipeSecurity final {
public:
    PipeSecurity() = default;
    ~PipeSecurity() {
        if (descriptor_) LocalFree(descriptor_);
    }

    PipeSecurity(const PipeSecurity&) = delete;
    PipeSecurity& operator=(const PipeSecurity&) = delete;

    [[nodiscard]] bool Initialize(DWORD& error) noexcept {
        HANDLE token{};
        if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) {
            error = GetLastError();
            return false;
        }

        DWORD required{};
        (void)GetTokenInformation(token, TokenUser, nullptr, 0, &required);
        if (required == 0 || GetLastError() != ERROR_INSUFFICIENT_BUFFER) {
            error = GetLastError();
            CloseHandle(token);
            return false;
        }

        try {
            tokenUser_.resize(required);
        } catch (...) {
            error = ERROR_NOT_ENOUGH_MEMORY;
            CloseHandle(token);
            return false;
        }
        if (!GetTokenInformation(token, TokenUser, tokenUser_.data(), required,
                                 &required)) {
            error = GetLastError();
            CloseHandle(token);
            return false;
        }
        CloseHandle(token);

        LPWSTR userSid{};
        const auto tokenUser = reinterpret_cast<const TOKEN_USER*>(tokenUser_.data());
        if (!ConvertSidToStringSidW(tokenUser->User.Sid, &userSid)) {
            error = GetLastError();
            return false;
        }
        try {
            // Protected DACL: only the renderer/Node launch identity and LocalSystem.
            // PIPE_REJECT_REMOTE_CLIENTS remains an independent transport boundary.
            const std::wstring sddl =
                L"D:P(A;;GA;;;SY)(A;;GA;;;" + std::wstring(userSid) + L")";
            LocalFree(userSid);
            userSid = nullptr;
            if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(
                    sddl.c_str(), SDDL_REVISION_1, &descriptor_, nullptr)) {
                error = GetLastError();
                return false;
            }
        } catch (...) {
            if (userSid) LocalFree(userSid);
            error = ERROR_NOT_ENOUGH_MEMORY;
            return false;
        }

        attributes_.nLength = sizeof(attributes_);
        attributes_.lpSecurityDescriptor = descriptor_;
        attributes_.bInheritHandle = FALSE;
        error = ERROR_SUCCESS;
        return true;
    }

    [[nodiscard]] SECURITY_ATTRIBUTES* Attributes() noexcept {
        return &attributes_;
    }

private:
    std::vector<std::byte> tokenUser_;
    PSECURITY_DESCRIPTOR descriptor_{};
    SECURITY_ATTRIBUTES attributes_{};
};

enum class ReadChunkOutcome {
    data,
    closed,
    deadlineExpired,
};

DWORD RemainingDeadlineMilliseconds(
    std::chrono::steady_clock::time_point deadline) noexcept;

void CancelAndDrain(const HANDLE pipe, OVERLAPPED& overlapped) noexcept {
    CancelIoEx(pipe, &overlapped);
    WaitForSingleObject(overlapped.hEvent, INFINITE);
    DWORD ignored{};
    GetOverlappedResult(pipe, &overlapped, &ignored, FALSE);
}

ReadChunkOutcome ReadChunk(
    const std::shared_ptr<PipeConnection>& connection,
    char* destination,
    const DWORD capacity,
    DWORD& read,
    const std::chrono::steady_clock::time_point deadline) noexcept {
    read = 0;
    const auto timeout = RemainingDeadlineMilliseconds(deadline);
    if (timeout == 0) return ReadChunkOutcome::deadlineExpired;
    OVERLAPPED overlapped{};
    overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!overlapped.hEvent) return ReadChunkOutcome::closed;
    const auto pipe = connection->Handle();
    const auto started = ReadFile(pipe, destination, capacity, nullptr, &overlapped) != FALSE;
    const auto error = started ? ERROR_SUCCESS : GetLastError();
    if (started) {
        const auto completed = GetOverlappedResult(
            pipe, &overlapped, &read, FALSE) != FALSE;
        CloseHandle(overlapped.hEvent);
        return completed && read != 0 ? ReadChunkOutcome::data
                                      : ReadChunkOutcome::closed;
    }
    if (!started && error != ERROR_IO_PENDING) {
        CloseHandle(overlapped.hEvent);
        return ReadChunkOutcome::closed;
    }
    const HANDLE waits[]{overlapped.hEvent, connection->abortEvent};
    const auto wait = WaitForMultipleObjects(2, waits, FALSE, timeout);
    if (wait == WAIT_TIMEOUT) {
        CancelAndDrain(pipe, overlapped);
        CloseHandle(overlapped.hEvent);
        return ReadChunkOutcome::deadlineExpired;
    }
    if (wait != WAIT_OBJECT_0) {
        CancelAndDrain(pipe, overlapped);
        CloseHandle(overlapped.hEvent);
        return ReadChunkOutcome::closed;
    }
    const auto completed = GetOverlappedResult(pipe, &overlapped, &read, FALSE) != FALSE;
    CloseHandle(overlapped.hEvent);
    return completed && read != 0 ? ReadChunkOutcome::data
                                  : ReadChunkOutcome::closed;
}

DWORD RemainingDeadlineMilliseconds(
    const std::chrono::steady_clock::time_point deadline) noexcept {
    const auto now = std::chrono::steady_clock::now();
    if (now >= deadline) return 0;
    const auto remaining = std::chrono::ceil<std::chrono::milliseconds>(deadline - now).count();
    return static_cast<DWORD>(std::clamp<std::int64_t>(
        remaining, 1, static_cast<std::int64_t>(INFINITE - 1)));
}

std::uint64_t SteadyMilliseconds() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

} // namespace

NamedPipeServer::~NamedPipeServer() { Stop(); }

void NamedPipeServer::Start(std::wstring pipeName) {
    Stop();
    constexpr std::wstring_view prefix = L"\\\\.\\pipe\\";
    if (!pipeName.starts_with(prefix) || pipeName.size() == prefix.size() || pipeName.size() > 256) {
        throw std::runtime_error("Invalid local named-pipe path");
    }
    pipeName_ = std::move(pipeName);
    listenerFatal_.store(false, std::memory_order_release);
#if !defined(PB_NAMED_PIPE_FAULT_INJECTION)
    firstMessageDeadlineMs_.store(kFirstMessageDeadlineMs);
    framingIdleDeadlineMs_.store(kFramingIdleDeadlineMs);
    terminalDisconnectDeadlineMs_.store(kTerminalDisconnectDeadlineMs);
#endif
    {
        std::scoped_lock lock(listenerHealthMutex_);
        listenerRecovery_.Start();
    }
    try {
        writerThread_ = std::jthread([this](const std::stop_token stopToken) {
            WriterRun(stopToken);
        });
        readerThread_ = std::jthread([this](const std::stop_token stopToken) {
            ReaderRun(stopToken);
        });
    } catch (...) {
        Stop();
        throw;
    }
}

void NamedPipeServer::Stop() noexcept {
    if (readerThread_.joinable()) readerThread_.request_stop();
    if (writerThread_.joinable()) writerThread_.request_stop();
    if (const auto connection = connection_.load()) connection->RequestDisconnect();
    outboundReady_.notify_all();
    listenerRetryReady_.notify_all();
    if (readerThread_.joinable()) readerThread_.join();
    if (writerThread_.joinable()) writerThread_.join();
    connection_.store(nullptr);
    {
        std::scoped_lock lock(requestsMutex_);
        requests_.clear();
        queuedBytes_ = 0;
    }
    {
        std::scoped_lock lock(outboundMutex_);
        outbound_.clear();
        outboundCount_ = 0;
        outboundBytes_ = 0;
    }
    {
        std::scoped_lock lock(listenerHealthMutex_);
        listenerRecovery_.Stop();
    }
}

PipeListenerRecoverySnapshot NamedPipeServer::ListenerHealth() const {
    std::scoped_lock lock(listenerHealthMutex_);
    auto snapshot = listenerRecovery_.Snapshot(SteadyMilliseconds());
    if (listenerFatal_.load(std::memory_order_acquire)) {
        snapshot.phase = PipeListenerPhase::fatal;
        snapshot.healthy = false;
        snapshot.degraded = true;
        snapshot.fatal = true;
    }
    return snapshot;
}

#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
void NamedPipeServer::SetListenerFaultPlanForTesting(
    const NamedPipeListenerFaultPlan plan) noexcept {
    injectedCreatePipeFailures_.store(plan.createPipeFailures);
    injectedConnectionStateFailures_.store(plan.connectionStateFailures);
    injectedConnectEventFailures_.store(plan.connectEventFailures);
}

void NamedPipeServer::SetClientDeadlinesForTesting(
    const std::uint32_t firstMessageMilliseconds,
    const std::uint32_t framingIdleMilliseconds,
    const std::uint32_t terminalDisconnectMilliseconds) noexcept {
    firstMessageDeadlineMs_.store(std::max<std::uint32_t>(
        firstMessageMilliseconds, 1));
    framingIdleDeadlineMs_.store(std::max<std::uint32_t>(
        framingIdleMilliseconds, 1));
    terminalDisconnectDeadlineMs_.store(std::max<std::uint32_t>(
        terminalDisconnectMilliseconds, 1));
}

bool NamedPipeServer::ConsumeInjectedFailure(
    std::atomic_uint32_t& remaining) noexcept {
    auto value = remaining.load();
    while (value != 0) {
        if (remaining.compare_exchange_weak(value, value - 1)) return true;
    }
    return false;
}
#endif

std::optional<IpcRequest> NamedPipeServer::TryPop() {
    std::scoped_lock lock(requestsMutex_);
    if (requests_.empty()) return std::nullopt;
    auto request = std::move(requests_.front());
    requests_.pop_front();
    queuedBytes_ -= std::min(queuedBytes_, request.wireBytes);
    return request;
}

void NamedPipeServer::ReaderRun(const std::stop_token stopToken) {
    while (!stopToken.stop_requested()) {
        HANDLE handle{INVALID_HANDLE_VALUE};
        DWORD createError{};
        PipeSecurity pipeSecurity;
        bool createAllowed{true};
        std::string_view createFailure = "CreateNamedPipeW failed";
#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
        if (ConsumeInjectedFailure(injectedCreatePipeFailures_)) {
            createError = ERROR_NOT_ENOUGH_MEMORY;
            createAllowed = false;
        }
#endif
        if (createAllowed && !pipeSecurity.Initialize(createError)) {
            // Security setup is part of creating an externally reachable
            // listener. Never fall back to the process default DACL.
            createAllowed = false;
            createFailure = "Named-pipe restrictive ACL setup failed";
        }
        if (createAllowed) {
            handle = CreateNamedPipeW(
                pipeName_.c_str(), PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED,
                PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                1, 64 * 1024, 64 * 1024, 0, pipeSecurity.Attributes());
            if (handle == INVALID_HANDLE_VALUE) createError = GetLastError();
        }
        if (handle == INVALID_HANDLE_VALUE) {
            if (!HandleListenerFailure(
                    PipeListenerFailureStage::createPipe, createError,
                    createFailure,
                    stopToken)) {
                return;
            }
            continue;
        }

        std::shared_ptr<PipeConnection> connection;
        try {
#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
            if (ConsumeInjectedFailure(injectedConnectionStateFailures_)) {
                throw std::bad_alloc();
            }
#endif
            connection = std::make_shared<PipeConnection>(
                nextConnectionId_.fetch_add(1), handle);
        } catch (const PipeConnectionCreationError& error) {
            CloseHandle(handle);
            if (!HandleListenerFailure(
                    PipeListenerFailureStage::connectionState, error.win32Error,
                    error.what(),
                    stopToken)) {
                return;
            }
            continue;
        } catch (const std::bad_alloc&) {
            CloseHandle(handle);
            if (!HandleListenerFailure(
                    PipeListenerFailureStage::connectionState,
                    ERROR_NOT_ENOUGH_MEMORY,
                    "PipeConnection allocation failed",
                    stopToken)) {
                return;
            }
            continue;
        } catch (const std::exception& error) {
            CloseHandle(handle);
            if (!HandleListenerFailure(
                    PipeListenerFailureStage::connectionState,
                    ERROR_GEN_FAILURE,
                    error.what(),
                    stopToken)) {
                return;
            }
            continue;
        } catch (...) {
            CloseHandle(handle);
            if (!HandleListenerFailure(
                    PipeListenerFailureStage::connectionState,
                    ERROR_GEN_FAILURE,
                    "PipeConnection creation failed with an unknown exception",
                    stopToken)) {
                return;
            }
            continue;
        }
        connection_.store(connection);
        if (stopToken.stop_requested()) connection->RequestDisconnect();

        const auto connectAttempt = WaitForConnect(connection);
        const auto connected = connectAttempt.outcome == ConnectOutcome::connected;
        if (connected) {
            connection->connected.store(true);
            MarkListenerConnected();
            Log::Info("Renderer controller connected to {}", Narrow(pipeName_));
            std::string pending;
            std::array<char, 16 * 1024> chunk{};
            auto readDeadline = std::chrono::steady_clock::now() +
                std::chrono::milliseconds(firstMessageDeadlineMs_.load());
            while (!stopToken.stop_requested() && !connection->disconnectRequested.load()) {
                DWORD read{};
                const auto readOutcome = ReadChunk(
                    connection, chunk.data(), static_cast<DWORD>(chunk.size()),
                    read, readDeadline);
                if (readOutcome == ReadChunkOutcome::deadlineExpired) {
                    const auto partialFrame = !pending.empty();
                    const auto queued = EnqueueEnvelope(
                        {{"schemaVersion", 1}, {"requestId", ""}, {"type", "error"},
                         {"ok", false},
                         {"error", {{"code", partialFrame ? "FRAMING_TIMEOUT"
                                                           : "FIRST_MESSAGE_TIMEOUT"},
                                    {"message", partialFrame
                                        ? "NDJSON frame was not completed before the framing idle deadline"
                                        : "First NDJSON message was not received before the deadline"}}}},
                        connection->id, true);
                    if (queued) AwaitTerminalClose(connection);
                    else connection->RequestDisconnect();
                    break;
                }
                if (readOutcome != ReadChunkOutcome::data) break;
                pending.append(chunk.data(), read);
                if (pending.size() > kMaximumMessageBytes &&
                    pending.find('\n') == std::string::npos) {
                    const auto queued = EnqueueEnvelope(
                        {{"schemaVersion", 1}, {"requestId", ""}, {"type", "error"},
                         {"ok", false},
                         {"error", {{"code", "MESSAGE_TOO_LARGE"},
                                    {"message", "NDJSON message exceeds 64 MiB"}}}},
                        connection->id, true);
                    if (queued) AwaitTerminalClose(connection);
                    else connection->RequestDisconnect();
                    break;
                }
                bool receivedFrame{};
                std::size_t newline{};
                while ((newline = pending.find('\n')) != std::string::npos) {
                    auto line = pending.substr(0, newline);
                    pending.erase(0, newline + 1);
                    if (!line.empty() && line.back() == '\r') line.pop_back();
                    if (line.empty()) continue;
                    receivedFrame = true;
                    if (line.size() > kMaximumMessageBytes) {
                        const auto queued = EnqueueEnvelope(
                            {{"schemaVersion", 1}, {"requestId", ""}, {"type", "error"},
                             {"ok", false},
                             {"error", {{"code", "MESSAGE_TOO_LARGE"},
                                        {"message", "NDJSON message exceeds 64 MiB"}}}},
                            connection->id, true);
                        if (!queued) connection->RequestDisconnect();
                    } else {
                        ProcessLine(line, connection->id);
                    }
                    break;
                }
                if (receivedFrame) {
                    // Exactly one request is accepted per connection. Events
                    // already ahead of its terminal result/error retain FIFO
                    // order; release begins only after that envelope is written.
                    AwaitTerminalClose(connection);
                    break;
                }
                if (!pending.empty()) {
                    readDeadline = std::chrono::steady_clock::now() +
                        std::chrono::milliseconds(framingIdleDeadlineMs_.load());
                }
            }
        }

        auto expected = connection;
        connection_.compare_exchange_strong(expected, nullptr);
        connection->RequestDisconnect();
        connection->CloseAfterIo();
        PurgeConnection(connection->id);
        if (connected) {
            Log::Info("Renderer controller disconnected");
            MarkListenerDisconnected();
            continue;
        }
        if (connectAttempt.outcome == ConnectOutcome::stopped ||
            stopToken.stop_requested()) {
            return;
        }
        if (!HandleListenerFailure(
                connectAttempt.failureStage, connectAttempt.win32Error,
                "Named-pipe connection setup failed",
                stopToken)) {
            return;
        }
    }
}

void NamedPipeServer::AwaitTerminalClose(
    const std::shared_ptr<PipeConnection>& connection) noexcept {
    const HANDLE terminalWaits[]{
        connection->terminalWrittenEvent,
        connection->abortEvent,
    };
    if (WaitForMultipleObjects(2, terminalWaits, FALSE, INFINITE) !=
        WAIT_OBJECT_0) {
        return;
    }

    // DisconnectNamedPipe discards unread bytes. Once the terminal write has
    // completed, observe the protocol client closing its end after it reads the
    // envelope. A client that neither reads nor closes is still released at a
    // hard deadline; extra pipelined input is ignored until that deadline.
    const auto deadline = std::chrono::steady_clock::now() +
        std::chrono::milliseconds(terminalDisconnectDeadlineMs_.load());
    std::array<char, 1024> ignored{};
    while (!connection->disconnectRequested.load()) {
        DWORD read{};
        const auto outcome = ReadChunk(
            connection, ignored.data(), static_cast<DWORD>(ignored.size()),
            read, deadline);
        if (outcome == ReadChunkOutcome::data) continue;
        if (outcome == ReadChunkOutcome::deadlineExpired) {
            connection->RequestDisconnect();
        }
        return;
    }
}

NamedPipeServer::ConnectAttempt NamedPipeServer::WaitForConnect(
    const std::shared_ptr<PipeConnection>& connection) noexcept {
#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
    if (ConsumeInjectedFailure(injectedConnectEventFailures_)) {
        return {ConnectOutcome::failed, PipeListenerFailureStage::connectEvent,
                ERROR_NOT_ENOUGH_MEMORY};
    }
#endif
    OVERLAPPED overlapped{};
    overlapped.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!overlapped.hEvent) {
        return {ConnectOutcome::failed, PipeListenerFailureStage::connectEvent,
                GetLastError()};
    }
    const auto pipe = connection->Handle();
    const auto started = ConnectNamedPipe(pipe, &overlapped) != FALSE;
    const auto error = started ? ERROR_SUCCESS : GetLastError();
    if (started || error == ERROR_PIPE_CONNECTED) {
        MarkListenerListening();
        CloseHandle(overlapped.hEvent);
        return {ConnectOutcome::connected, PipeListenerFailureStage::none,
                ERROR_SUCCESS};
    }
    if (error != ERROR_IO_PENDING) {
        CloseHandle(overlapped.hEvent);
        return {ConnectOutcome::failed, PipeListenerFailureStage::connectStart, error};
    }

    // At this point the listener is genuinely armed. Retain any consecutive
    // setup-failure count until a controller connects, but expose availability
    // while this OVERLAPPED accept is pending.
    MarkListenerListening();
    const HANDLE waits[]{overlapped.hEvent, connection->abortEvent};
    const auto wait = WaitForMultipleObjects(2, waits, FALSE, INFINITE);
    if (wait != WAIT_OBJECT_0) {
        const auto waitError = wait == WAIT_FAILED ? GetLastError() : ERROR_OPERATION_ABORTED;
        CancelAndDrain(pipe, overlapped);
        CloseHandle(overlapped.hEvent);
        if (connection->disconnectRequested.load()) {
            return {ConnectOutcome::stopped, PipeListenerFailureStage::none,
                    ERROR_OPERATION_ABORTED};
        }
        return {ConnectOutcome::failed, PipeListenerFailureStage::connectWait,
                waitError};
    }
    DWORD transferred{};
    if (!GetOverlappedResult(pipe, &overlapped, &transferred, FALSE)) {
        const auto completionError = GetLastError();
        CloseHandle(overlapped.hEvent);
        if (completionError == ERROR_OPERATION_ABORTED &&
            connection->disconnectRequested.load()) {
            return {ConnectOutcome::stopped, PipeListenerFailureStage::none,
                    completionError};
        }
        return {ConnectOutcome::failed, PipeListenerFailureStage::connectComplete,
                completionError};
    }
    CloseHandle(overlapped.hEvent);
    return {ConnectOutcome::connected, PipeListenerFailureStage::none,
            ERROR_SUCCESS};
}

bool NamedPipeServer::HandleListenerFailure(
    const PipeListenerFailureStage stage,
    const DWORD win32Error,
    const std::string_view detail,
    const std::stop_token stopToken) noexcept {
    if (stopToken.stop_requested()) return false;
    try {
        PipeListenerRecoverySnapshot snapshot;
        {
            std::scoped_lock lock(listenerHealthMutex_);
            listenerRecovery_.Fail(
                stage, win32Error,
                std::format("{} at {} (win32Error={})", detail,
                            PipeListenerFailureStageName(stage), win32Error),
                                   SteadyMilliseconds());
            snapshot = listenerRecovery_.Snapshot(SteadyMilliseconds());
        }
        if (snapshot.fatal) {
            listenerFatal_.store(true, std::memory_order_release);
            Log::Error(
                "Named-pipe listener exhausted setup retries at {} after {}/{} failures: {}",
                PipeListenerFailureStageName(snapshot.lastFailureStage),
                snapshot.consecutiveFailures, snapshot.maximumFailures,
                snapshot.lastError);
            return false;
        }

        const auto delay = snapshot.retryInMilliseconds.value_or(
            PipeListenerRecoveryPolicy::kMaximumRetryDelayMs);
        Log::Warning(
            "Named-pipe listener setup failed at {} ({}/{}); retrying in {} ms: {}",
            PipeListenerFailureStageName(snapshot.lastFailureStage),
            snapshot.consecutiveFailures, snapshot.maximumFailures, delay,
            snapshot.lastError);
        std::unique_lock lock(listenerRetryMutex_);
        (void)listenerRetryReady_.wait_for(
            lock, stopToken, std::chrono::milliseconds(delay), [] { return false; });
        return !stopToken.stop_requested();
    } catch (...) {
        // If even the bounded diagnostic state cannot be allocated, continuing
        // would silently leave the renderer without a command/safety channel.
        listenerFatal_.store(true, std::memory_order_release);
        Log::Write(LogLevel::error,
                   "Named-pipe listener recovery bookkeeping failed; forcing fatal state");
        return false;
    }
}

void NamedPipeServer::MarkListenerListening() noexcept {
    try {
        std::scoped_lock lock(listenerHealthMutex_);
        listenerRecovery_.MarkListening();
    } catch (...) {
        listenerFatal_.store(true, std::memory_order_release);
    }
}

void NamedPipeServer::MarkListenerConnected() noexcept {
    try {
        std::scoped_lock lock(listenerHealthMutex_);
        listenerRecovery_.MarkConnected();
    } catch (...) {
        listenerFatal_.store(true, std::memory_order_release);
    }
}

void NamedPipeServer::MarkListenerDisconnected() noexcept {
    try {
        std::scoped_lock lock(listenerHealthMutex_);
        listenerRecovery_.MarkDisconnected();
    } catch (...) {
        listenerFatal_.store(true, std::memory_order_release);
    }
}

void NamedPipeServer::WriterRun(const std::stop_token stopToken) {
    while (true) {
        OutboundMessage message;
        {
            std::unique_lock lock(outboundMutex_);
            outboundReady_.wait(lock, [&] {
                return stopToken.stop_requested() || !outbound_.empty();
            });
            if (stopToken.stop_requested()) {
                outbound_.clear();
                outboundCount_ = 0;
                outboundBytes_ = 0;
                return;
            }
            message = std::move(outbound_.front());
            outbound_.pop_front();
        }

        const auto connection = connection_.load();
        if (connection && connection->id == message.connectionId &&
            connection->connected.load() &&
            !connection->disconnectRequested.load()) {
            if (std::chrono::steady_clock::now() >= message.deadline ||
                !WriteMessage(connection, message)) {
                connection->RequestDisconnect();
            } else if (message.closeAfterWrite) {
                connection->MarkTerminalWritten();
            }
        }
        {
            std::scoped_lock lock(outboundMutex_);
            outboundCount_ -= std::min<std::size_t>(outboundCount_, 1);
            outboundBytes_ -= std::min(outboundBytes_, message.data.size());
        }
    }
}

void NamedPipeServer::ProcessLine(const std::string& line,
                                  const std::uint64_t connectionId) {
    std::string requestId;
    try {
        const auto envelope = nlohmann::json::parse(line);
        if (!envelope.is_object()) throw std::runtime_error("request envelope must be an object");
        for (const auto& [key, unused] : envelope.items()) {
            (void)unused;
            if (key != "schemaVersion" && key != "requestId" && key != "type" && key != "payload") {
                throw std::runtime_error("request envelope contains unsupported field: " + key);
            }
        }
        if (envelope.value("schemaVersion", 0) != 1) throw std::runtime_error("schemaVersion must be 1");
        if (!envelope.contains("requestId") || !envelope.at("requestId").is_string()) {
            throw std::runtime_error("requestId must be a string");
        }
        requestId = envelope.at("requestId").get<std::string>();
        if (requestId.empty() || requestId.size() > 128) throw std::runtime_error("requestId length is invalid");
        if (!envelope.contains("type") || !envelope.at("type").is_string()) throw std::runtime_error("type must be a string");
        const auto type = envelope.at("type").get<std::string>();
        if (type.empty() || type.size() > 64) throw std::runtime_error("type length is invalid");
        const auto payload = envelope.value("payload", nlohmann::json::object());
        if (!payload.is_object()) throw std::runtime_error("payload must be an object");
        bool queueFull{};
        {
            std::scoped_lock lock(requestsMutex_);
            queueFull = requests_.size() >= kMaximumQueuedRequests ||
                        line.size() > kMaximumQueuedBytes - std::min(queuedBytes_, kMaximumQueuedBytes);
            if (!queueFull) {
                queuedBytes_ += line.size();
                requests_.push_back({requestId, type, payload, line.size(), connectionId});
            }
        }
        if (queueFull) {
            EnqueueEnvelope(
                {{"schemaVersion", 1}, {"requestId", requestId}, {"type", "error"},
                 {"ok", false},
                 {"error", {{"code", "QUEUE_FULL"},
                            {"message", "Renderer command queue is full"}}}},
                connectionId, true);
        }
    } catch (const std::exception& error) {
        EnqueueEnvelope(
            {{"schemaVersion", 1}, {"requestId", requestId}, {"type", "error"},
             {"ok", false},
             {"error", {{"code", "INVALID_REQUEST"}, {"message", error.what()}}}},
            connectionId, true);
    }
}

void NamedPipeServer::SendResult(const IpcRequest& request,
                                 const nlohmann::json& payload) noexcept {
    try {
        EnqueueEnvelope(
            {{"schemaVersion", 1}, {"requestId", request.requestId}, {"type", "result"},
             {"ok", true}, {"payload", payload}},
            request.connectionId, true);
    } catch (...) {
        if (const auto connection = connection_.load();
            connection && connection->id == request.connectionId) {
            connection->RequestDisconnect();
        }
    }
}

void NamedPipeServer::SendError(const IpcRequest& request, const std::string_view code,
                                const std::string_view message) noexcept {
    try {
        EnqueueEnvelope(
            {{"schemaVersion", 1}, {"requestId", request.requestId}, {"type", "error"},
             {"ok", false},
             {"error", {{"code", std::string(code)}, {"message", std::string(message)}}}},
            request.connectionId, true);
    } catch (...) {
        if (const auto connection = connection_.load();
            connection && connection->id == request.connectionId) {
            connection->RequestDisconnect();
        }
    }
}

void NamedPipeServer::SendEvent(const nlohmann::json& payload) noexcept {
    try {
        EnqueueEnvelope({{"schemaVersion", 1}, {"requestId", nullptr}, {"type", "event"},
                         {"ok", true}, {"payload", payload}});
    } catch (...) {
        if (const auto connection = connection_.load()) connection->RequestDisconnect();
    }
}

bool NamedPipeServer::EnqueueEnvelope(
    const nlohmann::json& envelope,
    const std::optional<std::uint64_t> connectionId,
    const bool closeAfterWrite) noexcept {
    const auto connection = connection_.load();
    try {
        if (!connection || !connection->connected.load() ||
            connection->disconnectRequested.load() ||
            (connectionId && connection->id != *connectionId)) {
            return false;
        }
        auto data = envelope.dump();
        data.push_back('\n');
        if (data.size() > kMaximumMessageBytes) {
            connection->RequestDisconnect();
            return false;
        }

        std::unique_lock lock(outboundMutex_, std::try_to_lock);
        if (!lock.owns_lock()) {
            connection->RequestDisconnect();
            outboundReady_.notify_one();
            return false;
        }
        const auto stillCurrent = connection_.load();
        const auto queueFull = !stillCurrent || stillCurrent->id != connection->id ||
                               !connection->connected.load() ||
                               connection->disconnectRequested.load() ||
                               outboundCount_ >= kMaximumQueuedResponses ||
                               data.size() > kMaximumQueuedResponseBytes -
                                   std::min(outboundBytes_, kMaximumQueuedResponseBytes);
        if (queueFull) {
            connection->RequestDisconnect();
            lock.unlock();
            outboundReady_.notify_one();
            return false;
        }
        if (connection->terminalCloseQueued.load()) {
            return false;
        }
        const auto wireBytes = data.size();
        outbound_.push_back({
            connection->id,
            std::move(data),
            std::chrono::steady_clock::now() +
                std::chrono::milliseconds(kWriteDeadlineMs),
            closeAfterWrite,
        });
        if (closeAfterWrite) connection->terminalCloseQueued.store(true);
        outboundBytes_ += wireBytes;
        ++outboundCount_;
        lock.unlock();
        outboundReady_.notify_one();
        return true;
    } catch (...) {
        if (connection) connection->RequestDisconnect();
        outboundReady_.notify_one();
        return false;
    }
}

bool NamedPipeServer::WriteMessage(
    const std::shared_ptr<PipeConnection>& connection,
    const OutboundMessage& message) noexcept {
    if (!connection->BeginWrite()) return false;
    const auto finish = [&](const bool result) {
        connection->EndWrite();
        return result;
    };

    const auto pipe = connection->Handle();
    const auto writeEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!writeEvent || pipe == INVALID_HANDLE_VALUE) {
        if (writeEvent) CloseHandle(writeEvent);
        return finish(false);
    }

    std::size_t offset{};
    while (offset < message.data.size()) {
        if (connection->disconnectRequested.load()) {
            CloseHandle(writeEvent);
            return finish(false);
        }
        const auto timeout = RemainingDeadlineMilliseconds(message.deadline);
        if (timeout == 0) {
            CloseHandle(writeEvent);
            return finish(false);
        }
        ResetEvent(writeEvent);
        OVERLAPPED overlapped{};
        overlapped.hEvent = writeEvent;
        const auto remaining = static_cast<DWORD>(
            std::min<std::size_t>(message.data.size() - offset,
                                  std::numeric_limits<DWORD>::max()));
        const auto started = WriteFile(pipe, message.data.data() + offset,
                                       remaining, nullptr, &overlapped) != FALSE;
        const auto error = started ? ERROR_SUCCESS : GetLastError();
        if (started) {
            DWORD written{};
            if (!GetOverlappedResult(pipe, &overlapped, &written, FALSE) ||
                written == 0) {
                CloseHandle(writeEvent);
                return finish(false);
            }
            offset += written;
            continue;
        }
        if (!started && error != ERROR_IO_PENDING) {
            CloseHandle(writeEvent);
            return finish(false);
        }

        const HANDLE waits[]{writeEvent, connection->abortEvent};
        const auto wait = WaitForMultipleObjects(2, waits, FALSE, timeout);
        if (wait != WAIT_OBJECT_0) {
            connection->RequestDisconnect();
            CancelAndDrain(pipe, overlapped);
            CloseHandle(writeEvent);
            return finish(false);
        }
        DWORD written{};
        if (!GetOverlappedResult(pipe, &overlapped, &written, FALSE) || written == 0) {
            CloseHandle(writeEvent);
            return finish(false);
        }
        offset += written;
    }
    CloseHandle(writeEvent);
    return finish(true);
}

void NamedPipeServer::PurgeConnection(const std::uint64_t connectionId) noexcept {
    {
        std::scoped_lock lock(requestsMutex_);
        for (auto iterator = requests_.begin(); iterator != requests_.end();) {
            if (iterator->connectionId == connectionId) {
                queuedBytes_ -= std::min(queuedBytes_, iterator->wireBytes);
                iterator = requests_.erase(iterator);
            } else {
                ++iterator;
            }
        }
    }
    {
        std::scoped_lock lock(outboundMutex_);
        for (auto iterator = outbound_.begin(); iterator != outbound_.end();) {
            if (iterator->connectionId == connectionId) {
                outboundBytes_ -= std::min(outboundBytes_, iterator->data.size());
                outboundCount_ -= std::min<std::size_t>(outboundCount_, 1);
                iterator = outbound_.erase(iterator);
            } else {
                ++iterator;
            }
        }
    }
}

} // namespace pbwin

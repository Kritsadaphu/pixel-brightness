#pragma once

#include "pbwin/PipeListenerRecoveryPolicy.hpp"

#include <Windows.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cstddef>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>

namespace pbwin {

struct PipeConnection;

struct IpcRequest {
    std::string requestId;
    std::string type;
    nlohmann::json payload;
    std::size_t wireBytes{};
    std::uint64_t connectionId{};
};

#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
struct NamedPipeListenerFaultPlan {
    std::uint32_t createPipeFailures{};
    std::uint32_t connectionStateFailures{};
    std::uint32_t connectEventFailures{};
};
#endif

class NamedPipeServer final {
public:
    static constexpr std::size_t kMaximumMessageBytes = 64ULL * 1024 * 1024;
    static constexpr std::size_t kMaximumQueuedBytes = 128ULL * 1024 * 1024;
    static constexpr std::size_t kMaximumQueuedRequests = 8;
    static constexpr std::size_t kMaximumQueuedResponseBytes = 128ULL * 1024 * 1024;
    static constexpr std::size_t kMaximumQueuedResponses = 32;
    static constexpr std::uint32_t kFirstMessageDeadlineMs = 5000;
    static constexpr std::uint32_t kFramingIdleDeadlineMs = 2000;
    static constexpr std::uint32_t kTerminalDisconnectDeadlineMs = 500;
    static constexpr std::uint32_t kWriteDeadlineMs = 2000;

    NamedPipeServer() = default;
    ~NamedPipeServer();
    NamedPipeServer(const NamedPipeServer&) = delete;
    NamedPipeServer& operator=(const NamedPipeServer&) = delete;

    void Start(std::wstring pipeName);
    void Stop() noexcept;
    [[nodiscard]] std::optional<IpcRequest> TryPop();
    void SendResult(const IpcRequest& request, const nlohmann::json& payload) noexcept;
    void SendError(const IpcRequest& request, std::string_view code,
                   std::string_view message) noexcept;
    void SendEvent(const nlohmann::json& payload) noexcept;
    [[nodiscard]] PipeListenerRecoverySnapshot ListenerHealth() const;
    [[nodiscard]] bool ListenerFatal() const noexcept {
        return listenerFatal_.load(std::memory_order_acquire);
    }
#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
    void SetListenerFaultPlanForTesting(NamedPipeListenerFaultPlan plan) noexcept;
    void SetClientDeadlinesForTesting(std::uint32_t firstMessageMilliseconds,
                                      std::uint32_t framingIdleMilliseconds,
                                      std::uint32_t terminalDisconnectMilliseconds) noexcept;
#endif

private:
    enum class ConnectOutcome {
        connected,
        stopped,
        failed,
    };

    struct ConnectAttempt {
        ConnectOutcome outcome{ConnectOutcome::failed};
        PipeListenerFailureStage failureStage{PipeListenerFailureStage::none};
        DWORD win32Error{};
    };

    struct OutboundMessage {
        std::uint64_t connectionId{};
        std::string data;
        std::chrono::steady_clock::time_point deadline;
        bool closeAfterWrite{};
    };

    void ReaderRun(std::stop_token stopToken);
    void WriterRun(std::stop_token stopToken);
    [[nodiscard]] ConnectAttempt WaitForConnect(
        const std::shared_ptr<PipeConnection>& connection) noexcept;
    [[nodiscard]] bool HandleListenerFailure(
        PipeListenerFailureStage stage,
        DWORD win32Error,
        std::string_view detail,
        std::stop_token stopToken) noexcept;
    void MarkListenerListening() noexcept;
    void MarkListenerConnected() noexcept;
    void MarkListenerDisconnected() noexcept;
    void ProcessLine(const std::string& line, std::uint64_t connectionId);
    void AwaitTerminalClose(const std::shared_ptr<PipeConnection>& connection) noexcept;
    bool EnqueueEnvelope(const nlohmann::json& envelope,
                         std::optional<std::uint64_t> connectionId = std::nullopt,
                         bool closeAfterWrite = false) noexcept;
    bool WriteMessage(const std::shared_ptr<PipeConnection>& connection,
                      const OutboundMessage& message) noexcept;
    void PurgeConnection(std::uint64_t connectionId) noexcept;

    std::wstring pipeName_;
    std::jthread readerThread_;
    std::jthread writerThread_;
    std::atomic<std::shared_ptr<PipeConnection>> connection_;
    std::atomic_uint64_t nextConnectionId_{1};
    std::mutex requestsMutex_;
    std::deque<IpcRequest> requests_;
    std::size_t queuedBytes_{};
    std::mutex outboundMutex_;
    std::condition_variable outboundReady_;
    std::deque<OutboundMessage> outbound_;
    std::size_t outboundCount_{};
    std::size_t outboundBytes_{};
    mutable std::mutex listenerHealthMutex_;
    PipeListenerRecoveryPolicy listenerRecovery_;
    std::atomic_bool listenerFatal_{};
    std::atomic_uint32_t firstMessageDeadlineMs_{kFirstMessageDeadlineMs};
    std::atomic_uint32_t framingIdleDeadlineMs_{kFramingIdleDeadlineMs};
    std::atomic_uint32_t terminalDisconnectDeadlineMs_{kTerminalDisconnectDeadlineMs};
    std::mutex listenerRetryMutex_;
    std::condition_variable_any listenerRetryReady_;
#if defined(PB_NAMED_PIPE_FAULT_INJECTION)
    static bool ConsumeInjectedFailure(std::atomic_uint32_t& remaining) noexcept;
    std::atomic_uint32_t injectedCreatePipeFailures_{};
    std::atomic_uint32_t injectedConnectionStateFailures_{};
    std::atomic_uint32_t injectedConnectEventFailures_{};
#endif
};

} // namespace pbwin

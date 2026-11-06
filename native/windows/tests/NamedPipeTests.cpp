#include "pbwin/NamedPipeServer.hpp"

#include <Windows.h>
#include <nlohmann/json.hpp>

#include <array>
#include <chrono>
#include <cstdint>
#include <format>
#include <future>
#include <iostream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace {

std::wstring UniquePipeName(std::wstring_view purpose);

void Require(const bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

HANDLE ConnectClient(const std::wstring& pipeName) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < deadline) {
        const auto handle = CreateFileW(
            pipeName.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        if (handle != INVALID_HANDLE_VALUE) return handle;
        if (GetLastError() != ERROR_PIPE_BUSY &&
            GetLastError() != ERROR_FILE_NOT_FOUND) {
            break;
        }
        WaitNamedPipeW(pipeName.c_str(), 50);
    }
    throw std::runtime_error("test client could not connect to renderer pipe");
}

pbwin::IpcRequest SendProbe(pbwin::NamedPipeServer& server,
                            const HANDLE client,
                            const std::string_view requestId = "hung-client") {
    const std::string request = nlohmann::json({
        {"schemaVersion", 1}, {"requestId", std::string(requestId)},
        {"type", "hello"}, {"payload", nlohmann::json::object()},
    }).dump() + "\n";
    DWORD written{};
    Require(WriteFile(client, request.data(), static_cast<DWORD>(request.size()),
                      &written, nullptr) != FALSE &&
                written == static_cast<DWORD>(request.size()),
            "test client could not send the probe request");
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < deadline) {
        if (auto probe = server.TryPop()) return std::move(*probe);
        Sleep(5);
    }
    throw std::runtime_error("renderer did not receive the probe request");
}

std::vector<std::string> ReadLines(const HANDLE client,
                                   const std::size_t count) {
    std::vector<std::string> lines;
    std::string pending;
    std::array<char, 4096> buffer{};
    while (lines.size() < count) {
        DWORD read{};
        if (!ReadFile(client, buffer.data(), static_cast<DWORD>(buffer.size()),
                      &read, nullptr) || read == 0) {
            throw std::runtime_error("pipe closed before terminal response was read");
        }
        pending.append(buffer.data(), read);
        std::size_t newline{};
        while (lines.size() < count &&
               (newline = pending.find('\n')) != std::string::npos) {
            lines.push_back(pending.substr(0, newline));
            pending.erase(0, newline + 1);
        }
    }
    return lines;
}

std::vector<std::string> ReadLinesAfterDelay(
    const HANDLE client,
    const std::size_t count,
    const std::chrono::milliseconds delay) {
    Sleep(static_cast<DWORD>(delay.count()));
    return ReadLines(client, count);
}

std::vector<std::string> AwaitLines(
    std::future<std::vector<std::string>>& future,
    const std::size_t expected) {
    Require(future.wait_for(std::chrono::seconds(3)) == std::future_status::ready,
            "timed out waiting for named-pipe response");
    auto lines = future.get();
    Require(lines.size() == expected,
            "named-pipe response contained the wrong line count");
    return lines;
}

void RequireTerminalError(const std::string& line,
                          const std::string_view expectedCode) {
    const auto envelope = nlohmann::json::parse(line);
    Require(envelope.value("type", std::string{}) == "error" &&
                !envelope.value("ok", true),
            "idle client did not receive a terminal error envelope");
    Require(envelope.at("error").value("code", std::string{}) == expectedCode,
            "idle client received the wrong timeout code");
}

void RequireConnectionClosed(const HANDLE client) {
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::seconds(3);
    while (std::chrono::steady_clock::now() < deadline) {
        DWORD available{};
        if (!PeekNamedPipe(client, nullptr, 0, nullptr, &available, nullptr)) {
            return;
        }
        Sleep(5);
    }
    throw std::runtime_error("server retained the client after terminal response");
}

void TestLegitimateReconnect(pbwin::NamedPipeServer& server,
                             const std::wstring& pipeName,
                             const std::string_view requestId,
                             const bool slowMultiChunkReader = false) {
    const auto client = ConnectClient(pipeName);
    const auto probe = SendProbe(server, client, requestId);
    auto response = slowMultiChunkReader
        ? std::async(std::launch::async, ReadLinesAfterDelay, client, 2,
                     std::chrono::milliseconds(75))
        : std::async(std::launch::async, ReadLines, client, 2);
    server.SendEvent({{"event", "liveness-before-result"}});
    Sleep(20);
    const std::string padding = slowMultiChunkReader
        ? std::string(2 * 1024 * 1024, 'x')
        : std::string{};
    server.SendResult(probe, {{"connected", true}, {"padding", padding}});
    const auto lines = AwaitLines(response, 2);
    const auto event = nlohmann::json::parse(lines.at(0));
    const auto result = nlohmann::json::parse(lines.at(1));
    Require(event.value("type", std::string{}) == "event",
            "event queued before a result was not preserved");
    Require(result.value("type", std::string{}) == "result" &&
                result.value("requestId", std::string{}) == requestId &&
                result.value("ok", false),
            "legitimate reconnect did not receive its terminal result");
    Require(result.at("payload").value("padding", std::string{}).size() ==
                padding.size(),
            "slow reader lost part of its multi-buffer terminal result");
    RequireConnectionClosed(client);
    CloseHandle(client);
}

void TestIdleClientEvictionAndReconnect() {
    const auto pipeName = UniquePipeName(L"client-liveness");
    pbwin::NamedPipeServer server;
    server.SetClientDeadlinesForTesting(150, 150, 500);
    server.Start(pipeName);

    auto silent = ConnectClient(pipeName);
    auto silentResponse = std::async(std::launch::async, ReadLines, silent, 1);
    const auto silentLines = AwaitLines(silentResponse, 1);
    RequireTerminalError(silentLines.front(), "FIRST_MESSAGE_TIMEOUT");
    RequireConnectionClosed(silent);
    CloseHandle(silent);

    TestLegitimateReconnect(server, pipeName, "after-silent-client");

    auto partial = ConnectClient(pipeName);
    const std::string partialFrame = R"({"schemaVersion":1)";
    DWORD written{};
    Require(WriteFile(partial, partialFrame.data(),
                      static_cast<DWORD>(partialFrame.size()), &written,
                      nullptr) != FALSE &&
                written == static_cast<DWORD>(partialFrame.size()),
            "partial client could not write its incomplete frame");
    auto partialResponse = std::async(std::launch::async, ReadLines, partial, 1);
    const auto partialLines = AwaitLines(partialResponse, 1);
    RequireTerminalError(partialLines.front(), "FRAMING_TIMEOUT");
    RequireConnectionClosed(partial);
    CloseHandle(partial);

    TestLegitimateReconnect(server, pipeName, "after-partial-client", true);
    server.Stop();
}

template <typename Predicate>
pbwin::PipeListenerRecoverySnapshot WaitForHealth(
    pbwin::NamedPipeServer& server,
    Predicate&& predicate,
    const std::chrono::milliseconds timeout,
    const std::string_view failure) {
    const auto deadline = std::chrono::steady_clock::now() + timeout;
    while (std::chrono::steady_clock::now() < deadline) {
        auto health = server.ListenerHealth();
        if (predicate(health)) return health;
        Sleep(5);
    }
    throw std::runtime_error(std::string(failure));
}

std::wstring UniquePipeName(const std::wstring_view purpose) {
    return std::format(L"\\\\.\\pipe\\pbwin-{}-{}-{}", purpose,
                       GetCurrentProcessId(), GetTickCount64());
}

void TestTransientListenerRecovery() {
    const auto pipeName = UniquePipeName(L"listener-transient");
    pbwin::NamedPipeServer server;
    server.SetListenerFaultPlanForTesting({1, 1, 1});
    server.Start(pipeName);
    // CreateNamedPipe exposes a handle before connection-state/event setup.
    // Connecting during an intentionally failed generation can retain that
    // obsolete instance and prevent the next single-instance listener from
    // being created. Test recovery after the three injected setup failures,
    // not a client that keeps an already-broken generation open indefinitely.
    WaitForHealth(
        server,
        [](const auto& value) {
            return value.phase == pbwin::PipeListenerPhase::listening &&
                   value.totalFailures == 3;
        },
        std::chrono::seconds(3),
        "listener did not arm after injected setup failures");
    const auto client = ConnectClient(pipeName);
    const auto health = WaitForHealth(
        server,
        [](const auto& value) {
            return value.phase == pbwin::PipeListenerPhase::connected;
        },
        std::chrono::seconds(3),
        "listener did not recover from injected setup failures");
    Require(health.totalFailures == 3,
            "injected create/allocation/event failures did not share one budget");
    Require(health.consecutiveFailures == 0 &&
                health.successfulRecoveries == 1 && !health.fatal,
            "successful listener recovery did not reset consecutive failures");
    CloseHandle(client);
    server.Stop();
}

void TestListenerExhaustion() {
    const auto pipeName = UniquePipeName(L"listener-exhausted");
    pbwin::NamedPipeServer server;
    server.SetListenerFaultPlanForTesting(
        {2, 2, pbwin::PipeListenerRecoveryPolicy::kMaximumFailures - 4});
    const auto started = std::chrono::steady_clock::now();
    server.Start(pipeName);
    const auto health = WaitForHealth(
        server,
        [](const auto& value) { return value.fatal; },
        std::chrono::seconds(8),
        "listener did not fail closed after exhausting setup retries");
    const auto elapsed = std::chrono::steady_clock::now() - started;
    Require(health.consecutiveFailures ==
                pbwin::PipeListenerRecoveryPolicy::kMaximumFailures,
            "listener exhausted at the wrong attempt count");
    Require(health.totalFailures ==
                pbwin::PipeListenerRecoveryPolicy::kMaximumFailures,
            "listener fault injection skipped a setup failure stage");
    Require(elapsed >= std::chrono::seconds(3),
            "listener exhaustion tight-looped instead of honoring backoff");
    Require(server.ListenerFatal(),
            "fatal listener state was not available through the lock-free render check");

    const auto stopped = std::chrono::steady_clock::now();
    server.Stop();
    Require(std::chrono::steady_clock::now() - stopped <
                std::chrono::seconds(2),
            "fatal listener did not stop and join promptly");
}

} // namespace

int main() {
    HANDLE client{INVALID_HANDLE_VALUE};
    try {
        TestTransientListenerRecovery();
        TestListenerExhaustion();
        TestIdleClientEvictionAndReconnect();

        const auto pipeName = UniquePipeName(L"nonreading");
        pbwin::NamedPipeServer server;
        server.Start(pipeName);
        client = ConnectClient(pipeName);
        const auto probe = SendProbe(server, client);

        // The client deliberately never reads. A synchronous WriteFile on the
        // caller/render thread blocks once the 64 KiB pipe buffer fills.
        const std::string padding(256 * 1024, 'x');
        const auto enqueueStarted = std::chrono::steady_clock::now();
        std::uint64_t cadenceTicks{};
        for (std::uint32_t sequence = 0; sequence < 128; ++sequence) {
            server.SendResult(
                probe,
                {{"sequence", sequence}, {"padding", padding}});
            ++cadenceTicks;
        }
        const auto enqueueElapsed = std::chrono::steady_clock::now() -
                                    enqueueStarted;
        Require(cadenceTicks == 128,
                "simulated render cadence stopped while responses backed up");
        Require(enqueueElapsed < std::chrono::seconds(3),
                "response enqueue blocked on a non-reading client");

        const auto cadenceStarted = std::chrono::steady_clock::now();
        for (std::uint32_t frame = 0; frame < 10000; ++frame) {
            server.SendEvent({{"event", "frame-status"}, {"frame", frame}});
            ++cadenceTicks;
        }
        Require(cadenceTicks == 10128,
                "frame/status cadence did not continue after client overflow");
        Require(std::chrono::steady_clock::now() - cadenceStarted <
                    std::chrono::seconds(2),
                "event enqueue stalled after disconnecting a hung client");

        const auto stopStarted = std::chrono::steady_clock::now();
        server.Stop();
        Require(std::chrono::steady_clock::now() - stopStarted <
                    std::chrono::seconds(4),
                "pipe shutdown did not cancel and join the bounded writer");
        CloseHandle(client);
        client = INVALID_HANDLE_VALUE;
        std::cout << "pbwin non-reading named-pipe test passed\n";
        return 0;
    } catch (const std::exception& error) {
        if (client != INVALID_HANDLE_VALUE) CloseHandle(client);
        std::cerr << "pbwin non-reading named-pipe test failed: "
                  << error.what() << '\n';
        return 1;
    }
}

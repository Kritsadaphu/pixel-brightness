#include "pbwin/RendererApp.hpp"

#include "pbwin/Digest.hpp"
#include "pbwin/DisplayRegistry.hpp"
#include "pbwin/Log.hpp"
#include "pbwin/Win32Window.hpp"

#include <avrt.h>
#include <dwmapi.h>

#include <algorithm>
#include <array>
#include <bit>
#include <chrono>
#include <cctype>
#include <format>
#include <set>
#include <stdexcept>
#include <string_view>
#include <type_traits>
#include <utility>

namespace pbwin {
namespace {

constexpr DWORD kRecoveryLoopSleepMilliseconds = 25;
constexpr DWORD kExhaustedRecoveryLoopSleepMilliseconds = 250;
constexpr int kIpcListenerFatalExitCode = 70;
constexpr auto kFatalTelemetryDeadline = std::chrono::milliseconds(500);
constexpr auto kRecoveryBlackRefreshInterval = std::chrono::milliseconds(250);
constexpr auto kExhaustedBlackRefreshInterval = std::chrono::milliseconds(1000);

std::uint64_t NowMilliseconds() noexcept {
    return static_cast<std::uint64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count());
}

nlohmann::json PatternResult(const PatternConfig& pattern) {
    nlohmann::json result{{"mode", PatternModeName(pattern.mode)}, {"cellSize", pattern.cellSize}};
    if (pattern.mode == PatternMode::solid) {
        result["rgb"] = pattern.solidRgb;
        result["applyCorrections"] = pattern.applyCorrections;
    }
    if (pattern.mode == PatternMode::grayCode) {
        result["axis"] = pattern.grayAxisY ? "y" : "x";
        result["bit"] = pattern.grayBit;
        result["inverse"] = pattern.inverse;
    }
    return result;
}

std::optional<std::string> OptionalOutputId(const nlohmann::json& payload,
                                            const std::string_view command) {
    if (!payload.contains("outputId") || payload.at("outputId").is_null()) return std::nullopt;
    if (!payload.at("outputId").is_string()) {
        throw std::runtime_error(std::string(command) + ".outputId must be a string");
    }
    auto outputId = payload.at("outputId").get<std::string>();
    if (outputId.empty() || outputId.size() > 64) {
        throw std::runtime_error(std::string(command) + ".outputId length is invalid");
    }
    return outputId;
}

std::string EphemeralAuthorizationDigest(const nlohmann::json& payload,
                                         const std::string_view command) {
    if (!payload.contains("authorizationToken") ||
        !payload.at("authorizationToken").is_string()) {
        throw std::runtime_error(
            std::string(command) + ".authorizationToken must be a string");
    }
    auto authorizationToken = payload.at("authorizationToken").get<std::string>();
    const auto validToken = authorizationToken.size() >= 43 &&
                            authorizationToken.size() <= 128 &&
                            std::all_of(
                                authorizationToken.begin(), authorizationToken.end(),
                                [](const unsigned char character) {
                                    return std::isalnum(character) || character == '_' ||
                                           character == '-';
                                });
    const auto authorizationDigest = validToken
                                         ? Sha256Hex(authorizationToken)
                                         : std::string(64, '0');
    std::fill(authorizationToken.begin(), authorizationToken.end(), '\0');
    return authorizationDigest;
}

const nlohmann::json& AuthenticatedMutationPayload(
    const nlohmann::json& wrapper, const std::string_view command,
    const std::string_view payloadField, const BootBlackLock& authorization) {
    const auto field = std::string(payloadField);
    for (const auto& [key, unused] : wrapper.items()) {
        (void)unused;
        if (key != "authorizationToken" && key != field) {
            throw std::runtime_error(
                std::string(command) + " contains unsupported field: " + key);
        }
    }
    if (!wrapper.contains(field) || !wrapper.at(field).is_object()) {
        throw std::runtime_error(
            std::string(command) + "." + std::string(payloadField) + " must be an object");
    }
    const auto authorizationDigest = EphemeralAuthorizationDigest(wrapper, command);
    if (!authorization.Authorize(authorizationDigest)) {
        throw std::runtime_error(std::string(command) + " authorization failed");
    }
    return wrapper.at(field);
}

void RequireMutationAuthorization(const nlohmann::json& payload,
                                  const std::string_view command,
                                  const BootBlackLock& authorization) {
    for (const auto& [key, unused] : payload.items()) {
        (void)unused;
        if (key != "authorizationToken") {
            throw std::runtime_error(
                std::string(command) + " contains unsupported field: " + key);
        }
    }
    const auto authorizationDigest = EphemeralAuthorizationDigest(payload, command);
    if (!authorization.Authorize(authorizationDigest)) {
        throw std::runtime_error(std::string(command) + " authorization failed");
    }
}

ActiveCorrectionBinding BuildActiveCorrectionBinding(
    const RendererConfig& config,
    const std::vector<std::unique_ptr<OutputSurface>>& outputs,
    const std::optional<std::string>& canonicalConfigSha256 = std::nullopt) {
    ActiveCorrectionBinding binding;
    binding.configSha256 = canonicalConfigSha256.value_or(
        Sha256Hex(ConfigLoader::ToJson(config).dump()));
    binding.outputs.reserve(outputs.size());
    for (const auto& output : outputs) {
        const auto telemetry = output->Snapshot();
        binding.outputs.push_back({telemetry.id, telemetry.processingBypass,
                                   telemetry.correctionBinding});
    }
    auto fingerprintPayload = ActiveCorrectionBindingJson(binding);
    fingerprintPayload.erase("fingerprint");
    binding.fingerprint = Sha256Hex(fingerprintPayload.dump());
    return binding;
}

} // namespace

RendererApp::RendererApp(const HINSTANCE instance, std::string bootBlackAuthorizationDigest)
    : instance_(instance), bootBlackLock_(std::move(bootBlackAuthorizationDigest)) {}

int RendererApp::Run(RendererConfig config) {
    Win32Window::Register(instance_);
    SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
    DWORD avrtTask{};
    const auto avrtHandle = AvSetMmThreadCharacteristicsW(L"Games", &avrtTask);
    int exitCode{};
    try {
        ApplyConfig(std::move(config), true);
        pipe_.Start(config_.pipeName);
        state_ = "boot-black-locked";
        running_ = true;
        while (running_) {
            PumpMessages();
            if (HandleFatalPipeListener()) {
                exitCode = kIpcListenerFatalExitCode;
                break;
            }
            HandleRequests();
            if (!running_) break;

            if (recovery_.Active()) {
                ServiceRecovery();
                UpdateTelemetry();
                if (recovery_.Active()) {
                    Sleep(recovery_.Exhausted() ? kExhaustedRecoveryLoopSleepMilliseconds
                                                : kRecoveryLoopSleepMilliseconds);
                    continue;
                }
            }

            if (outputsHealthy_) {
                std::array<HANDLE, kMaxOutputs> waitHandles{};
                DWORD waitCount{};
                for (const auto& output : outputs_) {
                    const auto handle = output->FrameLatencyHandle();
                    if (handle != INVALID_HANDLE_VALUE) waitHandles[waitCount++] = handle;
                }
                if (waitCount != 0) {
                    // A message-aware wait in wait-all mode also includes the
                    // message-queue pseudo-object in the all condition. In
                    // a quiet show loop that can impose the full 100 ms timeout
                    // even though every swapchain is ready. Messages were just
                    // pumped above; wait only for all local scanout queues here.
                    const auto wait = WaitForMultipleObjects(
                        waitCount, waitHandles.data(), TRUE, 100);
                    if (wait != WAIT_OBJECT_0) {
                        const auto error = wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
                        outputsHealthy_ = false;
                        pipe_.SendEvent({{"event", "frame-latency-wait-error"},
                                         {"win32Error", error}, {"timedOut", wait == WAIT_TIMEOUT}});
                        Log::Error("Frame-latency wait failed closed: result={} error={}", wait, error);
                        BeginRecovery(RecoveryTrigger::frameLatencyFailure,
                                      std::format("frame-latency wait result={} win32Error={}",
                                                  wait, error));
                        UpdateTelemetry();
                        Sleep(kRecoveryLoopSleepMilliseconds);
                        continue;
                    }
                }
            }
            // A display broadcast can arrive while all frame-latency handles
            // are being waited. Drain it before another content submission so
            // the just-detected topology enters black recovery first.
            PumpMessages();
            if (!running_) break;
            if (HandleFatalPipeListener()) { exitCode = kIpcListenerFatalExitCode; break; }
            if (recovery_.Active()) {
                UpdateTelemetry();
                continue;
            }
            RenderFrame();
            UpdateTelemetry();
        }
    } catch (...) {
        for (auto& output : outputs_) output->PresentBlack(graphics_);
        pipe_.Stop();
        telemetry_.Shutdown();
        if (avrtHandle) AvRevertMmThreadCharacteristics(avrtHandle);
        SetThreadExecutionState(ES_CONTINUOUS);
        throw;
    }
    for (auto& output : outputs_) output->PresentBlack(graphics_);
    graphics_.Context()->Flush();
    pipe_.Stop();
    telemetry_.Shutdown();
    compositionInput_.Shutdown();
    outputs_.clear();
    if (avrtHandle) AvRevertMmThreadCharacteristics(avrtHandle);
    SetThreadExecutionState(ES_CONTINUOUS);
    return exitCode;
}

void RendererApp::ApplyConfig(RendererConfig config, const bool initial,
                              std::optional<std::string> canonicalConfigSha256) {
    if (!initial) {
        if (config.revision <= config_.revision) throw std::runtime_error("Config revision is not newer than active revision");
        if (config.nodeId != config_.nodeId) throw std::runtime_error("Live config cannot change nodeId");
        if (config.pipeName != config_.pipeName) throw std::runtime_error("Live config cannot change pipeName");
        if (config.adapterLuid != config_.adapterLuid) throw std::runtime_error("GPU adapter change requires renderer restart");
    } else {
        graphics_.Create(config.adapterLuid);
    }

    std::vector<std::unique_ptr<OutputSurface>> candidateOutputs;
    BuildOutputs(config, graphics_, candidateOutputs);
    RestoreRuntimeOverrides(candidateOutputs);
    SpoutInput candidateInput;
    candidateInput.Initialize(graphics_.Device(), config.compositionSource);
    auto candidateBinding = BuildActiveCorrectionBinding(
        config, candidateOutputs, canonicalConfigSha256);
    auto candidateState = std::string(BootBlackLocked() ? "boot-black-locked" : "running");
    const auto committedLog = std::format(
        "Applied native renderer config revision {} with {} outputs and shared sender {}",
        config.revision, candidateOutputs.size(), config.compositionSource.senderName);

    // Initialize performs only a best-effort provisional black submission so
    // its hidden candidate window can be shown safely. A live transaction must
    // prove every now-visible candidate independently: successful HRESULT
    // values such as DXGI_STATUS_OCCLUDED are not accepted black submissions.
    try {
        for (auto& output : candidateOutputs) output->ValidateBlackPresent(graphics_);
        // Keep the previous windows alive as black covers until the candidates
        // and the shared device have both passed their final validation point.
        for (auto& output : outputs_) output->PresentBlack(graphics_);
        graphics_.CheckRemoved();
    } catch (const std::exception&) {
        if (!initial && FAILED(graphics_.DeviceRemovedReason())) {
            // A candidate can be the first call to observe a device loss. Enter
            // the existing bounded recovery path immediately so another queued
            // request cannot release boot black against a stale healthy flag.
            outputsHealthy_ = false;
            BeginRecovery(RecoveryTrigger::deviceRemoved,
                          "Live config candidate validation detected D3D device removal");
        }
        throw;
    }

    // Telemetry reconfiguration is the last potentially throwing operation.
    // Everything below is an ownership exchange with statically proven
    // no-throw moves/swaps, so a reported apply failure always leaves the old
    // committed outputs, config and correction binding authoritative.
    telemetry_.Configure(config.telemetry);
    static_assert(std::is_nothrow_move_assignable_v<SpoutInput>);
    static_assert(std::is_nothrow_swappable_v<decltype(outputs_)>);
    static_assert(std::is_nothrow_swappable_v<RendererConfig>);
    static_assert(std::is_nothrow_swappable_v<ActiveCorrectionBinding>);
    static_assert(std::is_nothrow_swappable_v<std::string>);

    compositionInput_.Shutdown();
    compositionInput_ = std::move(candidateInput);
    outputs_.swap(candidateOutputs);
    std::swap(config_, config);
    std::swap(activeCorrectionBinding_, candidateBinding);
    state_.swap(candidateState);
    lastFrameStatisticsFlush_ = {};
    outputsHealthy_ = true;
    Log::Write(LogLevel::info, committedLog);
}

void RendererApp::BuildOutputs(const RendererConfig& config, D3DDevice& graphics,
                               std::vector<std::unique_ptr<OutputSurface>>& destination) {
    const auto displays = DisplayRegistry::EnumerateActive();
    std::set<std::pair<LuidValue, std::uint32_t>> claimed;
    for (const auto& outputConfig : config.outputs) {
        if (!outputConfig.enabled) continue;
        const auto display = DisplayRegistry::Resolve(outputConfig.display, displays);
        if (!display) throw std::runtime_error("Configured display not active for output " + outputConfig.id);
        const auto identity = std::pair{display->adapterLuid, display->targetId};
        if (!claimed.insert(identity).second) throw std::runtime_error("Two outputs select the same physical display");
        auto output = std::make_unique<OutputSurface>();
        output->Initialize(graphics, outputConfig, config.canvas, *display,
                           config.configDirectory, config.topmost, config.vsync);
        destination.push_back(std::move(output));
    }
    if (destination.empty()) throw std::runtime_error("Renderer config has no enabled physical outputs");
}

void RendererApp::HandleRequests() {
    while (auto request = pipe_.TryPop()) HandleRequest(*request);
}

void RendererApp::HandleRequest(const IpcRequest& request) {
    try {
        if (request.type == "hello") {
            pipe_.SendResult(request, Capabilities());
        } else if (request.type == "get-status") {
            UpdateTelemetry();
            pipe_.SendResult(request, telemetry_.Snapshot());
        } else if (request.type == "release-boot-black") {
            for (const auto& [key, unused] : request.payload.items()) {
                (void)unused;
                if (key != "authorizationToken") {
                    throw std::runtime_error(
                        "release-boot-black contains unsupported field: " + key);
                }
            }
            const auto authorizationDigest =
                EphemeralAuthorizationDigest(request.payload, "release-boot-black");
            if (recovery_.Active() || !outputsHealthy_ || pipe_.ListenerFatal()) {
                throw std::runtime_error(
                    "release-boot-black is unavailable while renderer health is degraded");
            }
            const auto release = bootBlackLock_.Release(authorizationDigest);
            if (release == BootBlackReleaseResult::unauthorized) {
                throw std::runtime_error("release-boot-black authorization failed");
            }
            state_ = compositionInput_.IsValid() ? "running" : "input-degraded";
            const auto released = release == BootBlackReleaseResult::released;
            pipe_.SendResult(
                request,
                {{"released", released},
                 {"alreadyReleased", !released},
                 {"bootBlackLocked", BootBlackLocked()},
                 {"bootBlackReleaseCount", bootBlackLock_.ReleaseCount()}});
            if (released) {
                Log::Write(LogLevel::info,
                           "Authenticated Node released boot-black latch");
            }
        } else if (request.type == "apply-config") {
            if (recovery_.Active()) {
                throw std::runtime_error(
                    "apply-config is unavailable while display recovery is active; "
                    "restore the exact configured targets or restart with a reviewed binding");
            }
            const auto& configPayload = AuthenticatedMutationPayload(
                request.payload, "apply-config", "config", bootBlackLock_);
            // Bind the receipt to the exact normalized JSON object supplied by
            // Node, before ConfigLoader narrows geometry/radiometry values to
            // native float fields or resolves paths. nlohmann's object dump is
            // key-sorted and matches Node's canonical JSON digest contract.
            const auto canonicalConfigSha256 = Sha256Hex(configPayload.dump());
            auto next = ConfigLoader::FromJson(configPayload, config_.configDirectory);
            ApplyConfig(std::move(next), false, canonicalConfigSha256);
            pipe_.SendResult(request,
                             {{"revision", config_.revision}, {"outputs", outputs_.size()},
                              {"activeCorrectionBinding",
                               ActiveCorrectionBindingJson(activeCorrectionBinding_)}});
        } else if (request.type == "set-pattern") {
            const auto& patternPayload = AuthenticatedMutationPayload(
                request.payload, "set-pattern", "pattern", bootBlackLock_);
            if (BootBlackLocked()) {
                throw std::runtime_error(
                    "set-pattern is unavailable while boot black is locked");
            }
            const auto pattern = ParsePatternCommand(patternPayload);
            const auto outputId = OptionalOutputId(patternPayload, "set-pattern");
            PatternAll(pattern, outputId);
            auto result = PatternResult(pattern);
            result["outputId"] = outputId ? nlohmann::json(*outputId) : nlohmann::json(nullptr);
            result["otherOutputs"] = !outputId ? "same-pattern"
                                      : pattern.mode != PatternMode::content ? "black"
                                                                            : "content";
            result["correctionsBypassed"] = PatternCorrectionsBypassed(pattern, false);
            pipe_.SendResult(request, result);
        } else if (request.type == "blank") {
            const auto& blankPayload = AuthenticatedMutationPayload(
                request.payload, "blank", "blank", bootBlackLock_);
            for (const auto& [key, unused] : blankPayload.items()) {
                (void)unused;
                if (key != "enabled" && key != "outputId") {
                    throw std::runtime_error("blank contains unsupported field: " + key);
                }
            }
            if (!blankPayload.contains("enabled") || !blankPayload.at("enabled").is_boolean()) {
                throw std::runtime_error("blank.enabled must be boolean");
            }
            if (BootBlackLocked() && !blankPayload.at("enabled").get<bool>()) {
                throw std::runtime_error(
                    "blank(false) is unavailable while boot black is locked");
            }
            const auto outputId = OptionalOutputId(blankPayload, "blank");
            BlankAll(blankPayload.at("enabled").get<bool>(), outputId);
            pipe_.SendResult(request,
                             {{"blank", blankPayload.at("enabled")},
                              {"outputId", outputId ? nlohmann::json(*outputId)
                                                    : nlohmann::json(nullptr)}});
        } else if (request.type == "shutdown") {
            RequireMutationAuthorization(request.payload, "shutdown", bootBlackLock_);
            BlankAll(true, std::nullopt);
            for (auto& output : outputs_) output->PresentBlack(graphics_);
            pipe_.SendResult(request, {{"shuttingDown", true}});
            running_ = false;
        } else {
            pipe_.SendError(request, "UNKNOWN_COMMAND", "Unsupported renderer command: " + request.type);
        }
    } catch (const std::exception& error) {
        pipe_.SendError(request, "COMMAND_FAILED", error.what());
        Log::Warning("Renderer command {} failed: {}", request.type, error.what());
    }
}

void RendererApp::PumpMessages() {
    MSG message{};
    while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
        if (message.message == WM_QUIT) {
            running_ = false;
            return;
        }
        // WM_DEVICECHANGE also fires for cameras and USB keys. Rebuilding every
        // projector swapchain for those unrelated devices causes a visible
        // blackout during calibration; Windows emits WM_DISPLAYCHANGE for the
        // active display-mode/topology changes that matter here.
        if (message.message == WM_DISPLAYCHANGE) {
            BeginRecovery(RecoveryTrigger::displayChange, "WM_DISPLAYCHANGE");
        }
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
}

bool RendererApp::HandleFatalPipeListener() {
    if (!pipe_.ListenerFatal()) return false;

    // Once the command/safety listener is irrecoverable, continuing to display
    // the last content would leave no way to issue blank, rollback, or shutdown.
    // Black and flush first, then make one bounded best-effort persistence
    // attempt before returning a distinct non-zero code to the Show supervisor.
    state_ = "ipc-listener-fatal";
    outputsHealthy_ = false;
    KeepOutputsBlack(true, true);
    if (graphics_.Context()) graphics_.Context()->Flush();

    bool telemetryPersisted{};
    try {
        UpdateTelemetry(false);
        telemetryPersisted = telemetry_.PublishFinal(kFatalTelemetryDeadline);
    } catch (const std::exception&) {
        Log::Write(LogLevel::error,
                   "Unable to update terminal IPC-listener telemetry");
    } catch (...) {
        Log::Write(LogLevel::error,
                   "Unable to update terminal IPC-listener telemetry: unknown error");
    }

    try {
        const auto health = pipe_.ListenerHealth();
        Log::Error(
            "Named-pipe listener is fatal after {}/{} consecutive failures at {}; "
            "outputs forced black, terminal telemetry persisted={}, renderer exit code={}",
            health.consecutiveFailures, health.maximumFailures,
            PipeListenerFailureStageName(health.lastFailureStage),
            telemetryPersisted, kIpcListenerFatalExitCode);
    } catch (...) {
        Log::Write(
            LogLevel::error,
            "Named-pipe listener is fatal; outputs forced black and renderer is exiting");
    }
    return true;
}

void RendererApp::BeginRecovery(const RecoveryTrigger trigger, const std::string& detail) {
    const auto started = recovery_.Trigger(trigger, NowMilliseconds(), detail);
    outputsHealthy_ = false;
    state_ = "display-recovering";
    // Do not mutate blank/pattern overrides here. A direct black present keeps
    // every surviving old window as a cover while the complete replacement is
    // validated, and RestoreRuntimeOverrides can later recover operator state.
    if (started) KeepOutputsBlack(true, true);
    else KeepOutputsBlack();
    if (started) {
        const auto snapshot = recovery_.Snapshot(NowMilliseconds());
        pipe_.SendEvent({{"event", "display-recovery-started"},
                         {"generation", snapshot.generation},
                         {"trigger", RecoveryTriggerName(snapshot.trigger)},
                         {"debounceMilliseconds",
                          trigger == RecoveryTrigger::displayChange
                              ? RecoveryPolicy::kDisplayChangeDebounceMs
                              : 0},
                         {"maximumAttempts", RecoveryPolicy::kMaximumAttempts}});
        Log::Warning("Display recovery generation {} started: {} ({})",
                     snapshot.generation, RecoveryTriggerName(snapshot.trigger), detail);
    }
}

void RendererApp::KeepOutputsBlack(const bool invalidateTiming, const bool force) noexcept {
    const auto now = std::chrono::steady_clock::now();
    const auto interval = recovery_.Exhausted() ? kExhaustedBlackRefreshInterval
                                                 : kRecoveryBlackRefreshInterval;
    if (!force && lastRecoveryBlackPresent_.time_since_epoch().count() != 0 &&
        now - lastRecoveryBlackPresent_ < interval) {
        return;
    }
    lastRecoveryBlackPresent_ = now;
    for (auto& output : outputs_) {
        if (invalidateTiming) output->MarkDisplayTimingRecovering();
        output->PresentBlack(graphics_);
    }
}

void RendererApp::ServiceRecovery() {
    const auto now = NowMilliseconds();
    if (!recovery_.BeginAttempt(now, true)) {
        KeepOutputsBlack();
        if (recovery_.Exhausted()) state_ = "display-recovery-exhausted";
        return;
    }

    const auto attempt = recovery_.Snapshot(now);
    state_ = "display-recovering";
    KeepOutputsBlack();
    pipe_.SendEvent({{"event", "display-recovery-attempt"},
                     {"generation", attempt.generation},
                     {"attempt", attempt.attempts},
                     {"maximumAttempts", attempt.maximumAttempts},
                     {"trigger", RecoveryTriggerName(attempt.trigger)},
                     {"recreateDevice", true}});

    try {
        // Build an entirely independent D3D/factory/Spout/output candidate.
        // This refreshes stale DXGI enumeration after hot-plug and also makes a
        // driver-reset recovery possible without restarting the process.
        D3DDevice rebuiltGraphics;
        // If the config omitted an adapter, pin the adapter that was actually
        // committed at startup. Hot-plug enumeration order must not migrate a
        // show to a different GPU behind the operator's back.
        const auto recoveryAdapter = config_.adapterLuid.value_or(graphics_.AdapterLuid());
        rebuiltGraphics.Create(recoveryAdapter);
        std::vector<std::unique_ptr<OutputSurface>> rebuilt;
        BuildOutputs(config_, rebuiltGraphics, rebuilt);
        RestoreRuntimeOverrides(rebuilt);
        SpoutInput rebuiltInput;
        rebuiltInput.Initialize(rebuiltGraphics.Device(), config_.compositionSource);
        // Recovery rebuilds the already committed config. Retain its exact
        // Node-supplied config receipt rather than synthesizing a new digest
        // from narrowed floats or resolved paths.
        auto rebuiltBinding = BuildActiveCorrectionBinding(
            config_, rebuilt, activeCorrectionBinding_.configSha256);

        // Candidate windows are created with a black class background and each
        // swapchain receives black during Initialize. Reassert black here before
        // the no-throw commit sequence; candidate validation never renders the
        // source texture or a calibration pattern.
        for (auto& output : rebuilt) output->ValidateBlackPresent(rebuiltGraphics);
        rebuiltGraphics.CheckRemoved();
        KeepOutputsBlack(false, true);

        // Everything above may fail while the old committed surfaces/binding
        // stay intact. The following swaps are non-throwing and replace the
        // complete output set as one main-loop transaction. Keep the retired
        // windows alive in `rebuilt` until the new black covers are installed.
        compositionInput_.Shutdown();
        outputs_.swap(rebuilt);
        graphics_.Swap(rebuiltGraphics);
        compositionInput_ = std::move(rebuiltInput);
        activeCorrectionBinding_ = std::move(rebuiltBinding);
        lastFrameStatisticsFlush_ = {};
        lastRecoveryBlackPresent_ = {};
        outputsHealthy_ = true;
        recovery_.Succeed(true);
        state_ = BootBlackLocked()
                     ? "boot-black-locked"
                     : (compositionInput_.IsValid() ? "running" : "input-degraded");
        const auto succeeded = recovery_.Snapshot(NowMilliseconds());
        pipe_.SendEvent({{"event", "display-recovery-succeeded"},
                         {"generation", succeeded.generation},
                         {"attempts", succeeded.attempts},
                         {"deviceRecreated", succeeded.deviceRecreated},
                         {"activeCorrectionFingerprint", activeCorrectionBinding_.fingerprint}});
        Log::Info("Display recovery generation {} succeeded after {} attempt(s)",
                  succeeded.generation, succeeded.attempts);
    } catch (const std::exception& error) {
        KeepOutputsBlack();
        recovery_.FailAttempt(NowMilliseconds(), error.what());
        const auto failed = recovery_.Snapshot(NowMilliseconds());
        state_ = failed.exhausted ? "display-recovery-exhausted" : "display-recovering";
        nlohmann::json event{
            {"event", failed.exhausted ? "display-recovery-exhausted"
                                        : "display-recovery-retry-scheduled"},
            {"generation", failed.generation},
            {"attempts", failed.attempts},
            {"maximumAttempts", failed.maximumAttempts},
            {"trigger", RecoveryTriggerName(failed.trigger)},
            {"message", error.what()},
        };
        event["retryInMilliseconds"] = failed.retryInMilliseconds
                                             ? nlohmann::json(*failed.retryInMilliseconds)
                                             : nlohmann::json(nullptr);
        pipe_.SendEvent(std::move(event));
        Log::Error("Display recovery generation {} attempt {}/{} failed: {}",
                   failed.generation, failed.attempts, failed.maximumAttempts, error.what());
    }
}

void RendererApp::RenderFrame() {
    if (BootBlackLocked()) {
        state_ = "boot-black-locked";
        KeepOutputsBlack();
        return;
    }
    if (!outputsHealthy_) {
        KeepOutputsBlack();
        return;
    }
    try {
        const auto composition = compositionInput_.Poll(graphics_.Device());
        const auto valid = compositionInput_.IsValid() && composition != nullptr;
        for (auto& output : outputs_) {
            output->Render(graphics_, config_.canvas, composition.Get(), valid,
                           config_.compositionSource.sourceIsSrgb);
        }
        const auto occluded = std::any_of(outputs_.begin(), outputs_.end(),
                                          [](const auto& output) { return output->IsOccluded(); });
        state_ = occluded ? "display-occluded" : (valid ? "running" : "input-degraded");
        graphics_.CheckRemoved();
    } catch (const std::exception& error) {
        pipe_.SendEvent({{"event", "render-error"}, {"message", error.what()}});
        Log::Error("Render frame failed closed: {}", error.what());
        const auto removalReason = graphics_.DeviceRemovedReason();
        const auto trigger = FAILED(removalReason) ? RecoveryTrigger::deviceRemoved
                                                   : RecoveryTrigger::renderFailure;
        const auto detail = FAILED(removalReason)
                                ? std::format("{}; deviceRemovalHresult=0x{:08X}", error.what(),
                                              static_cast<unsigned long>(removalReason))
                                : std::string(error.what());
        BeginRecovery(trigger, detail);
    }
}

void RendererApp::UpdateTelemetry() { UpdateTelemetry(true); }

void RendererApp::UpdateTelemetry(const bool publish) {
    const auto now = std::chrono::steady_clock::now();
    if (!recovery_.Active() &&
        (lastFrameStatisticsFlush_.time_since_epoch().count() == 0 ||
         now - lastFrameStatisticsFlush_ >= std::chrono::milliseconds(500))) {
        // Microsoft notes that Hardware Flip Queue can defer frame-statistics
        // updates until DwmFlush. Do this at a bounded telemetry cadence, not
        // on every Present, then re-query each swapchain's physical counters.
        (void)DwmFlush();
        for (auto& output : outputs_) output->RefreshDisplayTiming();
        lastFrameStatisticsFlush_ = now;
    }
    std::vector<OutputTelemetry> outputs;
    outputs.reserve(outputs_.size());
    for (const auto& output : outputs_) outputs.push_back(output->Snapshot());
    const auto ipcListener = pipe_.ListenerHealth();
    const auto reportedState = ipcListener.fatal
                                   ? std::string("ipc-listener-fatal")
                               : ipcListener.degraded
                                   ? std::string("ipc-listener-degraded")
                                   : state_;
    telemetry_.Update(config_.revision, config_.nodeId, reportedState, graphics_.AdapterName(),
                      graphics_.AdapterLuid(), compositionInput_.Status(),
                      ipcListener,
                      recovery_.Snapshot(NowMilliseconds()),
                      activeCorrectionBinding_, BootBlackLocked(),
                      bootBlackLock_.ReleaseCount(), std::move(outputs));
    if (publish) telemetry_.MaybePublish();
}

void RendererApp::BlankAll(const bool blank, const std::optional<std::string>& outputId) {
    bool matched = false;
    for (auto& output : outputs_) {
        if (!outputId || output->Id() == *outputId) {
            output->SetBlank(blank);
            matched = true;
        }
    }
    if (!matched) throw std::runtime_error("Unknown outputId");
    if (!outputId) newOutputBlank_ = blank;
}

void RendererApp::PatternAll(const PatternConfig& pattern,
                             const std::optional<std::string>& outputId) {
    if (outputId && std::none_of(outputs_.begin(), outputs_.end(), [&](const auto& output) {
            return output->Id() == *outputId;
        })) {
        throw std::runtime_error("Unknown outputId");
    }
    if (pattern.mode == PatternMode::grayCode) {
        for (const auto& output : outputs_) {
            if (outputId && output->Id() != *outputId) continue;
            const auto dimension = pattern.grayAxisY ? output->Resolution().height
                                                     : output->Resolution().width;
            const auto bits = static_cast<std::uint32_t>(std::bit_width(dimension - 1U));
            if (pattern.grayBit >= bits) {
                throw std::runtime_error("set-pattern.bit exceeds the selected output dimension");
            }
        }
    }
    // A targeted calibration/identify request isolates every peer to black.
    // Clearing that target must restore the complete composition; restoring
    // only the selected surface would leave every peer latched black.
    if (pattern.mode == PatternMode::content) {
        for (auto& output : outputs_) output->SetPattern(pattern);
        newOutputPattern_ = pattern;
        return;
    }
    for (auto& output : outputs_) {
        if (!outputId || output->Id() == *outputId) {
            output->SetPattern(pattern);
        } else if (pattern.mode != PatternMode::content) {
            PatternConfig black;
            black.mode = PatternMode::black;
            output->SetPattern(black);
        }
    }
    if (!outputId) {
        newOutputPattern_ = pattern;
    } else {
        newOutputPattern_ = {};
        newOutputPattern_.mode = PatternMode::black;
    }
}

void RendererApp::RestoreRuntimeOverrides(
    std::vector<std::unique_ptr<OutputSurface>>& destination) const {
    for (auto& next : destination) {
        const auto existing = std::find_if(outputs_.begin(), outputs_.end(), [&](const auto& active) {
            return active->Id() == next->Id();
        });
        PatternConfig pattern;
        if (existing != outputs_.end()) {
            next->SetBlank((*existing)->IsBlank());
            pattern = (*existing)->Pattern();
        } else {
            next->SetBlank(newOutputBlank_);
            pattern = newOutputPattern_;
        }
        if (pattern.mode == PatternMode::grayCode) {
            const auto dimension = pattern.grayAxisY ? next->Resolution().height
                                                     : next->Resolution().width;
            if (pattern.grayBit >= static_cast<std::uint32_t>(std::bit_width(dimension - 1U))) {
                // Never silently display the wrong structured-light bit after
                // a live mode change. Raw black is the safe deterministic
                // fallback until the controller issues a valid pattern.
                pattern = {};
                pattern.mode = PatternMode::black;
            }
        }
        next->SetPattern(pattern);
    }
}

nlohmann::json RendererApp::Capabilities() const {
    return {
        {"protocolVersion", 1}, {"version", PB_VERSION}, {"nodeId", config_.nodeId},
        {"backend", "d3d11-dxgi"}, {"compositionSource", "spout2"},
        {"oneSharedComposition", true}, {"maxOutputs", kMaxOutputs},
        {"maxWarpGrid", {{"columns", 128}, {"rows", 128}}},
        {"corrections", {"sourceViewport", "meshWarp", "edgeBlend", "blackMap", "mask", "rgbGamma", "lut3d"}},
        {"processingBypass", true},
        {"patterns", {{"modes", {"content", "black", "white", "gray", "red", "green", "blue",
                                    "grid", "identify", "solid", "gray-code"}},
                      {"rawCorrectionBypass", true}, {"targetIsolation", true},
                      {"applyCorrectionsModes", {"solid"}},
                      {"preservesWarp", true}, {"solidEncoding", "linear"},
                      {"grayCodeCoordinate", "physical-output-pixel"}}},
        {"compositionValidation",
         {{"frameRate", {{"settlingFrames", SpoutInput::kFrameRateSettlingFrames},
                           {"minimumToleranceFps", SpoutInput::kMinimumFrameRateToleranceFps},
                           {"relativeTolerance", SpoutInput::kRelativeFrameRateTolerance}}}}},
        {"failClosedBlack", true},
        {"bootBlackLock", {{"startsLocked", true}, {"authenticatedRelease", true},
                            {"lifetimeMutationAuthentication", true},
                            {"authenticatedConfigWhileLocked", true},
                            {"patternWhileLocked", false},
                            {"unblankWhileLocked", false},
                            {"oneTransitionPerProcess", true}}},
        {"ipcListenerRecovery",
         {{"bounded", true},
          {"initialRetryDelayMilliseconds",
           PipeListenerRecoveryPolicy::kInitialRetryDelayMs},
          {"maximumRetryDelayMilliseconds",
           PipeListenerRecoveryPolicy::kMaximumRetryDelayMs},
          {"maximumFailures", PipeListenerRecoveryPolicy::kMaximumFailures},
          {"fatalExitCode", kIpcListenerFatalExitCode}}},
        {"activeCorrectionBinding", {{"schemaVersion", 1}, {"algorithm", "sha256"},
                                      {"successOnlyCommit", true}, {"artifactBytesObserved", true}}},
        {"displayTiming", {{"source", "IDXGISwapChain::GetFrameStatistics"},
                            {"submissionCountersSeparate", true},
                            {"unavailableIsUnknown", true}}},
        {"displayRecovery", {{"inProcess", true},
                              {"exactDisplaySelectors", true},
                              {"candidateValidationBlack", true},
                              {"displayChangeDebounceMilliseconds",
                               RecoveryPolicy::kDisplayChangeDebounceMs},
                              {"maximumAttempts", RecoveryPolicy::kMaximumAttempts},
                              {"maximumRetryDelayMilliseconds",
                               RecoveryPolicy::kMaximumRetryDelayMs},
                              {"recreatesD3dAndSpout", true}}},
        {"hardwareBlackGuarantee", false},
    };
}

nlohmann::json RendererApp::ListDisplaysJson() {
    nlohmann::json result = nlohmann::json::array();
    for (const auto& display : DisplayRegistry::EnumerateActive()) {
        result.push_back({
            {"devicePath", Narrow(display.devicePath)}, {"gdiName", Narrow(display.gdiName)},
            {"friendlyName", Narrow(display.friendlyName)}, {"adapterLuid", LuidToString(display.adapterLuid)},
            {"sourceId", display.sourceId}, {"targetId", display.targetId},
            {"desktopRect", {{"left", display.desktopRect.left}, {"top", display.desktopRect.top},
                             {"right", display.desktopRect.right}, {"bottom", display.desktopRect.bottom}}},
            {"width", display.width}, {"height", display.height},
            {"refreshNum", display.refreshNum}, {"refreshDen", display.refreshDen}, {"active", display.active},
        });
    }
    return result;
}

} // namespace pbwin

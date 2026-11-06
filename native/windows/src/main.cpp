#include "pbwin/Config.hpp"
#include "pbwin/Digest.hpp"
#include "pbwin/Log.hpp"
#include "pbwin/RendererApp.hpp"

#include <Windows.h>
#include <shellapi.h>
#include <timeapi.h>

#include <cstdlib>
#include <algorithm>
#include <cctype>
#include <filesystem>
#include <fstream>
#include <optional>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

namespace {

std::optional<std::wstring> Environment(const wchar_t* name) {
    const auto required = GetEnvironmentVariableW(name, nullptr, 0);
    if (required == 0) return std::nullopt;
    std::wstring value(required, L'\0');
    const auto copied = GetEnvironmentVariableW(name, value.data(), required);
    if (copied == 0 || copied >= required) return std::nullopt;
    value.resize(copied);
    return value;
}

std::filesystem::path DefaultConfigPath() {
    if (const auto programData = Environment(L"ProgramData")) {
        return std::filesystem::path(*programData) / L"PixelBrightness" / L"renderer.json";
    }
    return L"C:\\ProgramData\\PixelBrightness\\renderer.json";
}

std::string BootBlackAuthorizationDigest() {
    constexpr auto environmentName = L"PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN";
    const auto rawWide = Environment(environmentName);
    // Renderer retains only a digest. Removing the inherited plaintext value
    // also keeps child processes or diagnostics launched by Renderer from
    // inheriting the one-show authorization secret.
    SetEnvironmentVariableW(environmentName, nullptr);
    if (!rawWide) {
        throw std::runtime_error(
            "PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN is required for fail-closed startup");
    }
    auto raw = pbwin::Narrow(*rawWide);
    if (raw.size() < 43 || raw.size() > 128 ||
        !std::all_of(raw.begin(), raw.end(), [](const unsigned char character) {
            return std::isalnum(character) || character == '_' || character == '-';
        })) {
        throw std::runtime_error(
            "PIXEL_BRIGHTNESS_RENDERER_BOOT_TOKEN must be 43-128 base64url characters");
    }
    const auto digest = pbwin::Sha256Hex(raw);
    SecureZeroMemory(raw.data(), raw.size());
    return digest;
}

void WriteParentConsole(const std::string& text) {
    AttachConsole(ATTACH_PARENT_PROCESS);
    const auto output = GetStdHandle(STD_OUTPUT_HANDLE);
    if (output && output != INVALID_HANDLE_VALUE) {
        DWORD written{};
        WriteFile(output, text.data(), static_cast<DWORD>(text.size()), &written, nullptr);
        WriteFile(output, "\r\n", 2, &written, nullptr);
    }
}

void WriteJsonAtomic(const std::filesystem::path& path, const std::string& text) {
    if (path.empty()) throw std::runtime_error("--list-displays-file path is empty");
    if (path.has_parent_path()) std::filesystem::create_directories(path.parent_path());
    auto temporary = path;
    temporary += L".tmp";
    {
        std::ofstream stream(temporary, std::ios::binary | std::ios::trunc);
        if (!stream) throw std::runtime_error("Unable to create display inventory file");
        stream.write(text.data(), static_cast<std::streamsize>(text.size()));
        stream.put('\n');
        stream.flush();
        if (!stream) throw std::runtime_error("Unable to flush display inventory file");
    }
    if (!MoveFileExW(temporary.c_str(), path.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        throw std::runtime_error("Unable to publish display inventory file: " + std::to_string(GetLastError()));
    }
}

} // namespace

int WINAPI wWinMain(const HINSTANCE instance, HINSTANCE, PWSTR, int) {
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    SetPriorityClass(GetCurrentProcess(), HIGH_PRIORITY_CLASS);
    timeBeginPeriod(1);
    const auto comResult = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    int exitCode = 1;
    try {
        int argumentCount{};
        auto arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
        if (!arguments) throw std::runtime_error("CommandLineToArgvW failed");
        std::filesystem::path configPath = Environment(L"PIXEL_BRIGHTNESS_RENDERER_CONFIG")
                                               .value_or(DefaultConfigPath().wstring());
        std::optional<std::wstring> pipeOverride = Environment(L"PIXEL_BRIGHTNESS_RENDERER_PIPE");
        std::optional<std::string> nodeOverride;
        if (const auto value = Environment(L"PIXEL_BRIGHTNESS_NODE_ID")) nodeOverride = pbwin::Narrow(*value);
        bool listDisplays{};
        std::optional<std::filesystem::path> listDisplaysFile;
        for (int index = 1; index < argumentCount; ++index) {
            const std::wstring argument = arguments[index];
            if (argument == L"--list-displays") {
                listDisplays = true;
            } else if ((argument == L"--config" || argument == L"--pipe" || argument == L"--node-id" ||
                        argument == L"--list-displays-file") &&
                       index + 1 < argumentCount) {
                const std::wstring value = arguments[++index];
                if (argument == L"--config") configPath = value;
                if (argument == L"--pipe") pipeOverride = value;
                if (argument == L"--node-id") nodeOverride = pbwin::Narrow(value);
                if (argument == L"--list-displays-file") {
                    listDisplays = true;
                    listDisplaysFile = value;
                }
            } else {
                throw std::runtime_error("Unknown or incomplete command-line option: " + pbwin::Narrow(argument));
            }
        }
        LocalFree(arguments);
        if (listDisplays) {
            const auto inventory = pbwin::RendererApp::ListDisplaysJson().dump(2);
            if (listDisplaysFile) WriteJsonAtomic(*listDisplaysFile, inventory);
            else WriteParentConsole(inventory);
            exitCode = 0;
        } else {
            auto config = pbwin::ConfigLoader::LoadFile(configPath);
            if (nodeOverride) {
                if (nodeOverride->empty() || nodeOverride->size() > 64 ||
                    !std::all_of(nodeOverride->begin(), nodeOverride->end(), [](const unsigned char character) {
                        return std::isalnum(character) || character == '.' || character == '_' || character == '-';
                    })) throw std::runtime_error("--node-id contains unsupported characters");
                config.nodeId = *nodeOverride;
                if (!pipeOverride) config.pipeName = pbwin::ConfigLoader::DefaultPipeName(config.nodeId);
            }
            if (pipeOverride) {
                constexpr std::wstring_view pipePrefix = L"\\\\.\\pipe\\";
                if (!pipeOverride->starts_with(pipePrefix) || pipeOverride->size() == pipePrefix.size() ||
                    pipeOverride->size() > 256) {
                    throw std::runtime_error("--pipe must be a local Windows named-pipe path");
                }
                config.pipeName = *pipeOverride;
            }
            pbwin::RendererApp app(instance, BootBlackAuthorizationDigest());
            exitCode = app.Run(std::move(config));
        }
    } catch (const std::exception& error) {
        pbwin::Log::Error("Fatal renderer error: {}", error.what());
        // This is an unattended show process supervised by the interactive
        // launcher. A modal MessageBox would keep the failed process alive,
        // cover a projector, and prevent the supervisor from restarting it.
        exitCode = 1;
    }
    if (SUCCEEDED(comResult)) CoUninitialize();
    timeEndPeriod(1);
    return exitCode;
}

#include "pbwin/Win32Window.hpp"

#include "pbwin/Log.hpp"

#include <stdexcept>
#include <utility>

namespace pbwin {
namespace {

constexpr wchar_t kWindowClass[] = L"PixelBrightness.OutputWindow.v1";

} // namespace

Win32Window::~Win32Window() { Destroy(); }

Win32Window::Win32Window(Win32Window&& other) noexcept
    : window_(std::exchange(other.window_, nullptr)), desktopRect_(other.desktopRect_) {}

Win32Window& Win32Window::operator=(Win32Window&& other) noexcept {
    if (this != &other) {
        Destroy();
        window_ = std::exchange(other.window_, nullptr);
        desktopRect_ = other.desktopRect_;
    }
    return *this;
}

void Win32Window::Register(const HINSTANCE instance) {
    WNDCLASSEXW windowClass{};
    windowClass.cbSize = sizeof(windowClass);
    windowClass.style = CS_OWNDC;
    windowClass.lpfnWndProc = WindowProc;
    windowClass.hInstance = instance;
    windowClass.hCursor = nullptr;
    windowClass.hbrBackground = static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
    windowClass.lpszClassName = kWindowClass;
    if (!RegisterClassExW(&windowClass) && GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
        throw std::runtime_error("RegisterClassExW failed: " + std::to_string(GetLastError()));
    }
}

void Win32Window::Create(const std::wstring& title, const RECT& desktopRect, const bool topmost) {
    Destroy();
    desktopRect_ = desktopRect;
    const auto exStyle = WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | (topmost ? WS_EX_TOPMOST : 0);
    window_ = CreateWindowExW(exStyle, kWindowClass, title.c_str(), WS_POPUP,
                              desktopRect.left, desktopRect.top,
                              desktopRect.right - desktopRect.left,
                              desktopRect.bottom - desktopRect.top,
                              nullptr, nullptr, GetModuleHandleW(nullptr), this);
    if (!window_) throw std::runtime_error("CreateWindowExW failed: " + std::to_string(GetLastError()));
    if (!SetWindowPos(window_, topmost ? HWND_TOPMOST : HWND_TOP,
                      desktopRect.left, desktopRect.top,
                      desktopRect.right - desktopRect.left,
                      desktopRect.bottom - desktopRect.top,
                      SWP_NOACTIVATE)) {
        const auto error = GetLastError();
        Destroy();
        throw std::runtime_error("SetWindowPos failed: " + std::to_string(error));
    }
}

void Win32Window::Show() {
    ShowWindow(window_, SW_SHOWNOACTIVATE);
    UpdateWindow(window_);
}

void Win32Window::Destroy() noexcept {
    if (window_) {
        DestroyWindow(window_);
        window_ = nullptr;
    }
}

LRESULT CALLBACK Win32Window::WindowProc(const HWND window, const UINT message,
                                         const WPARAM wParam, const LPARAM lParam) {
    switch (message) {
    case WM_ERASEBKGND: {
        RECT client{};
        GetClientRect(window, &client);
        FillRect(reinterpret_cast<HDC>(wParam), &client,
                 static_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
        return 1;
    }
    case WM_SETCURSOR:
        SetCursor(nullptr);
        return TRUE;
    case WM_SYSCOMMAND:
        if ((wParam & 0xFFF0) == SC_SCREENSAVE || (wParam & 0xFFF0) == SC_MONITORPOWER) return 0;
        break;
    case WM_CLOSE:
        PostQuitMessage(0);
        return 0;
    case WM_QUERYENDSESSION:
        return TRUE;
    case WM_ENDSESSION:
        if (wParam) PostQuitMessage(0);
        return 0;
    default:
        break;
    }
    return DefWindowProcW(window, message, wParam, lParam);
}

} // namespace pbwin

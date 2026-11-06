#pragma once

#include <Windows.h>

#include <string>

namespace pbwin {

class Win32Window final {
public:
    Win32Window() = default;
    ~Win32Window();
    Win32Window(const Win32Window&) = delete;
    Win32Window& operator=(const Win32Window&) = delete;
    Win32Window(Win32Window&& other) noexcept;
    Win32Window& operator=(Win32Window&& other) noexcept;

    void Create(const std::wstring& title, const RECT& desktopRect, bool topmost);
    void Show();
    void Destroy() noexcept;

    [[nodiscard]] HWND Handle() const noexcept { return window_; }
    [[nodiscard]] const RECT& DesktopRect() const noexcept { return desktopRect_; }

    static void Register(HINSTANCE instance);
    static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wParam, LPARAM lParam);

private:
    HWND window_{};
    RECT desktopRect_{};
};

} // namespace pbwin

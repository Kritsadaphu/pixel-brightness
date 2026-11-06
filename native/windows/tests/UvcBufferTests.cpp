#include "pbwin/UvcBuffer.hpp"
#include <iostream>
#include <functional>

void Require(bool value) { if (!value) throw std::runtime_error("UVC buffer assertion failed"); }
void Reject(const std::function<void()>& f) {
  bool rejected = false; try { f(); } catch (const std::runtime_error&) { rejected = true; }
  Require(rejected);
}
int main() {
  try {
    const std::uint8_t data[] = {0,0,255,0, 0,255,0,0, 9,9,9,9,
                              255,0,0,0, 255,255,255,0, 9,9,9,9};
    Require(pbwin::UvcRgb24(data,24,0,12,2,2) ==
      std::vector<std::uint8_t>({255,0,0,0,255,0,0,0,255,255,255,255}));
    Require(pbwin::UvcRgb24(data,24,12,-12,2,2) ==
      std::vector<std::uint8_t>({0,0,255,255,255,255,255,0,0,0,255,0}));
    Reject([&]{pbwin::UvcRgb24(data,24,0,-12,2,2);});
    Reject([&]{pbwin::UvcRgb24(data,19,0,12,2,2);});
    Reject([&]{pbwin::UvcRgb24(data,24,0,4,2,2);});
    Reject([&]{pbwin::UvcRgb24(data,24,0,12,0,2);});
    Reject([&]{pbwin::UvcRgb24(data,24,25,12,2,2);});
    std::cout << "UVC: RGB order, top-down, bottom-up, row padding and bounds passed\n";
    return 0;
  } catch (const std::exception& e) { std::cerr << e.what(); return 1; }
}

#include "pbwin/BootBlackLock.hpp"

#include <cassert>
#include <stdexcept>
#include <string>

int main() {
    const std::string expected(64, 'a');
    pbwin::BootBlackLock lock(expected);
    assert(lock.Locked());
    assert(lock.ReleaseCount() == 0);

    assert(!lock.Authorize(std::string(64, 'b')));
    assert(lock.Authorize(expected));
    assert(lock.Locked());
    assert(lock.ReleaseCount() == 0);

    assert(lock.Release(std::string(64, 'b')) == pbwin::BootBlackReleaseResult::unauthorized);
    assert(lock.Locked());
    assert(lock.ReleaseCount() == 0);

    assert(lock.Release(expected) == pbwin::BootBlackReleaseResult::released);
    assert(!lock.Locked());
    assert(lock.ReleaseCount() == 1);

    assert(lock.Release(expected) == pbwin::BootBlackReleaseResult::alreadyReleased);
    assert(!lock.Locked());
    assert(lock.ReleaseCount() == 1);

    bool invalidRejected{};
    try {
        pbwin::BootBlackLock invalid("not-a-digest");
    } catch (const std::invalid_argument&) {
        invalidRejected = true;
    }
    assert(invalidRejected);
    return 0;
}

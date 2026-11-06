#include "pbwin/LatestSnapshotMailbox.hpp"

#include <atomic>
#include <chrono>
#include <iostream>
#include <memory>
#include <stdexcept>
#include <thread>

namespace {

void Require(const bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

} // namespace

int main() {
    try {
        using Mailbox = pbwin::LatestSnapshotMailbox<int>;
        static_assert(Mailbox::kCapacity == 1);

        Mailbox mailbox;
        Require(mailbox.TryPublish(std::make_shared<const int>(1)) ==
                    Mailbox::PublishResult::accepted,
                "first snapshot was not accepted");
        Require(mailbox.TryPublish(std::make_shared<const int>(2)) ==
                    Mailbox::PublishResult::coalesced,
                "new snapshot did not coalesce the stale pending value");
        Require(mailbox.TryDepth() == 1,
                "latest-only mailbox exceeded or hid its one-value bound");
        const auto latest = mailbox.WaitTake();
        Require(latest && *latest == 2,
                "consumer did not receive exactly the newest snapshot");
        Require(mailbox.TryDepth() == 0,
                "mailbox depth did not return to zero after take");

        std::atomic_bool waiterReturned{};
        std::thread waiter([&] {
            const auto value = mailbox.WaitTake();
            Require(!value, "closed empty mailbox returned a value");
            waiterReturned.store(true);
        });
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
        Require(!mailbox.CloseAndDiscard(),
                "empty shutdown incorrectly reported a discarded snapshot");
        waiter.join();
        Require(waiterReturned.load(), "shutdown did not wake the consumer");
        Require(mailbox.TryPublish(std::make_shared<const int>(3)) ==
                    Mailbox::PublishResult::closed,
                "closed mailbox accepted another snapshot");

        Mailbox pending;
        Require(pending.TryPublish(std::make_shared<const int>(4)) ==
                    Mailbox::PublishResult::accepted,
                "pending shutdown fixture was not accepted");
        Require(pending.CloseAndDiscard(),
                "shutdown did not report its one discarded snapshot");
        Require(!pending.WaitTake(), "shutdown retained a stale snapshot");

        std::cout << "pbwin latest snapshot mailbox tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pbwin latest snapshot mailbox tests failed: "
                  << error.what() << '\n';
        return 1;
    }
}

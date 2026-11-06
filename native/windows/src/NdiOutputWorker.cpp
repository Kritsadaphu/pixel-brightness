#include "pbwin/NdiOutputWorker.hpp"
#include <chrono>

namespace pbwin {
NdiOutputWorker::NdiOutputWorker(const std::string& name) {
    std::promise<NdiSourceIdentity> ready;
    auto future = ready.get_future();
    thread_ = std::jthread([this, name, ready = std::move(ready)]() mutable { Run(name, std::move(ready)); });
    identity_ = future.get();
}
NdiOutputWorker::~NdiOutputWorker() {
    { std::scoped_lock lock(mutex_); closed_ = true; pending_.reset(); }
    wake_.notify_one();
    if (thread_.joinable()) thread_.join();
}
void NdiOutputWorker::Check() const {
    std::scoped_lock lock(mutex_);
    if (failure_) std::rethrow_exception(failure_);
}
void NdiOutputWorker::Send(NetworkVideoFrame frame) {
    frame.Validate();
    { std::scoped_lock lock(mutex_);
      if (failure_) std::rethrow_exception(failure_);
      if (closed_) throw std::runtime_error("NDI worker is closed");
      if (pending_) {
          ++replaced_;
          if (recycled_.empty()) recycled_ = std::move(pending_->rgba);
      }
      pending_ = std::move(frame);
    }
    wake_.notify_one();
}
std::vector<std::uint8_t> NdiOutputWorker::TakeRecycledBuffer() {
    std::vector<std::uint8_t> buffer;
    std::scoped_lock lock(mutex_);
    buffer.swap(recycled_);
    return buffer;
}
void NdiOutputWorker::DiscardPending() {
    std::scoped_lock lock(mutex_);
    if (pending_) { pending_.reset(); ++replaced_; }
}
void NdiOutputWorker::Stop(NetworkVideoFrame black) {
    if (blackSubmitted_) return;
    { std::scoped_lock lock(mutex_);
      pending_.reset(); stopping_ = std::move(black); closed_ = true;
    }
    wake_.notify_one();
    if (thread_.joinable()) thread_.join();
    Check();
    if (!blackSubmitted_) throw std::runtime_error("NDI worker did not complete black submissions");
}
void NdiOutputWorker::Run(std::string name, std::promise<NdiSourceIdentity> ready) noexcept {
    try {
        NdiSender sender(name);
        ready.set_value(sender.SourceIdentity());
        while (true) {
            std::optional<NetworkVideoFrame> frame;
            bool stopping = false;
            {
                std::unique_lock lock(mutex_);
                wake_.wait(lock, [&] { return closed_ || pending_.has_value(); });
                if (stopping_) { frame = std::move(stopping_); stopping_.reset(); stopping = true; }
                else if (closed_) break;
                else { frame = std::move(pending_); pending_.reset(); }
            }
            if (!frame) continue;
            const int count = stopping ? 3 : 1;
            for (int i = 0; i < count; ++i) {
                sender.Send(*frame); ++sent_;
                connections_ = sender.ConnectionCount();
                if (stopping) { ++frame->sequence; frame->timecode += 10000; }
            }
            if (stopping) { blackSubmitted_ = true; break; }
            // NdiSender::Send uses synchronous NDIlib_send_send_video_v2.
            // The SDK no longer borrows the raster after it returns.
            { std::scoped_lock lock(mutex_);
              if (recycled_.empty()) recycled_ = std::move(frame->rgba);
            }
        }
    } catch (...) {
        const auto error = std::current_exception();
        { std::scoped_lock lock(mutex_); failure_ = error; closed_ = true; pending_.reset(); }
        try { ready.set_exception(error); } catch (...) {}
    }
}
}

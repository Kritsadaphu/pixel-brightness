#include "pbwin/NdiSender.hpp"

#include <Processing.NDI.Lib.h>
#include <atomic>
#include <mutex>
#include <optional>
#include <thread>

namespace pbwin {
namespace {
std::mutex runtimeMutex;
std::size_t runtimeUsers{};

}
NdiRuntimeLease::NdiRuntimeLease() {
    std::lock_guard lock(runtimeMutex);
    if (!runtimeUsers && !NDIlib_initialize())
        throw std::runtime_error("NDI runtime initialization failed");
    ++runtimeUsers;
}
NdiRuntimeLease::~NdiRuntimeLease() {
    std::lock_guard lock(runtimeMutex);
    if (!--runtimeUsers) NDIlib_destroy();
}

struct NdiSender::Impl {
    NdiRuntimeLease runtime;
    NDIlib_send_instance_t sender{};
    std::thread::id owner{std::this_thread::get_id()};
    std::atomic<std::uint64_t> submissions{};
    std::optional<std::uint64_t> lastSequence;
    std::int64_t lastTimecode{};

    explicit Impl(const std::string& name) {
        NDIlib_send_create_t config{};
        config.p_ndi_name = name.c_str();
        config.clock_video = false; // One external composition clock for all outputs.
        config.clock_audio = false;
        sender = NDIlib_send_create(&config);
        if (!sender) throw std::runtime_error("NDI sender creation failed");
    }
    ~Impl() { if (sender) NDIlib_send_destroy(sender); }
    void CheckOwner() const {
        if (owner != std::this_thread::get_id())
            throw std::logic_error("NDI sender must stay on its transport thread");
    }
};

NdiSender::NdiSender(const std::string& name) {
    if (name.empty() || name.size() > 200 || name.find_first_of("\r\n") != std::string::npos ||
        name.find('\0') != std::string::npos)
        throw std::invalid_argument("Invalid NDI source name");
    impl_ = std::make_unique<Impl>(name);
}
NdiSender::~NdiSender() = default;

void NdiSender::Send(const NetworkVideoFrame& frame) {
    impl_->CheckOwner();
    frame.Validate();
    if (frame.width % 2) throw std::invalid_argument("NDI video width must be even");
    if (impl_->lastSequence && (frame.sequence <= *impl_->lastSequence ||
                               frame.timecode < impl_->lastTimecode))
        throw std::invalid_argument("NDI frame order regressed");
    NDIlib_video_frame_v2_t video{};
    video.xres = static_cast<int>(frame.width);
    video.yres = static_cast<int>(frame.height);
    video.FourCC = NDIlib_FourCC_type_RGBA;
    video.frame_rate_N = static_cast<int>(frame.frameRateNum);
    video.frame_rate_D = static_cast<int>(frame.frameRateDen);
    video.picture_aspect_ratio = static_cast<float>(frame.width) / frame.height;
    video.frame_format_type = NDIlib_frame_format_type_progressive;
    video.timecode = frame.timecode;
    video.p_data = const_cast<std::uint8_t*>(frame.rgba.data());
    video.line_stride_in_bytes = static_cast<int>(frame.width * 4);
    NDIlib_send_send_video_v2(impl_->sender, &video);
    impl_->lastSequence = frame.sequence;
    impl_->lastTimecode = frame.timecode;
    ++impl_->submissions; // SDK has no per-frame delivery acknowledgement.
}
std::uint64_t NdiSender::SubmissionCalls() const noexcept {
    return impl_->submissions.load(std::memory_order_relaxed);
}
int NdiSender::ConnectionCount() const {
    impl_->CheckOwner();
    return NDIlib_send_get_no_connections(impl_->sender, 0);
}
NdiSourceIdentity NdiSender::SourceIdentity() const {
    impl_->CheckOwner();
    const auto* source = NDIlib_send_get_source_name(impl_->sender);
    if (!source || !source->p_ndi_name || !*source->p_ndi_name)
        throw std::runtime_error("NDI source identity is unavailable");
    return {source->p_ndi_name, source->p_url_address ? source->p_url_address : ""};
}
} // namespace pbwin

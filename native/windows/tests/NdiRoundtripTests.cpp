#include <windows.h>
#include <Processing.NDI.Lib.h>
#include "pbwin/NdiSender.hpp"
#include "pbwin/OffscreenOutput.hpp"
#include "pbwin/D3DDevice.hpp"
#include "pbwin/Log.hpp"
#include <array>
#include <chrono>
#include <cmath>
#include <functional>
#include <iostream>
#include <stdexcept>
#include <thread>

using namespace pbwin;
namespace {
unsigned testWidth=320,testHeight=180;
void Require(bool ok, const char* message) { if (!ok) throw std::runtime_error(message); }
void Reject(const std::function<void()>& action) {
    bool rejected = false;
    try { action(); } catch (const std::invalid_argument&) { rejected = true; }
    Require(rejected,"Invalid NDI frame was accepted");
}
struct Receiver {
    NdiSourceIdentity identity;
    NDIlib_recv_instance_t handle{};
    explicit Receiver(const NdiSourceIdentity& source) : identity(source) {
        NDIlib_recv_create_v3_t config{};
        config.source_to_connect_to.p_ndi_name = identity.name.c_str();
        config.source_to_connect_to.p_url_address = identity.address.empty() ? nullptr : identity.address.c_str();
        config.color_format = NDIlib_recv_color_format_RGBX_RGBA;
        config.bandwidth = NDIlib_recv_bandwidth_highest;
        config.allow_video_fields = false;
        config.p_ndi_recv_name = "Pixel isolated SDK roundtrip verification";
        handle = NDIlib_recv_create_v3(&config);
        Require(handle!=nullptr,"NDI receiver creation failed");
    }
    ~Receiver() { if(handle) NDIlib_recv_destroy(handle); }
    Receiver(const Receiver&) = delete;
    Receiver& operator=(const Receiver&) = delete;
};
NetworkVideoFrame Frame(std::uint64_t sequence, std::array<std::uint8_t,3> color) {
    NetworkVideoFrame f;
    f.width=testWidth; f.height=testHeight; f.frameRateNum=60000; f.frameRateDen=1001;
    f.sequence=sequence; f.timecode=static_cast<std::int64_t>(sequence*10000000ULL*1001/60000);
    f.rgba.resize(NetworkVideoFrame::ByteCount(f.width,f.height));
    for(std::size_t i=0;i<f.rgba.size();i+=4) {
        f.rgba[i]=color[0]; f.rgba[i+1]=color[1]; f.rgba[i+2]=color[2]; f.rgba[i+3]=255;
    }
    return f;
}
struct ReceiveResult { bool matches{}; std::int64_t timecode{}; };
ReceiveResult Read(Receiver& receiver, std::array<std::uint8_t,3> color,
                   std::int64_t minimumTimecode, std::int64_t maximumTimecode) {
    NDIlib_video_frame_v2_t video{};
    const auto kind=NDIlib_recv_capture_v3(receiver.handle,&video,nullptr,nullptr,10);
    if(kind==NDIlib_frame_type_error) throw std::runtime_error("NDI receive error");
    if(kind!=NDIlib_frame_type_video) return {};
    ReceiveResult result;
    try {
        Require(video.xres==static_cast<int>(testWidth) && video.yres==static_cast<int>(testHeight),"NDI frame dimensions changed");
        Require(video.frame_rate_N==60000 && video.frame_rate_D==1001,"NDI rational cadence changed");
        Require(video.frame_format_type==NDIlib_frame_format_type_progressive,"NDI frame is not progressive");
        Require(video.FourCC==NDIlib_FourCC_type_RGBX || video.FourCC==NDIlib_FourCC_type_RGBA,
                "NDI receiver did not return RGBX/RGBA");
        Require(video.p_data && video.line_stride_in_bytes>=video.xres*4,"NDI frame layout invalid");
        Require(video.timecode>=0 && video.timecode<=maximumTimecode,"NDI sender timecode was not preserved");
        const auto* pixel=video.p_data+(video.yres/2)*video.line_stride_in_bytes+(video.xres/2)*4;
        // NDI high bandwidth is not a mathematically lossless RGB transport.
        // Check broad channel correctness, not bit-perfect compression output.
        result.matches=video.timecode>=minimumTimecode;
        for(int c=0;c<3;++c) result.matches &= std::abs(static_cast<int>(pixel[c])-color[c])<=20;
        result.timecode=video.timecode;
    } catch(...) { NDIlib_recv_free_video_v2(receiver.handle,&video); throw; }
    NDIlib_recv_free_video_v2(receiver.handle,&video);
    return result;
}
struct GpuPipeline {
    D3DDevice gpu;
    OffscreenOutput a,b;
    GpuPipeline() {
        gpu.Create(std::nullopt);
        std::cout << "GPU: " << gpu.AdapterName() << '\n';
        CanvasConfig canvas{testWidth*2,testHeight,60000,1001};
        OutputConfig output;
        output.id="ndi-test-left";
        output.resolution={testWidth,testHeight,60000,1001};
        output.sourceViewport={0,0,static_cast<float>(testWidth),static_cast<float>(testHeight)};
        output.blendEnabled=false;
        a.Initialize(gpu.Device(),output,canvas,PB_TEST_SHADER_DIR,{});
        output.id="ndi-test-right";
        output.sourceViewport.x=static_cast<float>(testWidth);
        b.Initialize(gpu.Device(),output,canvas,PB_TEST_SHADER_DIR,{});
    }
    std::array<NetworkVideoFrame,2> Render(std::array<std::uint8_t,3> left,
                                         std::array<std::uint8_t,3> right,bool blank) {
        std::vector<std::uint8_t> pixels(static_cast<std::size_t>(testWidth)*2*testHeight*4);
        for(unsigned y=0;y<testHeight;++y) for(unsigned x=0;x<testWidth*2;++x) {
            const auto i=(static_cast<std::size_t>(y)*testWidth*2+x)*4;
            const auto& c=x<testWidth?left:right;
            pixels[i]=c[0];pixels[i+1]=c[1];pixels[i+2]=c[2];pixels[i+3]=255;
        }
        D3D11_TEXTURE2D_DESC desc{};
        desc.Width=testWidth*2;desc.Height=testHeight;desc.MipLevels=1;desc.ArraySize=1;
        desc.Format=DXGI_FORMAT_R8G8B8A8_UNORM;desc.SampleDesc.Count=1;
        desc.Usage=D3D11_USAGE_IMMUTABLE;desc.BindFlags=D3D11_BIND_SHADER_RESOURCE;
        D3D11_SUBRESOURCE_DATA data{pixels.data(),testWidth*2*4,0};
        Microsoft::WRL::ComPtr<ID3D11Texture2D> texture;
        Microsoft::WRL::ComPtr<ID3D11ShaderResourceView> view;
        ThrowIfFailed(gpu.Device()->CreateTexture2D(&desc,&data,&texture),"NDI test texture");
        ThrowIfFailed(gpu.Device()->CreateShaderResourceView(texture.Get(),nullptr,&view),"NDI test SRV");
        a.DiscardPending();b.DiscardPending();
        Require(a.Submit(gpu.Context(),view.Get(),true,true,{},blank,1,1000),"GPU submit A failed");
        Require(b.Submit(gpu.Context(),view.Get(),true,true,{},blank,1,1000),"GPU submit B failed");
        std::optional<NetworkVideoFrame> fa,fb;
        const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(5);
        while(std::chrono::steady_clock::now()<deadline && (!fa || !fb)) {
            if(!fa) fa=a.TryReadback(gpu.Context());
            if(!fb) fb=b.TryReadback(gpu.Context());
            if(!fa || !fb) std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
        Require(fa.has_value() && fb.has_value(),"GPU readback timeout");
        return {std::move(*fa),std::move(*fb)};
    }
};
}
int main(int argc,char** argv) {
    try {
        const bool withGpu=argc==2 && std::string(argv[1])=="--gpu-full-hd";
        if(argc!=1 && !withGpu) throw std::invalid_argument("Usage: pbwin-ndi-roundtrip-tests [--gpu-full-hd]");
        std::unique_ptr<GpuPipeline> pipeline;
        if(withGpu) { testWidth=1920;testHeight=1080;pipeline=std::make_unique<GpuPipeline>(); }
        const auto prefix="PB-DEV-VERIFY-"+std::to_string(GetCurrentProcessId());
        NdiSender first(prefix+"-A"),second(prefix+"-B");
        Receiver ra(first.SourceIdentity()),rb(second.SourceIdentity());
        std::cout << "SDK: " << NDIlib_version() << '\n';
        std::cout << "Sources: " << ra.identity.name << " / " << rb.identity.name << '\n';
        Require(ra.identity.name!=rb.identity.name,"NDI source identities collided");
        auto invalid=Frame(0,{255,0,0}); invalid.width=319;
        Reject([&]{first.Send(invalid);});
        invalid=Frame(0,{255,0,0}); invalid.frameRateDen=0;
        Reject([&]{first.Send(invalid);});
        Require(first.SubmissionCalls()==0,"Invalid NDI frame reached SDK");

        std::uint64_t sequence=0;
        const std::array<std::array<std::uint8_t,3>,3> colorsA={{{255,0,0},{0,255,0},{0,0,0}}};
        const std::array<std::array<std::uint8_t,3>,3> colorsB={{{0,0,255},{255,255,255},{0,0,0}}};
        for(std::size_t phase=0;phase<colorsA.size();++phase) {
            const auto firstTime=Frame(sequence,colorsA[phase]).timecode;
            auto rendered=pipeline?pipeline->Render(colorsA[phase],colorsB[phase],phase==2):
                std::array<NetworkVideoFrame,2>{Frame(sequence,colorsA[phase]),Frame(sequence,colorsB[phase])};
            const auto deadline=std::chrono::steady_clock::now()+std::chrono::seconds(9);
            unsigned matchedA=0,matchedB=0;
            while(std::chrono::steady_clock::now()<deadline && (matchedA<4 || matchedB<4)) {
                auto& a=rendered[0];auto& b=rendered[1];
                a.sequence=sequence;b.sequence=sequence;
                a.timecode=static_cast<std::int64_t>(sequence*10000000ULL*1001/60000);b.timecode=a.timecode;
                first.Send(a); second.Send(b); ++sequence;
                auto resultA=Read(ra,colorsA[phase],firstTime,a.timecode);
                auto resultB=Read(rb,colorsB[phase],firstTime,b.timecode);
                if(resultA.matches) ++matchedA;
                if(resultB.matches) ++matchedB;
                std::this_thread::sleep_for(std::chrono::milliseconds(16));
            }
            Require(matchedA>=4 && matchedB>=4,"NDI phase did not arrive on both local receivers");
            std::cout << "phase " << phase << ": A=" << matchedA << " B=" << matchedB << " matched\n";
        }
        auto duplicate=Frame(sequence-1,{0,0,0});
        Reject([&]{first.Send(duplicate);});
        auto regress=Frame(sequence,{0,0,0}); regress.timecode=0;
        Reject([&]{first.Send(regress);});
        Require(first.ConnectionCount()>=1 && second.ConnectionCount()>=1,"Local NDI receivers disconnected");
        std::cout << "PASS: 2 local SDK channels, RGB order, rational fps, timecode range, black transitions and validation.\n";
        if(withGpu) std::cout << "PASS: GPU correction shader + separate 1920x1080 crops + readback + NDI local receivers.\n";
        std::cout << "NOT tested: Magewell, projector sync, sustained throughput, Spout or live calibration.\n";
        return 0;
    } catch(const std::exception& e) { std::cerr << "FAIL: " << e.what() << '\n'; return 1; }
}

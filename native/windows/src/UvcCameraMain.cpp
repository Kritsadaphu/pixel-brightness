#include <windows.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <dshow.h>
#include <wrl/client.h>
#include <nlohmann/json.hpp>
#include <io.h>
#include <fcntl.h>
#include <chrono>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include "pbwin/UvcBuffer.hpp"

using Microsoft::WRL::ComPtr;
using Json = nlohmann::json;
namespace {
void Check(HRESULT hr, const char* operation) {
  if (FAILED(hr)) {
    std::ostringstream s; s << operation << " failed (0x" << std::hex << static_cast<unsigned long>(hr) << ")";
    throw std::runtime_error(s.str());
  }
}
std::string Utf8(const std::wstring& s) {
  if (s.empty()) return {};
  const int n = WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, s.data(), static_cast<int>(s.size()), nullptr,0,nullptr,nullptr);
  if (!n) throw std::runtime_error("Invalid device string");
  std::string out(n, '\0');
  WideCharToMultiByte(CP_UTF8,0,s.data(),static_cast<int>(s.size()),out.data(),n,nullptr,nullptr);
  return out;
}
std::wstring Attribute(IMFAttributes* attrs, REFGUID key) {
  wchar_t* p = nullptr; UINT32 n = 0;
  Check(attrs->GetAllocatedString(key,&p,&n), "Device attribute");
  const std::wstring value(p,n); CoTaskMemFree(p); return value;
}
struct Runtime {
  Runtime() {
    Check(CoInitializeEx(nullptr,COINIT_MULTITHREADED),"COM startup");
    const auto hr = MFStartup(MF_VERSION);
    if (FAILED(hr)) { CoUninitialize(); Check(hr,"Media Foundation startup"); }
  }
  ~Runtime() { MFShutdown(); CoUninitialize(); }
};
struct Devices {
  IMFActivate** entries = nullptr; UINT32 count = 0;
  Devices() {
    ComPtr<IMFAttributes> attrs;
    Check(MFCreateAttributes(&attrs,1),"Device attributes");
    Check(attrs->SetGUID(MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID),"Video source type");
    Check(MFEnumDeviceSources(attrs.Get(),&entries,&count),"Enumerate video devices");
  }
  ~Devices() { for (UINT32 i=0;i<count;++i) entries[i]->Release(); CoTaskMemFree(entries); }
};
struct Source {
  ComPtr<IMFMediaSource> value;
  ~Source() { if (value) value->Shutdown(); }
};
constexpr DWORD Stream = static_cast<DWORD>(MF_SOURCE_READER_FIRST_VIDEO_STREAM);
template<class Interface> Json ReadControl(Interface* controls, long property) {
  if (!controls) return {{"supported",false}};
  long value=0,flags=0,minimum=0,maximum=0,step=0,defaultValue=0,caps=0;
  const auto hr=controls->Get(property,&value,&flags);
  if (FAILED(hr)) return {{"supported",false},{"hresult",static_cast<unsigned long>(hr)}};
  Json result={{"supported",true},{"value",value},{"flags",flags},{"automatic",(flags&1)!=0}};
  if (SUCCEEDED(controls->GetRange(property,&minimum,&maximum,&step,&defaultValue,&caps)))
    result["range"]={{"minimum",minimum},{"maximum",maximum},{"step",step},{"default",defaultValue},{"capabilities",caps}};
  return result;
}
void Controls(IMFActivate* device,const std::wstring& id) {
  Source source;
  Check(device->ActivateObject(IID_PPV_ARGS(&source.value)),"Open camera for control inspection");
  ComPtr<IAMCameraControl> camera; ComPtr<IAMVideoProcAmp> video;
  source.value.As(&camera); source.value.As(&video);
  const Json controls={
    {"exposure",ReadControl(camera.Get(),CameraControl_Exposure)},
    {"focus",ReadControl(camera.Get(),CameraControl_Focus)},
    {"iris",ReadControl(camera.Get(),CameraControl_Iris)},
    {"whiteBalance",ReadControl(video.Get(),VideoProcAmp_WhiteBalance)},
    {"gain",ReadControl(video.Get(),VideoProcAmp_Gain)},
    {"gamma",ReadControl(video.Get(),VideoProcAmp_Gamma)}
  };
  // Read only. Unsupported USB controls are not evidence of manual camera settings.
  std::cout<<Json({{"schema","pb-uvc-controls-v1"},{"deviceId",Utf8(id)},
    {"controls",controls},{"settingsChanged",false},{"manualLockVerified",false}}).dump()<<'\n';
}
void Capture(IMFActivate* device, const std::wstring& id) {
  Source source;
  Check(device->ActivateObject(IID_PPV_ARGS(&source.value)),"Open selected camera; close other camera apps if busy");
  ComPtr<IMFAttributes> attrs;
  Check(MFCreateAttributes(&attrs,1),"Reader attributes");
  // Software conversion is appropriate for this single-frame diagnostic, not
  // a promise of sustained 30fps performance. No camera settings are written.
  Check(attrs->SetUINT32(MF_SOURCE_READER_ENABLE_VIDEO_PROCESSING,TRUE),"Enable RGB conversion");
  ComPtr<IMFSourceReader> reader;
  Check(MFCreateSourceReaderFromMediaSource(source.value.Get(),attrs.Get(),&reader),"Create camera reader");
  Check(reader->SetStreamSelection(static_cast<DWORD>(MF_SOURCE_READER_ALL_STREAMS),FALSE),"Deselect streams");
  Check(reader->SetStreamSelection(Stream,TRUE),"Select video only");
  bool selected = false;
  for (DWORD i=0;i<1024;++i) {
    ComPtr<IMFMediaType> type;
    const auto hr = reader->GetNativeMediaType(Stream,i,&type);
    if (hr == MF_E_NO_MORE_TYPES) break;
    Check(hr,"Read camera format");
    UINT32 w=0,h=0,n=0,d=0;
    if (SUCCEEDED(MFGetAttributeSize(type.Get(),MF_MT_FRAME_SIZE,&w,&h))
        && SUCCEEDED(MFGetAttributeRatio(type.Get(),MF_MT_FRAME_RATE,&n,&d))
        && w == 1920 && h == 1080 && d && n == 30ULL*d) {
      if (SUCCEEDED(reader->SetCurrentMediaType(Stream,nullptr,type.Get()))) { selected = true; break; }
    }
  }
  if (!selected) throw std::runtime_error("Selected camera does not offer 1920x1080 at 30fps; no format fallback performed");
  ComPtr<IMFMediaType> requested;
  Check(MFCreateMediaType(&requested),"RGB media type");
  Check(requested->SetGUID(MF_MT_MAJOR_TYPE,MFMediaType_Video),"Video major type");
  Check(requested->SetGUID(MF_MT_SUBTYPE,MFVideoFormat_RGB32),"RGB32 subtype");
  Check(reader->SetCurrentMediaType(Stream,nullptr,requested.Get()),"Set processed RGB32");
  ComPtr<IMFMediaType> actual;
  Check(reader->GetCurrentMediaType(Stream,&actual),"Read negotiated format");
  UINT32 w=0,h=0,n=0,d=0; GUID subtype{};
  Check(MFGetAttributeSize(actual.Get(),MF_MT_FRAME_SIZE,&w,&h),"Read dimensions");
  Check(MFGetAttributeRatio(actual.Get(),MF_MT_FRAME_RATE,&n,&d),"Read frame rate");
  Check(actual->GetGUID(MF_MT_SUBTYPE,&subtype),"Read subtype");
  if (w!=1920 || h!=1080 || !d || n!=30ULL*d || subtype!=MFVideoFormat_RGB32)
    throw std::runtime_error("Negotiated format does not match requested 1080p30 RGB32");
  // Discard startup frames. This is NOT projector/camera synchronization or
  // exposure-lock verification. The parent must enforce a wall-clock timeout.
  ComPtr<IMFSample> sample; LONGLONG timestamp=0;
  unsigned received=0;
  for (unsigned attempts=0;attempts<120 && received<9;++attempts) {
    sample.Reset(); DWORD flags=0;
    Check(reader->ReadSample(Stream,0,nullptr,&flags,&timestamp,&sample),"Read camera sample");
    if (flags & (MF_SOURCE_READERF_ERROR | MF_SOURCE_READERF_ENDOFSTREAM
        | MF_SOURCE_READERF_CURRENTMEDIATYPECHANGED | MF_SOURCE_READERF_NATIVEMEDIATYPECHANGED))
      throw std::runtime_error("Camera stopped or changed format during capture");
    if (sample) ++received;
  }
  if (received!=9 || !sample) throw std::runtime_error("Camera returned no usable frame");
  ComPtr<IMFMediaBuffer> buffer;
  Check(sample->ConvertToContiguousBuffer(&buffer),"Camera sample buffer");
  std::vector<std::uint8_t> rgb;
  ComPtr<IMF2DBuffer2> twoD;
  if (SUCCEEDED(buffer.As(&twoD))) {
    BYTE *top=nullptr,*start=nullptr; LONG pitch=0; DWORD length=0;
    Check(twoD->Lock2DSize(MF2DBuffer_LockFlags_Read,&top,&pitch,&start,&length),"Lock 2D camera buffer");
    try {
      const auto topAddress = reinterpret_cast<std::uintptr_t>(top);
      const auto startAddress = reinterpret_cast<std::uintptr_t>(start);
      if (topAddress < startAddress) throw std::runtime_error("Invalid camera top row");
      rgb=pbwin::UvcRgb24(start,length,topAddress-startAddress,pitch,w,h);
    } catch (...) { twoD->Unlock2D(); throw; }
    Check(twoD->Unlock2D(),"Unlock 2D camera buffer");
  } else {
    LONG stride=0; UINT32 encodedStride=0;
    if (SUCCEEDED(actual->GetUINT32(MF_MT_DEFAULT_STRIDE,&encodedStride))) stride=static_cast<LONG>(encodedStride);
    else Check(MFGetStrideForBitmapInfoHeader(MFVideoFormat_RGB32.Data1,w,&stride),"Read RGB stride");
    BYTE* data=nullptr; DWORD length=0;
    Check(buffer->Lock(&data,nullptr,&length),"Lock camera buffer");
    try {
      const std::size_t top = stride<0 ? static_cast<std::size_t>(-static_cast<std::int64_t>(stride))*(h-1) : 0;
      rgb=pbwin::UvcRgb24(data,length,top,stride,w,h);
    } catch (...) { buffer->Unlock(); throw; }
    Check(buffer->Unlock(),"Unlock camera buffer");
  }
  const auto now = std::chrono::duration_cast<std::chrono::milliseconds>(
    std::chrono::system_clock::now().time_since_epoch()).count();
  Json metadata = {{"schema","pb-uvc-frame-v1"},{"deviceId",Utf8(id)},
    {"deviceName",Utf8(Attribute(device,MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME))},
    {"width",w},{"height",h},{"fpsNumerator",n},{"fpsDenominator",d},
    {"pixelFormat","rgb24-encoded"},{"byteLength",rgb.size()},
    {"sampleTime100ns",std::to_string(timestamp)},{"receivedAtUnixMs",now},
    {"discardedStartupFrames",8},{"linearized",false},{"raw",false},
    {"manualLockVerified",false},{"patternSynchronized",false},
    {"purpose","geometry-preview-only"}};
  _setmode(_fileno(stdout),_O_BINARY);
  std::cout << metadata.dump() << '\n';
  std::cout.write(reinterpret_cast<const char*>(rgb.data()),static_cast<std::streamsize>(rgb.size()));
  if (!std::cout) throw std::runtime_error("Camera output pipe closed");
}
}
int wmain(int argc,wchar_t** argv) {
  try {
    const bool list = argc==2 && std::wstring(argv[1])==L"--list";
    const bool capture = argc==3 && std::wstring(argv[1])==L"--capture" && wcslen(argv[2])>0;
    const bool controls = argc==3 && std::wstring(argv[1])==L"--controls" && wcslen(argv[2])>0;
    if (!list && !capture && !controls) throw std::runtime_error("Usage: pixel-brightness-uvc --list | --capture <exact-device-id> | --controls <exact-device-id>");
    Runtime runtime; Devices devices;
    Json found=Json::array(); IMFActivate* chosen=nullptr;
    for (UINT32 i=0;i<devices.count;++i) {
      const auto id=Attribute(devices.entries[i],MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_SYMBOLIC_LINK);
      found.push_back({{"id",Utf8(id)},{"name",Utf8(Attribute(devices.entries[i],MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME))}});
      if ((capture || controls) && id==argv[2]) chosen=devices.entries[i];
    }
    if (list) {
      std::cout << Json({{"schema","pb-uvc-devices-v1"},{"devices",found}}).dump() << '\n';
    } else {
      if (!chosen) throw std::runtime_error("Selected UVC camera is not present. On R50 choose Video calls/streaming and reconnect USB.");
      if (controls) Controls(chosen,argv[2]); else Capture(chosen,argv[2]);
    }
    return 0;
  } catch (const std::exception& e) {
    std::cerr << Json({{"code","UVC_CAMERA_FAILED"},{"message",e.what()}}).dump() << '\n';
    return 1;
  }
}

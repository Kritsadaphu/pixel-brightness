#include <windows.h>
#include "pbwin/NdiSender.hpp"
#include <nlohmann/json.hpp>
#include <chrono>
#include <iostream>
#include <memory>
#include <regex>
#include <set>
#include <thread>

using Json = nlohmann::json;
using Clock = std::chrono::steady_clock;
struct Output {
    std::string id;
    std::unique_ptr<pbwin::NdiSender> sender;
    pbwin::NetworkVideoFrame frame;
};
void Emit(const Json& value) { std::cout << value.dump() << std::endl; }
unsigned Bits(unsigned size) { unsigned bits=0; for (--size; size; size>>=1) ++bits; return bits; }
void Fill(Output& output, const Json& pattern) {
    const auto kind=pattern.at("kind").get<std::string>();
    auto& f=output.frame;
    for(unsigned y=0;y<f.height;++y) for(unsigned x=0;x<f.width;++x) {
        unsigned value=0;
        if(kind=="solid") value=pattern.at("level").get<unsigned>();
        else {
            const bool vertical=pattern.at("axis")=="x";
            const auto coordinate=vertical?x:y;
            const auto shift=Bits(vertical?f.width:f.height)-1-pattern.at("bit").get<unsigned>();
            value=((((coordinate^(coordinate>>1))>>shift)&1)!=pattern.at("inverse").get<bool>())?255:0;
        }
        const auto i=(static_cast<std::size_t>(y)*f.width+x)*4;
        f.rgba[i]=f.rgba[i+1]=f.rgba[i+2]=static_cast<std::uint8_t>(value); f.rgba[i+3]=255;
    }
}
int main(int argc,char** argv) {
    try {
        if(argc!=3 || std::string(argv[1])!="--config") throw std::runtime_error("Usage: --config JSON");
        const auto config=Json::parse(argv[2]);
        const auto prefix=config.at("prefix").get<std::string>();
        const int frameRateNum=config.value("frameRateNum",30);
        if(frameRateNum!=30 && frameRateNum!=60) throw std::runtime_error("Pattern source supports 30 or 60 fps");
        if(!std::regex_match(prefix,std::regex("PB-GEOMETRY-[A-Za-z0-9_-]{1,64}"))) throw std::runtime_error("Use an isolated PB-GEOMETRY prefix");
        const auto definitions=config.at("outputs");
        if(!definitions.is_array() || definitions.empty() || definitions.size()>5) throw std::runtime_error("Expected 1-5 outputs");
        // Validate everything before advertising any source.
        std::set<std::string> ids;
        for(const auto& item:definitions) {
            const auto id=item.at("id").get<std::string>();
            const auto width=item.at("width").get<int>(),height=item.at("height").get<int>();
            if(!std::regex_match(id,std::regex("[A-Za-z0-9_-]{1,64}")) || !ids.insert(id).second
               || width<2 || width>4096 || width%2 || height<2 || height>2160) throw std::runtime_error("Invalid output definition");
        }
        std::vector<Output> outputs;
        Json sources=Json::array();
        for(const auto& item:definitions) {
            Output o; o.id=item.at("id");
            o.frame.width=item.at("width"); o.frame.height=item.at("height");
            o.frame.frameRateNum=frameRateNum; o.frame.frameRateDen=1;
            o.frame.rgba.resize(pbwin::NetworkVideoFrame::ByteCount(o.frame.width,o.frame.height));
            Fill(o,{{"kind","solid"},{"level",0}});
            o.sender=std::make_unique<pbwin::NdiSender>(prefix+"-"+o.id);
            const auto identity=o.sender->SourceIdentity();
            sources.push_back({{"outputId",o.id},{"name",identity.name},{"address",identity.address}});
            outputs.push_back(std::move(o));
        }
        Emit({{"event","ready"},{"sources",sources},{"physicalPresentationVerified",false}});
        const auto started=Clock::now(); auto lastCommand=started;
        const auto input=GetStdHandle(STD_INPUT_HANDLE);
        std::string pending; std::uint64_t sequence=0; int stopping=0;
        while(true) {
            const auto tick=Clock::now(); Json response;
            DWORD available=0;
            if(!PeekNamedPipe(input,nullptr,0,nullptr,&available,nullptr)) stopping=stopping?stopping:3;
            if(available && !stopping) {
                char bytes[4096]; DWORD read=0;
                if(!ReadFile(input,bytes,std::min<DWORD>(available,sizeof(bytes)),&read,nullptr)) stopping=3;
                else pending.append(bytes,read);
                if(pending.size()>16384) throw std::runtime_error("Control input exceeds limit");
            }
            const auto newline=pending.find('\n');
            if(newline!=std::string::npos && !stopping) {
                const auto line=pending.substr(0,newline); pending.erase(0,newline+1);
                Json request;
                try {
                    request=Json::parse(line); const auto command=request.at("command").get<std::string>();
                    if(command=="ping") { lastCommand=Clock::now(); }
                    else if(command=="stop") { stopping=3; lastCommand=Clock::now(); }
                    else if(command=="pattern") {
                        const auto outputId=request.at("outputId").get<std::string>();
                        const auto stepId=request.at("stepId").get<std::string>();
                        if(stepId.empty() || stepId.size()>128) throw std::runtime_error("Invalid step id");
                        auto target=std::find_if(outputs.begin(),outputs.end(),[&](const auto& o){return o.id==outputId;});
                        if(target==outputs.end()) throw std::runtime_error("Unknown output");
                        const auto pattern=request.at("pattern"); const auto kind=pattern.at("kind").get<std::string>();
                        if(kind=="solid") {
                            if(!pattern.at("level").is_number_integer() || pattern.at("level").get<int>()<0 || pattern.at("level").get<int>()>255) throw std::runtime_error("Invalid solid level");
                        } else if(kind=="gray-code") {
                            const auto axis=pattern.at("axis").get<std::string>();
                            const auto bit=pattern.at("bit").get<int>();
                            if((axis!="x" && axis!="y") || bit<0 || bit>=static_cast<int>(Bits(axis=="x"?target->frame.width:target->frame.height))
                               || !pattern.at("inverse").is_boolean()) throw std::runtime_error("Invalid Gray-code bit");
                        } else throw std::runtime_error("Unknown pattern");
                        for(auto& o:outputs) Fill(o,o.id==outputId?pattern:Json{{"kind","solid"},{"level",0}});
                        response={{"event","pattern"},{"stepId",stepId},{"submitted",true},{"otherOutputsBlack",true},{"physicalPresentationVerified",false}};
                        lastCommand=Clock::now();
                    } else if(command=="status") {
                        Json connections=Json::array();
                        for(const auto& o:outputs) connections.push_back({{"outputId",o.id},{"connections",o.sender->ConnectionCount()}});
                        response={{"event","status"},{"connections",connections}}; lastCommand=Clock::now();
                    } else throw std::runtime_error("Unknown command");
                } catch(const std::exception& e) { response={{"event","error"},{"error",e.what()},{"stepId",request.value("stepId",std::string())}}; }
            }
            if(Clock::now()-lastCommand>std::chrono::seconds(10)) stopping=stopping?stopping:3;
            if(stopping) for(auto& o:outputs) Fill(o,{{"kind","solid"},{"level",0}});
            const auto timecode=std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now()-started).count()/100;
            for(auto& o:outputs) { o.frame.sequence=sequence; o.frame.timecode=timecode; o.sender->Send(o.frame); }
            ++sequence;
            if(!response.is_null()) Emit(response);
            if(stopping && --stopping==0) {
                Emit({{"event","stopped"},{"blackSubmitted",true},{"physicalBlackVerified",false},{"contentRestored",false}}); break;
            }
            std::this_thread::sleep_until(tick+std::chrono::nanoseconds(1000000000LL/frameRateNum));
        }
        return 0;
    } catch(const std::exception& e) { Emit({{"event","error"},{"error",e.what()}}); return 1; }
}

#include "pbwin/Config.hpp"
#include "pbwin/DisplayRegistry.hpp"

#include <nlohmann/json.hpp>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>

namespace {

void Require(const bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

template <typename Callback>
void RequireThrows(Callback&& callback, const char* message) {
    try {
        callback();
    } catch (const std::exception&) {
        return;
    }
    throw std::runtime_error(message);
}

} // namespace

int main() {
    try {
        const std::filesystem::path path(PB_TEST_CONFIG_PATH);
        std::ifstream stream(path, std::ios::binary);
        Require(static_cast<bool>(stream), "example config could not be opened");
        nlohmann::json document;
        stream >> document;

        const auto config = pbwin::ConfigLoader::FromJson(document, path.parent_path());
        Require(config.nodeId == "node01", "node id did not parse");
        Require(config.compositionSource.senderName == "PB-COMPOSITION", "shared sender did not parse");
        Require(config.compositionSource.width == config.canvas.width, "composition width differs from canvas");
        Require(config.outputs.size() == 1, "unexpected output count");
        Require(!config.outputs[0].processingBypass, "example unexpectedly bypasses corrections");
        Require(config.outputs[0].warp.points.size() == 9, "2x2 warp mesh must have nine points");
        Require(config.outputs[0].warp.points[4].u == 0.5F, "warp UV was not preserved");

        const auto serialized = pbwin::ConfigLoader::ToJson(config);
        const auto roundTrip = pbwin::ConfigLoader::FromJson(serialized, path.parent_path());
        Require(roundTrip.outputs.size() == 1, "serialized config lost its output");
        Require(roundTrip.outputs[0].display.devicePath == config.outputs[0].display.devicePath,
                "serialized config lost its stable display selector");
        Require(roundTrip.compositionSource.acceptedFormats == config.compositionSource.acceptedFormats,
                "serialized config lost accepted Spout formats");

        auto bypass = document;
        auto network = document["outputs"][0];
        RequireThrows([&] { pbwin::ConfigLoader::NetworkOutputFromJson(network, config.canvas, path.parent_path()); },
                      "Network config accepted a physical display selector");
        network.erase("display");
        const auto networkOutput = pbwin::ConfigLoader::NetworkOutputFromJson(network, config.canvas, path.parent_path());
        Require(networkOutput.warp.points.size() == config.outputs[0].warp.points.size(), "Network parser lost correction mesh");
        auto missingDisplay = document;
        missingDisplay["outputs"][0].erase("display");
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(missingDisplay, path.parent_path()); },
                      "DXGI config accepted an unbound network output");
        network["resolution"]["width"] = 4097;
        RequireThrows([&] { pbwin::ConfigLoader::NetworkOutputFromJson(network, config.canvas, path.parent_path()); },
                      "Network parser accepted oversized/odd width");
        bypass["outputs"][0]["processing"]["bypass"] = true;
        const auto bypassConfig = pbwin::ConfigLoader::FromJson(bypass, path.parent_path());
        Require(bypassConfig.outputs[0].processingBypass, "processing bypass did not parse");

        RequireThrows([&] {
            auto invalidBlendGamma = document;
            invalidBlendGamma["outputs"][0]["blend"]["gamma"] = 0.01;
            (void)pbwin::ConfigLoader::FromJson(invalidBlendGamma, path.parent_path());
        }, "blend gamma below the stable range was accepted");

        RequireThrows([&] {
            auto invalidFeather = document;
            invalidFeather["outputs"][0]["blend"]["feather"] = 0.001;
            (void)pbwin::ConfigLoader::FromJson(invalidFeather, path.parent_path());
        }, "blend feather below the controller range was accepted");

        RequireThrows([&] {
            auto invalidColor = document;
            invalidColor["outputs"][0]["color"]["offset"] = {0, 1.1, 0};
            (void)pbwin::ConfigLoader::FromJson(invalidColor, path.parent_path());
        }, "color offset outside the controller range was accepted");

        auto unknown = document;
        unknown["outputs"][0]["processing"]["surprise"] = true;
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(unknown, path.parent_path()); },
                      "unknown strict-schema field was accepted");

        auto duplicateFormat = document;
        duplicateFormat["compositionSource"]["acceptedFormats"].push_back(
            duplicateFormat["compositionSource"]["acceptedFormats"][0]);
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(duplicateFormat, path.parent_path()); },
                      "duplicate accepted Spout format was accepted");

        auto allDisabled = document;
        allDisabled["outputs"][0]["enabled"] = false;
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(allDisabled, path.parent_path()); },
                      "config without an enabled output was accepted");

        auto missingEnabled = document;
        missingEnabled["outputs"][0].erase("enabled");
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(missingEnabled, path.parent_path()); },
                      "output without schema-required enabled was accepted");

        auto invalidOutputId = document;
        invalidOutputId["outputs"][0]["id"] = "Projector A";
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(invalidOutputId, path.parent_path()); },
                      "output id outside the schema character set was accepted");

        auto wrongSize = document;
        wrongSize["compositionSource"]["width"] = document["canvas"]["width"].get<int>() - 1;
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(wrongSize, path.parent_path()); },
                      "mismatched composition size was accepted");

        auto wrongRate = document;
        wrongRate["compositionSource"]["frameRateNum"] = 50;
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(wrongRate, path.parent_path()); },
                      "mismatched composition rate was accepted");

        auto polygon = document;
        polygon["outputs"][0]["mask"] = {
            {"enabled", true}, {"map", nullptr}, {"softness", 0.05},
            {"path", {{{"x", 0.0}, {"y", 0.0}},
                      {{"x", 1.0}, {"y", 0.0}},
                      {{"x", 1.0}, {"y", 1.0}},
                      {{"x", 0.0}, {"y", 1.0}}}},
        };
        const auto polygonConfig = pbwin::ConfigLoader::FromJson(polygon, path.parent_path());
        Require(polygonConfig.outputs[0].maskPath.size() == 4, "polygon mask path did not parse");
        Require(polygonConfig.outputs[0].maskSoftness == 0.05F, "polygon softness did not parse");

        auto emptyMask = document;
        emptyMask["outputs"][0]["mask"] = {
            {"enabled", true}, {"map", nullptr}, {"path", nullptr}, {"softness", 0.0},
        };
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(emptyMask, path.parent_path()); },
                      "enabled mask without map or polygon was accepted");

        auto badMesh = document;
        badMesh["outputs"][0]["warp"]["points"].erase(
            badMesh["outputs"][0]["warp"]["points"].begin());
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(badMesh, path.parent_path()); },
                      "wrong warp point count was accepted");

        auto partialMesh = document;
        partialMesh["outputs"][0]["warp"].erase("columns");
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(partialMesh, path.parent_path()); },
                      "warp missing a schema-required dimension was accepted");

        auto foldedMesh = document;
        foldedMesh["outputs"][0]["warp"]["points"][4]["x"] = 2.0;
        RequireThrows([&] { pbwin::ConfigLoader::FromJson(foldedMesh, path.parent_path()); },
                      "folded warp mesh was accepted");

        const auto luid = pbwin::ParseLuid("FFFFFFFF:0123ABCD");
        Require(luid.has_value() && pbwin::LuidToString(*luid) == "FFFFFFFF:0123ABCD",
                "LUID round trip failed");
        Require(pbwin::ParsePatternMode("gray-code") == pbwin::PatternMode::grayCode,
                "gray-code pattern mode did not parse");
        Require(pbwin::PatternModeName(pbwin::PatternMode::solid) == "solid",
                "solid pattern mode did not serialize");
        const auto correctedCommand = pbwin::ParsePatternCommand({
            {"mode", "solid"}, {"rgb", {0.0039, 0.18, 1.0}},
            {"applyCorrections", true}, {"outputId", "A"},
        });
        Require(correctedCommand.mode == pbwin::PatternMode::solid &&
                    correctedCommand.applyCorrections,
                "corrected solid pattern command did not parse");
        const auto rawCommand = pbwin::ParsePatternCommand({
            {"mode", "solid"}, {"rgb", {0.0, 0.0, 0.0}},
        });
        Require(!rawCommand.applyCorrections,
                "omitted corrected-solid flag did not default to raw");
        RequireThrows([&] {
            (void)pbwin::ParsePatternCommand({
                {"mode", "gray-code"}, {"axis", "x"}, {"bit", 0},
                {"inverse", false}, {"applyCorrections", true},
            });
        }, "Gray-code accepted applyCorrections");
        RequireThrows([&] {
            (void)pbwin::ParsePatternCommand({
                {"mode", "grid"}, {"cellSize", 32}, {"applyCorrections", false},
            });
        }, "non-solid mode accepted an applyCorrections field");
        pbwin::PatternConfig contentPattern;
        Require(!pbwin::PatternCorrectionsBypassed(contentPattern, false),
                "content unexpectedly bypasses enabled corrections");
        pbwin::PatternConfig rawSolid;
        rawSolid.mode = pbwin::PatternMode::solid;
        Require(pbwin::PatternModeSupportsCorrections(rawSolid.mode),
                "solid pattern does not advertise corrected verification support");
        Require(pbwin::PatternCorrectionsBypassed(rawSolid, false),
                "raw solid pattern unexpectedly applies corrections");
        rawSolid.applyCorrections = true;
        Require(!pbwin::PatternCorrectionsBypassed(rawSolid, false),
                "explicit corrected solid pattern still bypasses corrections");
        Require(pbwin::PatternCorrectionsBypassed(rawSolid, true),
                "output processing bypass did not override corrected solid pattern");
        pbwin::PatternConfig unsupportedCorrected;
        unsupportedCorrected.mode = pbwin::PatternMode::grayCode;
        unsupportedCorrected.applyCorrections = true;
        Require(pbwin::PatternCorrectionsBypassed(unsupportedCorrected, false),
                "unsupported corrected pattern mode did not fail closed");

        const pbwin::DisplayDescriptor first{
            L"\\\\?\\DISPLAY#PROJECTOR_A", L"\\\\.\\DISPLAY2", L"Projector A",
            {1, 0}, 0, 2};
        const pbwin::DisplayDescriptor second{
            L"\\\\?\\DISPLAY#PROJECTOR_B", L"\\\\.\\DISPLAY3", L"Projector B",
            {1, 0}, 1, 3};
        const std::vector displays{first, second};
        pbwin::DisplaySelector exact;
        exact.devicePath = first.devicePath;
        exact.gdiName = first.gdiName;
        exact.adapterLuid = first.adapterLuid;
        exact.targetId = first.targetId;
        const auto exactDisplay = pbwin::DisplayRegistry::Resolve(exact, displays);
        Require(exactDisplay && exactDisplay->targetId == first.targetId,
                "matching stable display assertions did not resolve");
        exact.gdiName = second.gdiName;
        Require(!pbwin::DisplayRegistry::Resolve(exact, displays),
                "conflicting stable display assertions fell back to the wrong projector");
        std::cout << "pbwin config contract tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "pbwin config contract tests failed: " << error.what() << '\n';
        return 1;
    }
}

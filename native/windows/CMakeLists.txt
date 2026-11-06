cmake_minimum_required(VERSION 3.24)

project(PixelBrightnessRenderer VERSION 0.3.0 LANGUAGES CXX)

if(NOT WIN32)
  message(FATAL_ERROR "Pixel Brightness native renderer is a Windows-only target")
endif()

include(FetchContent)
include(CTest)

option(PB_FETCH_SPOUT2 "Fetch and build the pinned Spout2 DirectX SDK" ON)
option(PB_ENABLE_D3D_DEBUG "Enable the Direct3D debug layer in Debug builds" ON)
option(PB_BUILD_EXPERIMENTAL_NETWORK_OUTPUT "Build isolated offscreen/NDI development libraries" OFF)
option(PB_BUILD_UVC_CAMERA "Build SDK-free Media Foundation camera diagnostic" OFF)
set(PB_NDI_SDK_ROOT "" CACHE PATH "Operator-provided official NDI SDK root (optional)")

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
# The show-node package is copied as a self-contained binary and does not ship
# a VC Redistributable bootstrapper. Keep the renderer and pinned static Spout
# targets on the same static MSVC runtime to avoid a clean-machine dependency.
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# Pin source dependencies by immutable commit. No third-party binaries are
# downloaded or checked into this repository.
FetchContent_Declare(
  nlohmann_json
  GIT_REPOSITORY https://github.com/nlohmann/json.git
  GIT_TAG 9cca280a4d0ccf0c08f47a99aa71d1b0e52f8d03 # v3.11.3
  GIT_SHALLOW FALSE
)
FetchContent_MakeAvailable(nlohmann_json)

if(PB_FETCH_SPOUT2)
  set(SPOUT_BUILD_CMT OFF CACHE BOOL "" FORCE)
  set(SPOUT_BUILD_LIBRARY OFF CACHE BOOL "" FORCE)
  set(SPOUT_BUILD_SPOUTDX ON CACHE BOOL "" FORCE)
  set(SKIP_INSTALL_ALL ON CACHE BOOL "" FORCE)
  set(SPOUT_NO_GLOBAL_WARNING ON CACHE BOOL "" FORCE)
  FetchContent_Declare(
    Spout2
    GIT_REPOSITORY https://github.com/leadedge/Spout2.git
    GIT_TAG f49e2f469f8cb25f559a6eaa61a3f5b8173fc100 # 2.007.017
    GIT_SHALLOW FALSE
  )
  FetchContent_MakeAvailable(Spout2)
endif()

set(PB_HEADERS
  include/pbwin/BootBlackLock.hpp
  include/pbwin/Config.hpp
  include/pbwin/D3DDevice.hpp
  include/pbwin/Digest.hpp
  include/pbwin/DisplayTiming.hpp
  include/pbwin/DisplayRegistry.hpp
  include/pbwin/FinalPipeline.hpp
  include/pbwin/LatestSnapshotMailbox.hpp
  include/pbwin/Log.hpp
  include/pbwin/NamedPipeServer.hpp
  include/pbwin/OutputSurface.hpp
  include/pbwin/PipeListenerRecoveryPolicy.hpp
  include/pbwin/RecoveryPolicy.hpp
  include/pbwin/RendererApp.hpp
  include/pbwin/SpoutInput.hpp
  include/pbwin/Telemetry.hpp
  include/pbwin/TelemetryPersistence.hpp
  include/pbwin/Win32Window.hpp
)

set(PB_SOURCES
  src/BootBlackLock.cpp
  src/Config.cpp
  src/D3DDevice.cpp
  src/Digest.cpp
  src/DisplayTiming.cpp
  src/DisplayRegistry.cpp
  src/FinalPipeline.cpp
  src/Log.cpp
  src/NamedPipeServer.cpp
  src/OutputSurface.cpp
  src/PipeListenerRecoveryPolicy.cpp
  src/RecoveryPolicy.cpp
  src/RendererApp.cpp
  src/SpoutInput.cpp
  src/Telemetry.cpp
  src/TelemetryPersistence.cpp
  src/Win32Window.cpp
  src/main.cpp
)

add_executable(pixel-brightness-renderer WIN32 ${PB_HEADERS} ${PB_SOURCES})
target_include_directories(pixel-brightness-renderer PRIVATE include)
target_compile_definitions(pixel-brightness-renderer PRIVATE
  UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
  _WIN32_WINNT=0x0A00 NTDDI_VERSION=0x0A000000
  PB_VERSION="${PROJECT_VERSION}"
  PB_ENABLE_D3D_DEBUG=$<BOOL:${PB_ENABLE_D3D_DEBUG}>
)
target_link_libraries(pixel-brightness-renderer PRIVATE
  nlohmann_json::nlohmann_json advapi32
  d3d11 dxgi d3dcompiler dxguid user32 gdi32 shell32 shcore ole32 avrt dwmapi winmm bcrypt
)

if(PB_FETCH_SPOUT2)
  target_compile_definitions(pixel-brightness-renderer PRIVATE PB_WITH_SPOUT=1 SPOUT_BUILD_STATIC)
  target_link_libraries(pixel-brightness-renderer PRIVATE SpoutDX_static)
else()
  target_compile_definitions(pixel-brightness-renderer PRIVATE PB_WITH_SPOUT=0)
endif()

if(MSVC)
  target_compile_options(pixel-brightness-renderer PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  target_link_options(pixel-brightness-renderer PRIVATE /SUBSYSTEM:WINDOWS)
else()
  target_compile_options(pixel-brightness-renderer PRIVATE -Wall -Wextra -Wpedantic)
endif()

set_target_properties(pixel-brightness-renderer PROPERTIES
  OUTPUT_NAME "pixel-brightness-renderer"
  VS_DEBUGGER_WORKING_DIRECTORY "$<TARGET_FILE_DIR:pixel-brightness-renderer>"
)

add_custom_command(TARGET pixel-brightness-renderer POST_BUILD
  COMMAND ${CMAKE_COMMAND} -E make_directory "$<TARGET_FILE_DIR:pixel-brightness-renderer>/shaders"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/shaders/fullscreen_vs.hlsl"
    "${CMAKE_CURRENT_SOURCE_DIR}/shaders/final_ps.hlsl"
    "$<TARGET_FILE_DIR:pixel-brightness-renderer>/shaders"
  COMMAND ${CMAKE_COMMAND} -E copy_if_different
    "${CMAKE_CURRENT_SOURCE_DIR}/config/renderer.example.json"
    "$<TARGET_FILE_DIR:pixel-brightness-renderer>/renderer.example.json"
)

install(TARGETS pixel-brightness-renderer RUNTIME DESTINATION bin)
install(DIRECTORY shaders DESTINATION bin)
install(FILES config/renderer.example.json config/renderer.schema.json DESTINATION config)
install(FILES README.md THIRD_PARTY_NOTICES.md
        DESTINATION share/pixel-brightness-renderer)
install(FILES ipc/contract.md
        DESTINATION share/pixel-brightness-renderer/ipc)

if(PB_BUILD_UVC_CAMERA)
  add_executable(pixel-brightness-uvc src/UvcCameraMain.cpp)
  target_include_directories(pixel-brightness-uvc PRIVATE include)
  target_compile_definitions(pixel-brightness-uvc PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
  target_link_libraries(pixel-brightness-uvc PRIVATE
    nlohmann_json::nlohmann_json mfplat mfreadwrite mfuuid mf ole32)
  if(MSVC)
    target_compile_options(pixel-brightness-uvc PRIVATE /W4 /permissive- /EHsc /utf-8)
  endif()
  if(BUILD_TESTING)
    add_executable(pbwin-uvc-buffer-tests tests/UvcBufferTests.cpp)
    target_include_directories(pbwin-uvc-buffer-tests PRIVATE include)
    add_test(NAME pbwin-uvc-buffer-contract COMMAND pbwin-uvc-buffer-tests)
  endif()
endif()

# Isolated development path. No installer target, autostart, live sender, changes
# to the production renderer contract, or reuse of another app's bundled DLLs.
if(PB_BUILD_EXPERIMENTAL_NETWORK_OUTPUT)
  add_library(pbwin-offscreen STATIC
    src/OffscreenOutput.cpp src/FinalPipeline.cpp src/Digest.cpp src/Log.cpp src/Config.cpp)
  target_include_directories(pbwin-offscreen PUBLIC include)
  target_compile_definitions(pbwin-offscreen PUBLIC
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX _WIN32_WINNT=0x0A00)
  target_link_libraries(pbwin-offscreen PUBLIC
    nlohmann_json::nlohmann_json d3d11 d3dcompiler dxguid bcrypt)
  if(MSVC)
    target_compile_options(pbwin-offscreen PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  if(PB_NDI_SDK_ROOT)
    find_path(PB_NDI_INCLUDE Processing.NDI.Lib.h
      PATHS "${PB_NDI_SDK_ROOT}/Include" NO_DEFAULT_PATH NO_CACHE REQUIRED)
    find_library(PB_NDI_LIBRARY NAMES Processing.NDI.Lib.x64
      PATHS "${PB_NDI_SDK_ROOT}/Lib/x64" NO_DEFAULT_PATH NO_CACHE REQUIRED)
    if(NOT CMAKE_SIZEOF_VOID_P EQUAL 8)
      message(FATAL_ERROR "The NDI development transport requires x64")
    endif()
    add_library(pbwin-ndi-sender STATIC src/NdiSender.cpp)
    target_include_directories(pbwin-ndi-sender PUBLIC include PRIVATE "${PB_NDI_INCLUDE}")
    target_link_libraries(pbwin-ndi-sender PUBLIC "${PB_NDI_LIBRARY}")
    # Read-only show-network diagnostic. Never publishes sources or changes a
    # decoder subscription; receiving adds one short-lived NDI consumer.
    add_executable(pixel-brightness-ndi-probe src/NdiProbeMain.cpp)
    target_include_directories(pixel-brightness-ndi-probe PRIVATE "${PB_NDI_INCLUDE}")
    target_link_libraries(pixel-brightness-ndi-probe PRIVATE "${PB_NDI_LIBRARY}" nlohmann_json::nlohmann_json)
    add_executable(pixel-brightness-ndi-patterns src/NdiPatternMain.cpp)
    target_include_directories(pixel-brightness-ndi-patterns PRIVATE include)
    target_compile_definitions(pixel-brightness-ndi-patterns PRIVATE WIN32_LEAN_AND_MEAN NOMINMAX)
    target_link_libraries(pixel-brightness-ndi-patterns PRIVATE pbwin-ndi-sender nlohmann_json::nlohmann_json)
    add_executable(pixel-brightness-ndi-video src/NdiVideoMain.cpp src/NdiOutputWorker.cpp src/D3DDevice.cpp)
    target_include_directories(pixel-brightness-ndi-video PRIVATE "${PB_NDI_INCLUDE}")
    target_link_libraries(pixel-brightness-ndi-video PRIVATE pbwin-ndi-sender pbwin-offscreen dxgi)
    if(MSVC)
      target_compile_options(pixel-brightness-ndi-video PRIVATE /W4 /permissive- /EHsc /utf-8)
    endif()
    if(MSVC)
      target_compile_options(pixel-brightness-ndi-probe PRIVATE /W4 /permissive- /EHsc /utf-8)
    endif()
    if(MSVC)
      target_compile_options(pbwin-ndi-sender PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
    endif()
    if(BUILD_TESTING)
      add_executable(pbwin-ndi-roundtrip-tests tests/NdiRoundtripTests.cpp src/D3DDevice.cpp)
      target_include_directories(pbwin-ndi-roundtrip-tests PRIVATE "${PB_NDI_INCLUDE}")
      target_compile_definitions(pbwin-ndi-roundtrip-tests PRIVATE
        UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
        PB_TEST_SHADER_DIR="${CMAKE_CURRENT_SOURCE_DIR}/shaders")
      target_link_libraries(pbwin-ndi-roundtrip-tests PRIVATE pbwin-ndi-sender pbwin-offscreen dxgi)
      if(MSVC)
        target_compile_options(pbwin-ndi-roundtrip-tests PRIVATE /W4 /permissive- /EHsc /utf-8)
      endif()
      # A deliberate diagnostic: briefly advertises unique PB-DEV-VERIFY sources.
      # No Magewell subscriptions or production sender names are modified.
      add_test(NAME pbwin-ndi-sdk-roundtrip COMMAND pbwin-ndi-roundtrip-tests)
      set_tests_properties(pbwin-ndi-sdk-roundtrip PROPERTIES TIMEOUT 45 LABELS "ndi;integration"
        ENVIRONMENT_MODIFICATION "PATH=path_list_prepend:${PB_NDI_SDK_ROOT}/Bin/x64")
    endif()
  endif()
  if(BUILD_TESTING)
    add_executable(pbwin-offscreen-tests tests/OffscreenOutputTests.cpp src/D3DDevice.cpp)
    target_link_libraries(pbwin-offscreen-tests PRIVATE pbwin-offscreen dxgi)
    target_compile_definitions(pbwin-offscreen-tests PRIVATE
      PB_TEST_SHADER_DIR="${CMAKE_CURRENT_SOURCE_DIR}/shaders")
    add_test(NAME pbwin-offscreen-network-boundary COMMAND pbwin-offscreen-tests)
    set_tests_properties(pbwin-offscreen-network-boundary PROPERTIES TIMEOUT 30)
  endif()
endif()

if(BUILD_TESTING)
  add_executable(pbwin-boot-black-lock-tests
    tests/BootBlackLockTests.cpp
    src/BootBlackLock.cpp
  )
  target_include_directories(pbwin-boot-black-lock-tests PRIVATE include)
  if(MSVC)
    target_compile_options(pbwin-boot-black-lock-tests PRIVATE
      /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  else()
    target_compile_options(pbwin-boot-black-lock-tests PRIVATE
      -Wall -Wextra -Wpedantic)
  endif()
  add_test(NAME pbwin-boot-black-lock-contract COMMAND pbwin-boot-black-lock-tests)

  add_executable(pbwin-config-tests
    tests/ConfigTests.cpp
    src/Config.cpp
    src/DisplayRegistry.cpp
    src/Log.cpp
  )
  target_include_directories(pbwin-config-tests PRIVATE include)
  target_compile_definitions(pbwin-config-tests PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
    _WIN32_WINNT=0x0A00
    PB_TEST_CONFIG_PATH="${CMAKE_CURRENT_SOURCE_DIR}/config/renderer.example.json"
  )
  target_link_libraries(pbwin-config-tests PRIVATE nlohmann_json::nlohmann_json user32 dxgi)
  if(MSVC)
    target_compile_options(pbwin-config-tests PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  add_test(NAME pbwin-config-contract COMMAND pbwin-config-tests)

  add_executable(pbwin-shader-tests tests/ShaderTests.cpp)
  target_compile_definitions(pbwin-shader-tests PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
    PB_TEST_SHADER_DIR="${CMAKE_CURRENT_SOURCE_DIR}/shaders"
  )
  target_link_libraries(pbwin-shader-tests PRIVATE d3dcompiler dxguid)
  if(MSVC)
    target_compile_options(pbwin-shader-tests PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  add_test(NAME pbwin-shader-contract COMMAND pbwin-shader-tests)

  add_executable(pbwin-pipe-tests
    tests/NamedPipeTests.cpp
    src/NamedPipeServer.cpp
    src/PipeListenerRecoveryPolicy.cpp
    src/Log.cpp
  )
  target_include_directories(pbwin-pipe-tests PRIVATE include)
  target_compile_definitions(pbwin-pipe-tests PRIVATE
    UNICODE _UNICODE WIN32_LEAN_AND_MEAN NOMINMAX
    _WIN32_WINNT=0x0A00
    PB_NAMED_PIPE_FAULT_INJECTION=1
  )
  target_link_libraries(pbwin-pipe-tests PRIVATE nlohmann_json::nlohmann_json user32 advapi32)
  if(MSVC)
    target_compile_options(pbwin-pipe-tests PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  add_test(NAME pbwin-pipe-nonreading-client COMMAND pbwin-pipe-tests)
  set_tests_properties(pbwin-pipe-nonreading-client PROPERTIES TIMEOUT 20)

  add_executable(pbwin-pipe-listener-recovery-policy-tests
    tests/PipeListenerRecoveryPolicyTests.cpp
    src/PipeListenerRecoveryPolicy.cpp
  )
  target_include_directories(pbwin-pipe-listener-recovery-policy-tests PRIVATE include)
  if(MSVC)
    target_compile_options(pbwin-pipe-listener-recovery-policy-tests PRIVATE
      /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  else()
    target_compile_options(pbwin-pipe-listener-recovery-policy-tests PRIVATE
      -Wall -Wextra -Wpedantic)
  endif()
  add_test(NAME pbwin-pipe-listener-recovery-policy-contract
           COMMAND pbwin-pipe-listener-recovery-policy-tests)

  add_executable(pbwin-display-timing-tests
    tests/DisplayTimingTests.cpp
    src/DisplayTiming.cpp
  )
  target_include_directories(pbwin-display-timing-tests PRIVATE include)
  if(MSVC)
    target_compile_options(pbwin-display-timing-tests PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  add_test(NAME pbwin-display-timing-contract COMMAND pbwin-display-timing-tests)

  add_executable(pbwin-recovery-policy-tests
    tests/RecoveryPolicyTests.cpp
    src/RecoveryPolicy.cpp
  )
  target_include_directories(pbwin-recovery-policy-tests PRIVATE include)
  if(MSVC)
    target_compile_options(pbwin-recovery-policy-tests PRIVATE /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  add_test(NAME pbwin-recovery-policy-contract COMMAND pbwin-recovery-policy-tests)

  add_executable(pbwin-latest-snapshot-mailbox-tests
    tests/LatestSnapshotMailboxTests.cpp
  )
  target_include_directories(pbwin-latest-snapshot-mailbox-tests PRIVATE include)
  if(MSVC)
    target_compile_options(pbwin-latest-snapshot-mailbox-tests PRIVATE
      /W4 /permissive- /EHsc /utf-8 /Zc:__cplusplus)
  endif()
  add_test(NAME pbwin-latest-snapshot-mailbox-contract
           COMMAND pbwin-latest-snapshot-mailbox-tests)
endif()

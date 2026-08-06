# Windows execution-host toolchain for audiopus_sys's bundled Opus build.
# CMake and the compiler are discovered from the installed Visual Studio
# toolchain. The Ninja generator needs an explicit program before project().
set(_vswhere "C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe")
if(NOT EXISTS "${_vswhere}")
  message(FATAL_ERROR "Visual Studio Installer's vswhere.exe was not found")
endif()
execute_process(
  COMMAND "${_vswhere}"
    -latest
    -products *
    -requires Microsoft.VisualStudio.Component.VC.CMake.Project
    -find "Common7\\IDE\\CommonExtensions\\Microsoft\\CMake\\Ninja\\ninja.exe"
  OUTPUT_VARIABLE _ninja
  OUTPUT_STRIP_TRAILING_WHITESPACE
  COMMAND_ERROR_IS_FATAL ANY
)
if(NOT EXISTS "${_ninja}")
  message(FATAL_ERROR "Visual Studio's bundled ninja.exe was not found")
endif()
file(TO_CMAKE_PATH "${_ninja}" _ninja)
set(CMAKE_MAKE_PROGRAM "${_ninja}" CACHE FILEPATH "Visual Studio bundled Ninja" FORCE)

cmake_host_system_information(
  RESULT _windows_kits_root
  QUERY WINDOWS_REGISTRY "HKLM/SOFTWARE/Microsoft/Windows Kits/Installed Roots"
  VALUE "KitsRoot10"
  VIEW 64
)
if(NOT _windows_kits_root)
  message(FATAL_ERROR "Windows 10 SDK installation was not found")
endif()

file(GLOB _windows_sdk_tool_dirs LIST_DIRECTORIES true "${_windows_kits_root}/bin/*/x64")
list(SORT _windows_sdk_tool_dirs COMPARE NATURAL ORDER DESCENDING)
find_program(CMAKE_RC_COMPILER NAMES rc.exe HINTS ${_windows_sdk_tool_dirs} NO_DEFAULT_PATH REQUIRED)
find_program(CMAKE_MT NAMES mt.exe HINTS ${_windows_sdk_tool_dirs} NO_DEFAULT_PATH REQUIRED)

# CMake's Ninja + vs_link_exe path emits unquoted -LIBPATH entries for Program
# Files. The linker already receives equivalent directories through LIB.
set(CMAKE_C_IMPLICIT_LINK_DIRECTORIES "")
set(CMAKE_CXX_IMPLICIT_LINK_DIRECTORIES "")

# CMake 3.31 can fail its ABI try_compile after the compiler probe succeeds.
# The system MSVC ABI and pointer size are fixed for this x64 target.
set(CMAKE_C_COMPILER_WORKS TRUE)
set(CMAKE_CXX_COMPILER_WORKS TRUE)
set(CMAKE_C_ABI_COMPILED TRUE)
set(CMAKE_CXX_ABI_COMPILED TRUE)
set(CMAKE_SIZEOF_VOID_P 8)

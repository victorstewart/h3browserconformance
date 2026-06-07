cmake_minimum_required(VERSION 3.16)

project(h3browserconformance_pico_baton C)

set(PICOQUIC_ROOT "" CACHE PATH "Path to the picoquic checkout under test")
if (NOT PICOQUIC_ROOT)
    message(FATAL_ERROR "Set PICOQUIC_ROOT to the picoquic checkout under test")
endif()

get_filename_component(PICOQUIC_ROOT "${PICOQUIC_ROOT}" ABSOLUTE)
if (NOT EXISTS "${PICOQUIC_ROOT}/CMakeLists.txt")
    message(FATAL_ERROR "PICOQUIC_ROOT does not point to a picoquic checkout: ${PICOQUIC_ROOT}")
endif()

set(BUILD_HTTP ON CACHE BOOL "" FORCE)
set(BUILD_DEMO OFF CACHE BOOL "" FORCE)
set(BUILD_TESTING OFF CACHE BOOL "" FORCE)
set(picoquic_BUILD_TESTS OFF CACHE BOOL "" FORCE)

add_subdirectory("${PICOQUIC_ROOT}" "${CMAKE_BINARY_DIR}/picoquic")

add_executable(pico_baton
    baton_app.c
    wt_baton.c)

target_link_libraries(pico_baton
    PRIVATE
        picoquic-log
        picoquic-core
        picohttp-core)

target_include_directories(pico_baton
    PRIVATE
        "${CMAKE_CURRENT_SOURCE_DIR}"
        "${PICOQUIC_ROOT}/loglib"
        "${PICOQUIC_ROOT}/picoquic"
        "${PICOQUIC_ROOT}/picohttp")

if (COMMAND set_picoquic_compile_settings)
    set_picoquic_compile_settings(pico_baton)
endif()

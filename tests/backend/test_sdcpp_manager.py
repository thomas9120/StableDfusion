"""Unit tests for the Phase 1 asset-pattern matcher in sdcpp_manager.

These cover the project's signature departure from LLama-GUI: stable-
diffusion.cpp release asset names embed the commit hash and (on macOS) the
build OS version, so assets must be matched by glob pattern — never built from
the tag. See PLAN.md §11.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services import sdcpp_manager  # noqa: E402

# Realistic asset names observed from the live GitHub releases API.
WIN_ASSETS = [
    {"name": "cudart-sd-bin-win-cu12-x64.zip", "browser_download_url": "url-cudart"},
    {"name": "sd-master-92a3b73-bin-win-avx-x64.zip", "browser_download_url": "url-avx"},
    {"name": "sd-master-92a3b73-bin-win-avx2-x64.zip", "browser_download_url": "url-avx2"},
    {"name": "sd-master-92a3b73-bin-win-avx512-x64.zip", "browser_download_url": "url-avx512"},
    {"name": "sd-master-92a3b73-bin-win-cuda12-x64.zip", "browser_download_url": "url-cuda12"},
    {"name": "sd-master-92a3b73-bin-win-vulkan-x64.zip", "browser_download_url": "url-vulkan"},
]

MAC_ASSET_NAME = "sd-master-92a3b73-bin-Darwin-macOS-15.7.7-arm64.zip"
MAC_ASSETS = [{"name": MAC_ASSET_NAME, "browser_download_url": "url-mac"}]

FUTURE_MAC_NAME = "sd-master-deadbeef-bin-Darwin-macOS-16.4.0-arm64.zip"


def name_of(asset):
    """Assert the matcher found something, then return its name (type-narrows)."""
    assert asset is not None, "expected a matching asset"
    return asset["name"]


def test_build_backend_specs_win32_x64_has_recommended_default_first():
    specs = sdcpp_manager.build_backend_specs("win32", "x64")
    assert "cpu-avx2" in specs
    # avx2 is the recommended default → listed first.
    assert list(specs.keys())[0] == "cpu-avx2"
    # CUDA variant carries the runtime companion.
    assert specs["cuda12"]["companion"] == "cudart-sd-bin-win-cu12-x64.zip"
    assert specs["cuda12"]["asset_pattern"].endswith("-bin-win-cuda12-x64.zip")


def test_build_backend_specs_unsupported_platform_is_empty():
    assert sdcpp_manager.build_backend_specs("win32", "arm64") == {}
    assert sdcpp_manager.build_backend_specs("haiku", "x64") == {}


def test_find_asset_matches_avx2_without_colliding_with_avx_or_avx512():
    specs = sdcpp_manager.build_backend_specs("win32", "x64")
    avx2 = sdcpp_manager.find_asset(WIN_ASSETS, specs["cpu-avx2"]["asset_pattern"])
    avx = sdcpp_manager.find_asset(WIN_ASSETS, specs["cpu-avx"]["asset_pattern"])
    avx512 = sdcpp_manager.find_asset(WIN_ASSETS, specs["cpu-avx512"]["asset_pattern"])
    assert name_of(avx2) == "sd-master-92a3b73-bin-win-avx2-x64.zip"
    assert name_of(avx) == "sd-master-92a3b73-bin-win-avx-x64.zip"
    assert name_of(avx512) == "sd-master-92a3b73-bin-win-avx512-x64.zip"


def test_find_asset_cuda12_main_pattern_does_not_match_cudart_companion():
    # The companion is `cu12`, the main asset is `cuda12` — the glob must not
    # accidentally pull in the companion when resolving the main backend asset.
    specs = sdcpp_manager.build_backend_specs("win32", "x64")
    main = sdcpp_manager.find_asset(WIN_ASSETS, specs["cuda12"]["asset_pattern"])
    assert name_of(main) == "sd-master-92a3b73-bin-win-cuda12-x64.zip"
    companion = sdcpp_manager.find_asset_by_name(WIN_ASSETS, specs["cuda12"]["companion"])
    assert name_of(companion) == "cudart-sd-bin-win-cu12-x64.zip"


def test_find_asset_macos_pattern_survives_os_version_bump():
    # The macOS asset embeds the build OS version (15.7.7); the glob wildcard
    # must match it AND tolerate a future version bump.
    specs = sdcpp_manager.build_backend_specs("darwin", "arm64")
    pattern = specs["metal"]["asset_pattern"]
    assert name_of(sdcpp_manager.find_asset(MAC_ASSETS, pattern)) == MAC_ASSET_NAME
    future = [{"name": FUTURE_MAC_NAME, "browser_download_url": "x"}]
    assert sdcpp_manager.find_asset(future, pattern) is not None


def test_find_asset_returns_none_when_no_match():
    assert sdcpp_manager.find_asset(WIN_ASSETS, "*-bin-win-rocm-7.1.1-x64.zip") is None
    assert sdcpp_manager.find_asset([], "*-bin-win-avx2-x64.zip") is None


def test_sha256_file_matches_hashlib(tmp_path):
    import hashlib

    payload = b"stable-diffusion" * 100
    f = tmp_path / "blob.bin"
    f.write_bytes(payload)
    assert sdcpp_manager.sha256_file(f) == hashlib.sha256(payload).hexdigest()

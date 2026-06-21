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

from backend.context import AppContext, AppPaths  # noqa: E402
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


def make_ctx(tmp_path, initial_config):
    cfg = dict(initial_config)
    paths = AppPaths(
        root=tmp_path,
        sdcpp=tmp_path / "sdcpp",
        sdcpp_bin=tmp_path / "sdcpp" / "bin",
        sdcpp_installs=tmp_path / "sdcpp" / "installs",
        models=tmp_path / "models",
        output=tmp_path / "output",
        output_preview=tmp_path / "output" / ".preview",
        output_gallery=tmp_path / "output" / ".gallery",
        presets=tmp_path / "presets",
        config_file=tmp_path / "config.json",
        ui=tmp_path / "ui",
        app_logo=tmp_path / "assets" / "logo.png",
        tools=tmp_path / "tools",
        cloudflared=tmp_path / "tools" / "cloudflared",
    )
    ctx = AppContext(paths=paths)
    ctx.services.load_config = lambda: dict(cfg)

    def save_config(next_cfg):
        cfg.clear()
        cfg.update(next_cfg)

    ctx.services.save_config = save_config
    ctx.services.sdcpp_tools = ("sd-cli", "sd-server")
    ctx.services.get_tool_filename = lambda tool: tool + ".exe"
    ctx.services.current_platform = "win32"
    return ctx, cfg


def test_normalize_install_config_migrates_legacy_shape():
    cfg = sdcpp_manager.normalize_install_config(
        {"version": "Build 1", "tag": "master-1-abc", "backend": "vulkan"}
    )
    assert cfg["active_install"] == {
        "tag": "master-1-abc",
        "backend": "vulkan",
        "version": "Build 1",
    }
    assert cfg["installed_backends"] == [cfg["active_install"]]


def test_active_runtime_uses_install_folder_when_present(tmp_path):
    ctx, _cfg = make_ctx(
        tmp_path,
        {
            "active_install": {
                "tag": "master-1-abc",
                "backend": "vulkan",
                "version": "Build 1",
            },
            "installed_backends": [
                {"tag": "master-1-abc", "backend": "vulkan", "version": "Build 1"}
            ],
        },
    )
    expected = tmp_path / "sdcpp" / "installs" / "master-1-abc" / "vulkan" / "bin"
    expected.mkdir(parents=True)
    assert sdcpp_manager.get_active_runtime_bin(ctx) == expected


def test_active_runtime_falls_back_to_legacy_bin_for_existing_install(tmp_path):
    ctx, _cfg = make_ctx(
        tmp_path,
        {"version": "Build 1", "tag": "master-1-abc", "backend": "vulkan"},
    )
    ctx.paths.sdcpp_bin.mkdir(parents=True)
    assert sdcpp_manager.get_active_runtime_bin(ctx) == ctx.paths.sdcpp_bin


def test_remove_runtime_deletes_only_target_and_selects_next_active(tmp_path):
    ctx, cfg = make_ctx(
        tmp_path,
        {
            "active_install": {
                "tag": "master-1-abc",
                "backend": "vulkan",
                "version": "Build 1",
            },
            "installed_backends": [
                {"tag": "master-1-abc", "backend": "vulkan", "version": "Build 1"},
                {"tag": "master-1-abc", "backend": "cpu-avx2", "version": "Build 1"},
            ],
        },
    )
    vulkan = sdcpp_manager.runtime_bin_dir(ctx, "master-1-abc", "vulkan")
    cpu = sdcpp_manager.runtime_bin_dir(ctx, "master-1-abc", "cpu-avx2")
    vulkan.mkdir(parents=True)
    cpu.mkdir(parents=True)
    (vulkan / "sd-cli.exe").write_bytes(b"vulkan")
    (cpu / "sd-cli.exe").write_bytes(b"cpu")

    result = sdcpp_manager.remove_runtime(ctx, "master-1-abc", "vulkan")

    assert result["removed_files"] == 1
    assert not vulkan.exists()
    assert (cpu / "sd-cli.exe").exists()
    assert cfg["active_install"]["backend"] == "cpu-avx2"

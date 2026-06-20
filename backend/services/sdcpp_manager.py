"""stable-diffusion.cpp release management.

TODO(Phase 1). Unlike LLama-GUI (which builds asset names from the release
tag), stable-diffusion.cpp releases are continuous builds (tag
``master-<n>-<commit>``) and asset names embed the commit short-hash, e.g.
``sd-master-92a3b73-bin-win-cuda12-x64.zip``. We therefore match assets by a
per-variant suffix pattern against each release's ``assets[]``.

See PLAN.md §11.
"""

from collections.abc import Mapping
from typing import Any

from ..context import AppContext


def build_backend_specs(current_platform: str, current_arch: str) -> dict[str, dict[str, Any]]:
    """Return ``{variant_key: {label, asset_suffix, companion?}}`` per platform.

    ``asset_suffix`` is matched against the end of a release asset filename.
    A ``companion`` entry (e.g. the cudart runtime zip) is downloaded alongside.
    """
    # TODO(Phase 1): verify exact suffixes against a live release and add Linux
    # rocm/macOS variants. Skeleton values below reflect the observed naming.
    if current_platform == "win32" and current_arch == "x64":
        return {
            "cpu-avx2": {"label": "CPU (AVX2)", "asset_suffix": "-bin-win-avx2-x64.zip"},
            "cpu-avx": {"label": "CPU (AVX)", "asset_suffix": "-bin-win-avx-x64.zip"},
            "cpu-avx512": {"label": "CPU (AVX512)", "asset_suffix": "-bin-win-avx512-x64.zip"},
            "cpu-noavx": {"label": "CPU (no AVX)", "asset_suffix": "-bin-win-noavx-x64.zip"},
            "cuda12": {
                "label": "CUDA 12 (NVIDIA)",
                "asset_suffix": "-bin-win-cuda12-x64.zip",
                "companion": "cudart-sd-bin-win-cu12-x64.zip",
            },
            "vulkan": {"label": "Vulkan", "asset_suffix": "-bin-win-vulkan-x64.zip"},
            "rocm-7.1.1": {
                "label": "ROCm 7.1.1 (AMD)",
                "asset_suffix": "-bin-win-rocm-7.1.1-x64.zip",
            },
            "rocm-7.13.0": {
                "label": "ROCm 7.13.0 (AMD)",
                "asset_suffix": "-bin-win-rocm-7.13.0-x64.zip",
            },
        }
    if current_platform.startswith("linux") and current_arch == "x64":
        return {
            "cpu": {"label": "CPU", "asset_suffix": "-bin-Linux-Ubuntu-24.04-x86_64.zip"},
            "vulkan": {
                "label": "Vulkan",
                "asset_suffix": "-bin-Linux-Ubuntu-24.04-x86_64-vulkan.zip",
            },
        }
    if current_platform == "darwin" and current_arch == "arm64":
        return {
            "metal": {
                "label": "Metal (Apple Silicon)",
                # suffix match against the macOS arm64 asset name
                "asset_suffix": "-bin-Darwin-macOS-15.7.7-arm64.zip",
            },
        }
    return {}


def get_releases(ctx: AppContext) -> list[dict[str, Any]]:
    # TODO(Phase 1): fetch ctx.config.github_api with certifi SSL, cache short-term.
    raise NotImplementedError


def install_release(
    ctx: AppContext, tag: str, backend: str, backend_specs: Mapping[str, Mapping[str, Any]]
):
    # TODO(Phase 1): resolve asset by suffix, download, sha256 verify, extract
    # into ctx.paths.sdcpp_bin, save config.json.
    raise NotImplementedError


def download_file(ctx, url, dest, progress_cb=None):
    # TODO(Phase 1): streaming download updating ctx.state.download_progress.
    raise NotImplementedError


def sha256_file(path) -> str:
    import hashlib

    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()

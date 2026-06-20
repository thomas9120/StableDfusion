"""Hugging Face model/component downloads.

Adapted from LLama-GUI's hf_download.py. Key difference: SD models are
multi-file bundles, so this supports downloading several components per repo
(diffusion model + vae + clip + t5xxl ...) and accepts more file types than
GGUF-only.

TODO(Phase 3): repo listing (multi-format), multi-file download with cancel,
path-traversal + repo-id validation, partial-file cleanup.
"""

import re
from collections.abc import Mapping

from ..context import AppContext

ALLOWED_EXTENSIONS = (".safetensors", ".ckpt", ".pth", ".pt", ".gguf", ".sft", ".bin")

_REPO_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*?/[A-Za-z0-9][A-Za-z0-9._-]*$")
_SAFE_FILENAME_RE = re.compile(r"^[A-Za-z0-9._\-/]+$")


def validate_hf_repo_id(repo_id: str) -> bool:
    return bool(_REPO_ID_RE.match(repo_id or ""))


def validate_hf_filename(filename: str) -> bool:
    name = filename or ""
    if "/" in name or ".." in name:
        return False
    return bool(_SAFE_FILENAME_RE.match(name)) and name.lower().endswith(ALLOWED_EXTENSIONS)


def get_repo_files(
    ctx: AppContext, repo_id: str, revision: str = "main", token: str | None = None
) -> Mapping:
    # TODO(Phase 3): use huggingface_hub.HfApi.model_info / list_repo_files.
    raise NotImplementedError


def start_download(ctx: AppContext, request: dict) -> dict:
    # TODO(Phase 3): spawn background download thread, report progress via
    # ctx.state.model_download, support cancel via ctx.state.model_download_cancel.
    raise NotImplementedError

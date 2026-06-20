"""Model component folder layout helpers.

Stable-diffusion.cpp model bundles are multi-file, so keeping every component
in ``models/`` quickly becomes noisy. This module centralizes the purpose →
folder mapping used by model listing, file pickers, and HF downloads.
"""

from pathlib import Path
from typing import Any

from ..context import AppContext

MODEL_SUBDIRS = {
    "diffusion": "diffusion",
    "vae": "vae",
    "text_encoders": "text-encoders",
    "loras": "loras",
}

PURPOSE_SUBDIR: dict[str, str] = {
    "model": MODEL_SUBDIRS["diffusion"],
    "diffusion_model": MODEL_SUBDIRS["diffusion"],
    "high_noise_diffusion_model": MODEL_SUBDIRS["diffusion"],
    "uncond_diffusion_model": MODEL_SUBDIRS["diffusion"],
    "vae": MODEL_SUBDIRS["vae"],
    "audio_vae": MODEL_SUBDIRS["vae"],
    "taesd": MODEL_SUBDIRS["vae"],
    "clip_l": MODEL_SUBDIRS["text_encoders"],
    "clip_g": MODEL_SUBDIRS["text_encoders"],
    "clip_vision": MODEL_SUBDIRS["text_encoders"],
    "t5xxl": MODEL_SUBDIRS["text_encoders"],
    "llm": MODEL_SUBDIRS["text_encoders"],
    "llm_vision": MODEL_SUBDIRS["text_encoders"],
    "embeddings_connectors": MODEL_SUBDIRS["text_encoders"],
    "embd_dir": MODEL_SUBDIRS["text_encoders"],
    "lora": MODEL_SUBDIRS["loras"],
    "lora_model_dir": MODEL_SUBDIRS["loras"],
}

FLAG_PURPOSES: dict[str, str] = {
    "-m": "model",
    "--model": "model",
    "--diffusion-model": "diffusion_model",
    "--high-noise-diffusion-model": "high_noise_diffusion_model",
    "--uncond-diffusion-model": "uncond_diffusion_model",
    "--vae": "vae",
    "--audio-vae": "audio_vae",
    "--taesd": "taesd",
    "--tae": "taesd",
    "--clip_l": "clip_l",
    "--clip_g": "clip_g",
    "--clip_vision": "clip_vision",
    "--t5xxl": "t5xxl",
    "--llm": "llm",
    "--llm_vision": "llm_vision",
    "--qwen2vl": "llm",
    "--qwen2vl_vision": "llm_vision",
    "--lora-model-dir": "lora_model_dir",
}


def ensure_model_subdirs(ctx: AppContext) -> None:
    ctx.paths.models.mkdir(parents=True, exist_ok=True)
    for subdir in MODEL_SUBDIRS.values():
        (ctx.paths.models / subdir).mkdir(parents=True, exist_ok=True)


def subdir_for_purpose(purpose: Any) -> str | None:
    normalized = str(purpose or "").strip().lower()
    return PURPOSE_SUBDIR.get(normalized)


def directory_for_purpose(ctx: AppContext, purpose: Any) -> Path:
    subdir = subdir_for_purpose(purpose)
    return ctx.paths.models / subdir if subdir else ctx.paths.models


def roots_for_listing(ctx: AppContext, purpose: Any) -> tuple[Path, ...]:
    """Return roots to search for a purpose.

    Purpose-specific lists include the dedicated subfolder plus the root
    ``models/`` folder for legacy files. The root fallback is handled as direct
    files only by callers so one component picker doesn't leak another folder.
    """
    subdir = subdir_for_purpose(purpose)
    if not subdir:
        return (ctx.paths.models,)
    return (ctx.paths.models / subdir, ctx.paths.models)


def infer_subdir_for_filename(filename: str) -> str:
    """Best-effort HF download destination from a repo filename."""
    lowered = (filename or "").replace("\\", "/").lower()
    parts = [p for p in lowered.split("/") if p]
    leaf = parts[-1] if parts else lowered
    joined = "/".join(parts)

    if any(token in joined for token in ("lora", "loras", "lycoris")):
        return MODEL_SUBDIRS["loras"]
    if (
        "vae" in joined
        or leaf in {"ae.safetensors", "ae.gguf", "taesd.safetensors"}
        or leaf.startswith("ae.")
    ):
        return MODEL_SUBDIRS["vae"]
    if any(
        token in joined
        for token in (
            "text_encoder",
            "text-encoder",
            "encoder",
            "clip",
            "t5",
            "t5xxl",
            "llm",
            "qwen",
            "umt5",
        )
    ):
        return MODEL_SUBDIRS["text_encoders"]
    return MODEL_SUBDIRS["diffusion"]


def download_destination_root(models_dir: Path, filename: str) -> Path:
    return models_dir / infer_subdir_for_filename(filename)


def resolve_legacy_model_path(ctx: AppContext, flag: str, value: Any) -> str:
    """Map old ``models/<file>`` values to the new component folder if needed."""
    text = str(value or "")
    normalized = text.replace("\\", "/")
    if not normalized.startswith("models/") or normalized.count("/") != 1:
        return text

    current = (ctx.paths.root / normalized).resolve()
    if current.exists():
        return text

    purpose = FLAG_PURPOSES.get(flag)
    subdir = subdir_for_purpose(purpose)
    if not subdir:
        return text

    candidate = ctx.paths.models / subdir / normalized.split("/", 1)[1]
    if candidate.exists():
        return candidate.relative_to(ctx.paths.root).as_posix()
    return text


def rewrite_legacy_model_args(ctx: AppContext, pairs: list[Any]) -> list[Any]:
    rewritten: list[Any] = []
    for pair in pairs or []:
        if not isinstance(pair, (list, tuple)) or len(pair) < 2:
            rewritten.append(pair)
            continue
        flag = str(pair[0])
        value = resolve_legacy_model_path(ctx, flag, pair[1])
        rewritten.append([pair[0], value, *list(pair[2:])])
    return rewritten

"""Native file picker via tkinter (and osascript on macOS).

~Verbatim from LLama-GUI's generic picker, with SD-specific purpose filters and
initial-directory rules (model-component purposes default to ``models/``).
"""

import json
import platform
import subprocess
from collections.abc import Sequence
from pathlib import Path
from typing import Any

from ..context import AppContext

FileTypes = Sequence[tuple[str, str]]

# purpose -> (filetypes, title) for the native dialog. SD model components come
# in several weight formats (.safetensors/.ckpt/.gguf/.sft/.bin/.pth).
PURPOSE_FILTERS: dict[str, tuple[list[tuple[str, str]], str]] = {
    "diffusion_model": (
        [("Model", "*.safetensors *.ckpt *.gguf *.sft *.bin *.pth")],
        "Select diffusion model",
    ),
    "model": ([("Model", "*.safetensors *.ckpt *.gguf *.sft *.bin *.pth")], "Select model"),
    "vae": ([("VAE", "*.safetensors *.ckpt *.gguf *.sft *.bin")], "Select VAE"),
    "clip_l": ([("CLIP", "*.safetensors *.gguf *.bin")], "Select CLIP-L"),
    "clip_g": ([("CLIP", "*.safetensors *.gguf *.bin")], "Select CLIP-G"),
    "t5xxl": ([("T5", "*.safetensors *.gguf *.bin")], "Select T5XXL"),
    "llm": ([("LLM encoder", "*.safetensors *.gguf *.bin")], "Select LLM text encoder"),
    "taesd": ([("TAESD", "*.safetensors *.gguf *.bin")], "Select TAESD"),
    "esrgan": ([("ESRGAN", "*.pth *.safetensors")], "Select ESRGAN upscaler"),
    "control": ([("ControlNet", "*.pth *.safetensors")], "Select ControlNet"),
    "lora": ([("LoRA", "*.safetensors *.gguf *.bin")], "Select LoRA"),
    "image": ([("Image", "*.png *.jpg *.jpeg *.webp *.bmp")], "Select image"),
}

# Purposes that should default the picker to the models/ directory.
MODEL_PURPOSES = {
    "diffusion_model",
    "model",
    "vae",
    "clip_l",
    "clip_g",
    "t5xxl",
    "llm",
    "taesd",
    "esrgan",
    "control",
    "lora",
}


def _extensions_from_filetypes(filetypes: FileTypes | None) -> list[str]:
    extensions: list[str] = []
    seen: set[str] = set()
    for _label, pattern_group in filetypes or []:
        for pattern in str(pattern_group or "").split():
            if not pattern.startswith("*."):
                continue
            ext = pattern[2:].strip().lower()
            if not ext or ext == "*" or ext in seen:
                continue
            seen.add(ext)
            extensions.append(ext)
    return extensions


def _applescript_list(values: Sequence[str]) -> str:
    return "{" + ", ".join(json.dumps(v) for v in values) + "}"


def select_file_with_osascript(
    title: str = "Select File",
    initial_dir: Path | None = None,
    filetypes: FileTypes | None = None,
) -> str:
    initial = Path(initial_dir or Path.home()).expanduser()
    extensions = _extensions_from_filetypes(filetypes)
    type_clause = ""
    if extensions:
        type_clause = f" of type {_applescript_list(extensions)}"

    script = (
        "set dialogTitle to item 1 of argv\n"
        "set initialDir to item 2 of argv\n"
        "set selectedFile to choose file with prompt dialogTitle "
        "default location (POSIX file initialDir)"
        f"{type_clause}\n"
        "return POSIX path of selectedFile\n"
    )
    result = subprocess.run(
        ["osascript", "-e", f"on run argv\n{script}end run", str(title), str(initial)],
        capture_output=True,
        text=True,
        timeout=300,
    )
    if result.returncode == 1 and "User canceled" in result.stderr:
        return ""
    if result.returncode != 0:
        message = (result.stderr or result.stdout or "macOS file picker failed.").strip()
        raise RuntimeError(message)
    return result.stdout.strip()


def select_file_in_native_dialog(
    title: str = "Select File",
    initial_dir: Path | None = None,
    filetypes: FileTypes | None = None,
) -> str:
    if platform.system() == "Darwin":
        return select_file_with_osascript(title, initial_dir, filetypes)

    try:
        import tkinter as tk
        from tkinter import filedialog
    except Exception as exc:
        raise RuntimeError(f"Native file picker unavailable: {exc}") from exc

    root = tk.Tk()
    root.withdraw()
    try:
        root.attributes("-topmost", True)
    except Exception:
        pass

    dialog_options: dict[str, Any] = {"title": title, "parent": root}
    if initial_dir:
        dialog_options["initialdir"] = str(initial_dir)
    if filetypes:
        dialog_options["filetypes"] = filetypes

    try:
        root.update()
        return filedialog.askopenfilename(**dialog_options) or ""
    finally:
        root.destroy()


def get_select_file_options(
    ctx: AppContext, purpose: Any, title: Any
) -> tuple[str, Path, FileTypes]:
    normalized_purpose = str(purpose or "model").strip().lower()
    normalized_title = str(title or "").strip() or "Select File"

    initial_dir = ctx.paths.models if normalized_purpose in MODEL_PURPOSES else ctx.paths.root

    filetypes, default_title = PURPOSE_FILTERS.get(
        normalized_purpose, ([("All files", "*.*")], "Select File")
    )
    title = normalized_title if normalized_title != "Select File" else default_title
    return title, initial_dir, filetypes


def select_file(ctx: AppContext, purpose: str, title: str | None = None) -> dict:
    norm_title, initial_dir, filetypes = get_select_file_options(ctx, purpose, title)
    initial_dir.mkdir(parents=True, exist_ok=True)
    selected = select_file_in_native_dialog(
        title=norm_title, initial_dir=initial_dir, filetypes=filetypes
    )
    return {"selected": bool(selected), "path": selected}

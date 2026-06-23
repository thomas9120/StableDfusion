"""sd-cli one-shot generation orchestration — the core signature feature.

See PLAN.md §10. The Generate flow:
  1. POST /api/generate receives {mode, args (user argv pairs), seed, total_steps,
     preview_method, params snapshot}.
  2. build_argv() injects the backend-owned args (-M mode, -o output,
     --preview-path) and strips any user-supplied overrides, then spawns sd-cli
     one-shot via process_manager under the single generation slot.
  3. A worker thread streams output, parses step progress, and polls the
     --preview-path file mtime for the live preview (sd-cli reports per-step
     progress ONLY via the preview callback writing the preview file — its CLI
     step_callback discards the step number to stdout; verified against
     examples/cli/main.cpp commit 92a3b73).
  4. On exit it collects the result image(s) and writes a JSON sidecar to
     output/.gallery/<name>.json.
  5. POST /api/generate/cancel stops the process.

Thumbnail strategy: server-side thumbnails are NOT generated (Pillow is not a
dependency). /api/image/<name>/thumbnail serves the full image and the gallery
<img> scales it down client-side (PLAN.md §16.1 option (b)).
"""

import datetime
import json
import re
import threading
import time
from pathlib import Path
from typing import Any

from ..context import AppContext
from . import model_storage_service, process_manager

SD_MODES = ("img_gen", "vid_gen", "convert", "upscale", "metadata")

# Modes that require a model path (model or diffusion-model) to run.
# upscale requires --upscale-model + --init-img (not a generation model);
# metadata requires --image only (no model at all). The frontend surfaces
# mode-specific required-input errors before reaching the backend, so we only
# re-check the model requirement here as a defensive guard.
MODEL_REQUIRED_MODES = ("img_gen", "vid_gen", "convert")

# Per-mode default output extension. The backend owns -o / --output naming so
# gallery sidecars can locate results; the extension must match what sd-cli
# will actually write for that mode.
#
# vid_gen: sd-cli single-file video outputs support .avi/.webm/animated .webp
# (verified via `sd-cli -h`, commit 92a3b73). We use .webm because it is the only
# one of the three that plays in the in-GUI <video> element (Chrome/Edge/Firefox)
# — .avi is not browser-playable and animated .webp has no playback controls.
MODE_OUTPUT_EXT = {
    "img_gen": ".png",
    "vid_gen": ".webm",
    "upscale": ".png",
    "convert": ".gguf",  # sd-cli's convert target; user can override via custom args
    "metadata": ".txt",  # never written (stdout-only); sentinel for pathing
}

# Per-mode --preview-path extension. sd-cli multi-frame previews support
# .avi/.webm/.webp (image modes stay .png). Must agree with MODE_OUTPUT_EXT's
# video choice so the live preview renders in a <video> element.
MODE_PREVIEW_EXT = {
    "img_gen": ".png",
    "vid_gen": ".webm",
    "upscale": ".png",
    "convert": ".png",
    "metadata": ".png",
}

# Content-Type for a preview file by extension (used by the preview route).
PREVIEW_CONTENT_TYPES = {
    ".png": "image/png",
    ".webm": "video/webm",
    ".avi": "video/x-msvideo",
    ".webp": "image/webp",
}


def preview_ext_for_mode(mode: str) -> str:
    """Preview file extension for a mode (.webm for video, else .png)."""
    return MODE_PREVIEW_EXT.get(mode, ".png")


def preview_content_type_for_mode(mode: str) -> str:
    """HTTP Content-Type for the preview file of a mode."""
    return PREVIEW_CONTENT_TYPES.get(preview_ext_for_mode(mode), "application/octet-stream")


# Modes that produce a file under output/ (vs. writing to stdout).
FILE_PRODUCING_MODES = ("img_gen", "vid_gen", "upscale", "convert")

# Flags the backend owns — strip any user-supplied occurrences so the backend's
# own -M / -o / --preview-path naming for gallery sidecars always wins.
BACKEND_OWNED_VALUE_FLAGS = ("-M", "--mode", "-o", "--output", "--preview-path")

# sd-cli step-line parsing. sd-cli's per-step progress is delivered primarily via
# the preview callback (which writes --preview-path); the sampling progress also
# appears on stdout as a carriage-return-buffered progress bar like
#   "|====>  | 3/6 - 19.57s/it"   (verified against commit 92a3b73 on SD1.5).
# Because the bar is \r-separated within a single line, we split on \r and \n and
# take the latest sampling step match. The generic "step N/M" form is kept as a
# defensive fallback for other log levels / future versions.
_STEP_RE = re.compile(r"step\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)
_SAMPLING_STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s*-\s*[\d.]+\s*s/it")
_SAVED_RE = re.compile(r"(\d+)\s*/\s*(\d+)\s+images?\s+saved", re.IGNORECASE)

# Tokens may not contain control chars / newlines (defensive; subprocess uses a
# list argv, never a shell, so injection is already impossible — this is belt
# and braces).
_TOKEN_RE = re.compile(r"^[^\x00-\x1f\x7f]*$")

_POLL_INTERVAL = 0.25
_METADATA_STDOUT_LIMIT = 4000  # last N bytes of stdout to keep in the sidecar


def parse_step_progress(output: str) -> tuple[int, int] | None:
    """Return (step, total) from the latest sampling progress segment, or None.

    Handles sd-cli's carriage-return-buffered progress bar by splitting on both
    ``\r`` and ``\n``. Prefers the sampling form ``N/M - X.XXs/it``; falls back
    to a generic ``step N/M`` line.
    """
    last: tuple[int, int] | None = None
    # Normalize ANSI clear-line sequences, then split on CR and LF.
    cleaned = re.sub(r"\x1b\[[0-9;]*[A-Za-z]", "", output)
    for segment in re.split(r"[\r\n]", cleaned):
        m = _SAMPLING_STEP_RE.search(segment)
        if not m:
            m = _STEP_RE.search(segment)
        if m:
            last = (int(m.group(1)), int(m.group(2)))
    return last


def _strip_owned_pairs(pairs: list[Any], owned_flags: tuple[str, ...]) -> list[Any]:
    """Remove any pair whose flag is backend-owned (e.g. -o / --preview-path).

    Operates on the structured [flag, value] pair form so a user-supplied value
    that happens to equal a flag name (e.g. a prompt that starts with ``-o``)
    is never mistaken for a flag.
    """
    flagset = set(owned_flags)
    out: list[Any] = []
    for pair in pairs or []:
        if not isinstance(pair, (list, tuple)) or not pair:
            out.append(pair)
            continue
        flag = str(pair[0])
        if flag in flagset:
            continue
        out.append(pair)
    return out


def _strip_value_flags(tokens: list[str], flags: tuple[str, ...]) -> list[str]:
    """Remove each occurrence of ``flags`` and the value that follows it.

    Kept as a defensive fallback for flat argv lists that may arrive from
    non-pair callers. ``build_argv`` now strips from the structured pair form
    via ``_strip_owned_pairs`` first, so this is only reached as a second layer.
    """
    flagset = set(flags)
    out: list[str] = []
    i = 0
    while i < len(tokens):
        tok = tokens[i]
        if tok in flagset:
            i += 2  # drop flag + its value
            continue
        out.append(tok)
        i += 1
    return out


def _validate_tokens(tokens: list[str]) -> None:
    for tok in tokens:
        if not isinstance(tok, str) or not _TOKEN_RE.match(tok):
            raise ValueError(f"Rejected unsafe launch argument token: {tok!r}")
        if len(tok) > 4096:
            raise ValueError("Launch argument token too long")


def build_argv(
    user_args: list[Any],
    mode: str,
    output_path: Path,
    preview_path: Path,
    preview_method: str = "vae",
) -> list[str]:
    """Assemble the final sd-cli argv from user pairs + backend-owned args.

    Pure & unit-testable. ``user_args`` is the list of [flag, value?] pairs from
    the frontend's getLaunchArgs(); backend-owned flags are stripped from the
    structured pair form before flattening so a user-supplied value that happens
    to equal a flag name is never mistaken for an override.
    """
    if mode not in SD_MODES:
        raise ValueError(f"Invalid mode: {mode!r}")

    stripped = _strip_owned_pairs(user_args, BACKEND_OWNED_VALUE_FLAGS)
    flat = process_manager.flatten_launch_args(stripped)
    _validate_tokens(flat)
    cleaned = _strip_value_flags(flat, BACKEND_OWNED_VALUE_FLAGS)

    argv: list[str] = [
        "-M",
        mode,
        *cleaned,
        "-o",
        str(output_path),
        "--preview-path",
        str(preview_path),
    ]

    # Ensure a preview method is set so the preview callback writes the file.
    if "--preview" not in cleaned:
        method = preview_method or "vae"
        argv += ["--preview", method]
    return argv


def _utc_timestamp() -> str:
    return datetime.datetime.now(datetime.UTC).strftime("%Y%m%dT%H%M%S%f")


def _safe_label(value: Any, default: str) -> str:
    """Filename-safe label from a value (seed, etc.)."""
    text = str(value if value is not None else default)
    text = re.sub(r"[^A-Za-z0-9_.-]+", "_", text).strip("_")
    return text or default


def _has_model(user_args: list[Any]) -> bool:
    flagset = {"-m", "--model", "--diffusion-model"}
    for pair in user_args or []:
        if isinstance(pair, (list, tuple)) and pair:
            if str(pair[0]) in flagset and len(pair) > 1 and str(pair[1]):
                return True
    return False


def _prepare(ctx: AppContext, request: dict[str, Any]) -> dict[str, Any]:
    """Validate the request and compute argv + paths + sidecar payload.

    Raises ValueError on invalid input (surfaces as a 400-style error to the
    client via the route handler).
    """
    if not isinstance(request, dict):
        raise ValueError("Invalid request body")

    mode = str(request.get("mode") or "img_gen").strip()
    if mode not in SD_MODES:
        raise ValueError(f"Invalid mode: {mode!r}")

    user_args = request.get("args")
    if not isinstance(user_args, list):
        raise ValueError("Missing 'args' list")
    user_args = model_storage_service.rewrite_legacy_model_args(ctx, user_args)

    if mode in MODEL_REQUIRED_MODES and not _has_model(user_args):
        raise ValueError(
            "No model selected. Choose a model (--model/-m) or diffusion-model for this mode."
        )

    # Seed / steps for naming + progress + sidecar.
    raw_seed = request.get("seed", 42)
    try:
        seed = int(raw_seed)
    except (TypeError, ValueError) as exc:
        raise ValueError("seed must be an integer") from exc
    try:
        total_steps = int(request.get("total_steps", 0) or 0)
    except (TypeError, ValueError) as exc:
        raise ValueError("total_steps must be an integer") from exc

    preview_method = str(request.get("preview_method") or "vae").strip() or "vae"
    if preview_method not in {"none", "proj", "tae", "vae"}:
        raise ValueError(f"Invalid preview method: {preview_method!r}")

    ts = _utc_timestamp()
    seed_label = _safe_label(seed if seed >= 0 else "rnd", "rnd")
    base_name = f"{ts}_{seed_label}"
    ext = MODE_OUTPUT_EXT.get(mode, ".png")
    output_path = ctx.paths.output / f"{base_name}{ext}"
    preview_ext = preview_ext_for_mode(mode)
    preview_path = ctx.paths.output_preview / f"{base_name}{preview_ext}"

    argv = build_argv(user_args, mode, output_path, preview_path, preview_method)

    params_raw = request.get("params")
    params: dict[str, Any] = params_raw if isinstance(params_raw, dict) else {}
    sidecar = {
        "name": base_name,
        "mode": mode,
        "bundle": request.get("bundle", ""),
        "prompt": str(params.get("prompt", request.get("prompt", ""))),
        "negative_prompt": str(params.get("negative_prompt", "")),
        "seed": seed,
        "total_steps": total_steps,
        "preview_method": preview_method,
        "width": params.get("width"),
        "height": params.get("height"),
        "steps": params.get("steps", total_steps or None),
        "cfg_scale": params.get("cfg_scale"),
        "sampling_method": params.get("sampling_method"),
        "scheduler": params.get("scheduler"),
        "flow_shift": params.get("flow_shift"),  # flow models: SD3/Wan (blank = auto)
        "model": params.get("model", ""),
        "diffusion_model": params.get("diffusion_model", ""),
        "image": params.get("image", ""),  # metadata mode input
        "init_img": params.get("init_img", ""),  # img2img / upscale input
        "strength": params.get("strength"),  # img2img denoising strength
        "ref_image": params.get("ref_image", ""),  # Kontext / image-edit reference
        "img_cfg_scale": params.get("img_cfg_scale"),  # edit/inpaint image guidance
        "mask": params.get("mask", ""),  # inpaint mask
        "control_image": params.get("control_image", ""),  # controlnet
        "upscale_model": params.get("upscale_model", ""),
        "convert_name": params.get("convert_name", ""),
        "metadata_format": params.get("metadata_format", ""),
        # Video-specific params (vid_gen) — recorded so history restore and the
        # gallery sidecar carry the full generation context.
        "video_frames": params.get("video_frames"),
        "fps": params.get("fps"),
        "vace_strength": params.get("vace_strength"),
        "end_img": params.get("end_img", ""),  # last frame (flf2v)
        "control_video": params.get("control_video", ""),
        "moe_boundary": params.get("moe_boundary"),  # Wan2.2 MoE
        "extra_tiling_args": params.get("extra_tiling_args", ""),  # LTX VAE tiling
        "timestamp": ts,
        "created_at": datetime.datetime.now(datetime.UTC).isoformat(),
    }
    return {
        "mode": mode,
        "argv": argv,
        "output_path": output_path,
        "preview_path": preview_path,
        "base_name": base_name,
        "total_steps": total_steps,
        "seed": seed,
        "sidecar": sidecar,
    }


def write_sidecar(ctx: AppContext, sidecar: dict[str, Any]) -> Path:
    """Write (or update) the gallery JSON sidecar for a generation. Testable."""
    gallery_dir = ctx.paths.output_gallery
    gallery_dir.mkdir(parents=True, exist_ok=True)
    name = sidecar.get("name") or "generation"
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", str(name)).strip("_") or "generation"
    path = gallery_dir / f"{safe}.json"
    path.write_text(json.dumps(sidecar, indent=2), encoding="utf-8")
    return path


def read_sidecar(path: Path) -> dict[str, Any] | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _collect_results(output_path: Path, base_name: str) -> list[Path]:
    """Collect result files written by sd-cli for this job's base name.

    Matches ``<base_name>*`` (any extension) so convert mode can surface
    ``.gguf`` / ``.safetensors`` results, not just ``.png``. Excludes the
    preview subdirectory so we don't accidentally pick up preview files.
    """
    out_dir = output_path.parent
    if not out_dir.exists():
        return []
    pattern = re.compile(rf"^{re.escape(base_name)}(?:$|[_.-])")
    matches = [p for p in out_dir.iterdir() if p.is_file() and pattern.match(p.stem)]
    # Most recent first (gallery shows newest first).
    matches.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    return matches


def _run_job(
    ctx: AppContext,
    job_id: str,
    prepared: dict[str, Any],
) -> None:
    mode = prepared["mode"]
    argv = prepared["argv"]
    output_path = prepared["output_path"]
    preview_path = prepared["preview_path"]
    base_name = prepared["base_name"]
    total_steps = prepared["total_steps"]
    sidecar = prepared["sidecar"]

    ctx.state.generation.update(
        state="running",
        message="Starting sd-cli…",
    )

    launch = process_manager.launch_process(ctx, "sd-cli", argv)
    if launch.get("error"):
        ctx.state.generation.update(
            state="error",
            message="Failed to start sd-cli",
            error=str(launch["error"])[:500],
            finished_at=time.time(),
        )
        print(f"[generate] launch failed: {launch['error']}", flush=True)
        return

    cmd_line = launch.get("command", " ".join(argv))
    print(f"[generate] {job_id} running sd-cli: {cmd_line}", flush=True)

    last_mtime = 0.0
    step_estimate = 0
    preview_interval = 1
    # Best-effort preview-interval read from argv for a saner step estimate.
    try:
        if "--preview-interval" in argv:
            idx = argv.index("--preview-interval")
            preview_interval = max(1, int(argv[idx + 1]))
    except (ValueError, IndexError):
        preview_interval = 1

    proc = ctx.state.process
    while True:
        if ctx.state.generation_cancel.is_set():
            process_manager.stop_process(ctx)
            ctx.state.generation.update(
                state="canceled",
                message="Generation canceled.",
                finished_at=time.time(),
            )
            return

        proc = ctx.state.process
        running = proc is not None and proc.poll() is None

        # Live preview mtime → step estimate.
        try:
            mtime = preview_path.stat().st_mtime if preview_path.exists() else 0.0
        except OSError:
            mtime = 0.0
        if mtime and mtime != last_mtime:
            last_mtime = mtime
            step_estimate = min(step_estimate + preview_interval, total_steps or step_estimate + 1)
            percent = int(step_estimate * 100 / total_steps) if total_steps else 0
            ctx.state.generation.update(
                step=step_estimate,
                percent=min(percent, 100),
                preview_mtime=int(mtime),
                message=f"Step {step_estimate}" + (f"/{total_steps}" if total_steps else ""),
            )

        # Defensive stdout step parsing (secondary signal).
        snap = process_manager.get_output_snapshot(ctx)
        tail = "\n".join(snap.get("output", [])[-40:])
        parsed = parse_step_progress(tail)
        if parsed:
            s, t = parsed
            step_estimate = max(step_estimate, s)
            total_steps = total_steps or t
            percent = int(s * 100 / t) if t else 0
            update_kwargs: dict[str, Any] = {
                "step": s,
                "total_steps": t,
                "percent": min(percent, 100),
                "message": f"Step {s}/{t}",
            }
            if mtime:
                update_kwargs["preview_mtime"] = int(mtime)
            ctx.state.generation.update(**update_kwargs)

        if not running:
            break
        time.sleep(_POLL_INTERVAL)

    rc = proc.returncode if proc else None
    snap = process_manager.get_output_snapshot(ctx)
    stdout_tail = "\n".join(snap.get("output", [])[-20:])
    stderr_tail = "\n".join(snap.get("stderr", [])[-40:])
    if rc != 0:
        ctx.state.generation.update(
            state="error",
            message=f"sd-cli exited with code {rc}.",
            error=f"exit {rc}",
            stdout_tail=stdout_tail[-2000:],
            stderr_tail=stderr_tail[-2000:],
            finished_at=time.time(),
        )
        print(f"[generate] sd-cli exit {rc} for {job_id}", flush=True)
        if stdout_tail:
            print(f"[generate] sd-cli stdout tail:\n{stdout_tail}", flush=True)
        if stderr_tail:
            print(f"[generate] sd-cli stderr tail:\n{stderr_tail}", flush=True)
        return

    # Log stderr even on success — warnings from sd-cli (VAE issues, flow-shift,
    # tensor mismatches, etc.) are often only written to stderr.
    if stderr_tail:
        print(f"[generate] {job_id} sd-cli stderr:\n{stderr_tail}", flush=True)
    if stdout_tail:
        print(f"[generate] {job_id} sd-cli stdout tail:\n{stdout_tail}", flush=True)

    results = _collect_results(output_path, base_name)
    rel_files = [p.name for p in results]
    sidecar["files"] = rel_files
    sidecar["result_count"] = len(rel_files)
    sidecar["finished_at"] = datetime.datetime.now(datetime.UTC).isoformat()

    # Validate output files have actual content (defensive against silent
    # failures that produce empty or near-empty output).
    warnings: list[str] = []
    if mode in FILE_PRODUCING_MODES:
        for p in results:
            file_size = p.stat().st_size if p.exists() else 0
            if file_size == 0:
                warnings.append(f"{p.name} is 0 bytes (empty output)")
            elif file_size < 64:
                warnings.append(f"{p.name} is only {file_size} bytes (likely corrupt)")
            elif p.suffix.lower() == ".png" and file_size < 1024:
                warnings.append(
                    f"{p.name} is only {file_size} bytes (unusually small PNG — may be all-white)"
                )
        if warnings:
            sidecar["warnings"] = warnings
            for w in warnings:
                print(f"[generate] {job_id} WARNING: {w}", flush=True)

    # Stash stderr tail in the sidecar so frontend can surface it.
    if stderr_tail:
        sidecar["stderr_tail"] = stderr_tail[-4000:]

    # Metadata mode: sd-cli prints to stdout (no output file). Capture the tail
    # so the sidecar carries the result the user actually wanted (the metadata
    # text), and the frontend can render it as text.
    if mode == "metadata":
        full_stdout = "\n".join(process_manager.get_output_snapshot(ctx).get("output", []))
        if len(full_stdout) > _METADATA_STDOUT_LIMIT:
            sidecar["stdout_excerpt"] = (
                "...[truncated]...\n" + full_stdout[-_METADATA_STDOUT_LIMIT:]
            )
        else:
            sidecar["stdout_excerpt"] = full_stdout

    write_sidecar(ctx, sidecar)

    done_message = (
        f"Done — metadata saved ({len(sidecar.get('stdout_excerpt', ''))} chars)."
        if mode == "metadata"
        else f"Done — {len(rel_files)} file(s) saved."
    )
    if warnings:
        done_message += " (with warnings)"
    update_kwargs: dict[str, Any] = {
        "state": "done",
        "step": total_steps or step_estimate,
        "total_steps": total_steps or step_estimate,
        "percent": 100,
        "message": done_message,
        "result_files": rel_files,
        "warnings": warnings,
        "stderr_tail": stderr_tail[-2000:] if stderr_tail else "",
        "finished_at": time.time(),
    }
    if mode == "metadata" and sidecar.get("stdout_excerpt"):
        # Surface the metadata text in the live status payload so the frontend
        # can render it without an extra sidecar fetch.
        update_kwargs["stdout_excerpt"] = sidecar["stdout_excerpt"]
    ctx.state.generation.update(**update_kwargs)


def run(ctx: AppContext, request: dict[str, Any]) -> dict[str, Any]:
    """Start a generation. Returns {job_id} or {error}."""
    try:
        prepared = _prepare(ctx, request)
    except ValueError as exc:
        return {"error": str(exc)}

    with ctx.state.generation_lock:
        if ctx.state.generation.snapshot().get("state") == "running":
            return {"error": "A generation is already running"}
        job_id = prepared["base_name"]
        ctx.state.generation.update(
            state="running",
            job_id=job_id,
            mode=prepared["mode"],
            step=0,
            total_steps=prepared["total_steps"],
            percent=0,
            message="Queued.",
            started_at=time.time(),
            finished_at=0.0,
            preview_mtime=0,
            result_files=[],
            seed=prepared["seed"],
            error="",
        )

    ctx.state.generation_cancel.clear()
    thread = threading.Thread(
        target=_run_job,
        args=(ctx, job_id, prepared),
        daemon=True,
        name=f"generate-{job_id}",
    )
    thread.start()
    return {
        "job_id": job_id,
        "status_url": "/api/generate/status",
        "preview_url": "/api/generate/preview",
    }


def status(ctx: AppContext) -> dict[str, Any]:
    return ctx.state.generation.snapshot()


def cancel(ctx: AppContext) -> bool:
    snap = ctx.state.generation.snapshot()
    if snap.get("state") != "running":
        return False
    ctx.state.generation_cancel.set()
    return True

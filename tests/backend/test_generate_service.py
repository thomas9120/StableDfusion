"""Unit tests for the Phase 2 generate_service (PLAN.md §17).

Covers:
- build_argv(): override-stripping + backend-owned arg injection + --preview ensure.
- parse_step_progress(): step-line regex parsing.
- write/read sidecar round-trip.
- _collect_results(): result-file globbing for batch output.
- _has_model(): required-model detection.
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.context import AppContext, AppPaths  # noqa: E402
from backend.services import generate_service  # noqa: E402


def _ctx(tmp_path: Path) -> AppContext:
    return AppContext(paths=AppPaths(output=tmp_path, output_gallery=tmp_path / ".gallery"))


# ── build_argv ────────────────────────────────────────────────────────────
def test_build_argv_injects_mode_output_preview_path_and_default_preview():
    argv = generate_service.build_argv(
        [["--prompt", "a cat"], ["-W", "512"]],
        "img_gen",
        Path("out/x.png"),
        Path("out/.preview/x.png"),
    )
    assert argv[:2] == ["-M", "img_gen"]
    assert "--prompt" in argv and argv[argv.index("--prompt") + 1] == "a cat"
    assert "-o" in argv and argv[argv.index("-o") + 1] == str(Path("out/x.png"))
    assert "--preview-path" in argv
    # No --preview in user args → backend ensures one (default vae).
    assert "--preview" in argv and argv[argv.index("--preview") + 1] == "vae"


def test_build_argv_strips_user_supplied_overrides():
    argv = generate_service.build_argv(
        [["-o", "evil.png"], ["--preview-path", "x.png"], ["-M", "vid_gen"], ["--steps", "5"]],
        "img_gen",
        Path("out/real.png"),
        Path("out/.preview/real.png"),
    )
    assert "evil.png" not in argv
    assert "x.png" not in argv
    # User -M removed; backend mode (img_gen) wins.
    assert argv.count("-M") == 1
    assert argv[argv.index("-M") + 1] == "img_gen"
    assert "vid_gen" not in argv
    assert argv[argv.index("-o") + 1] == str(Path("out/real.png"))


def test_build_argv_keeps_user_preview_no_duplicate():
    argv = generate_service.build_argv(
        [["--preview", "tae"]],
        "img_gen",
        Path("out/x.png"),
        Path("out/.preview/x.png"),
    )
    assert argv.count("--preview") == 1
    assert argv[argv.index("--preview") + 1] == "tae"


def test_build_argv_rejects_invalid_mode():
    try:
        generate_service.build_argv([], "bogus", Path("o.png"), Path("p.png"))
    except ValueError:
        return
    raise AssertionError("expected ValueError for invalid mode")


def test_build_argv_preserves_multiline_prompts_and_colons():
    prompt = "Scene:\n\nA quiet room:\nsoft lighting"
    negative_prompt = "Avoid:\r\n\tblur:1.2"
    argv = generate_service.build_argv(
        [["--prompt", prompt], ["--negative-prompt", negative_prompt]],
        "img_gen",
        Path("o.png"),
        Path("p.png"),
    )

    assert argv[argv.index("--prompt") + 1] == prompt
    assert argv[argv.index("--negative-prompt") + 1] == negative_prompt


def test_build_argv_preserves_colons_without_newlines():
    prompt = "portrait: dramatic lighting, detail:1.5"
    argv = generate_service.build_argv(
        [["--prompt", prompt]], "img_gen", Path("o.png"), Path("p.png")
    )
    assert argv[argv.index("--prompt") + 1] == prompt


def test_build_argv_rejects_nul_in_prompt():
    try:
        generate_service.build_argv(
            [["--prompt", "line\0break"]], "img_gen", Path("o.png"), Path("p.png")
        )
    except ValueError:
        return
    raise AssertionError("expected ValueError for NUL in prompt")


def test_build_argv_rejects_newline_in_non_prompt_value():
    try:
        generate_service.build_argv(
            [["--model", "models/model\nname.gguf"]],
            "img_gen",
            Path("o.png"),
            Path("p.png"),
        )
    except ValueError:
        return
    raise AssertionError("expected ValueError for newline in model path")


def test_build_argv_rejects_newline_in_custom_argument():
    try:
        generate_service.build_argv([["--custom\nflag"]], "img_gen", Path("o.png"), Path("p.png"))
    except ValueError:
        return
    raise AssertionError("expected ValueError for newline in custom argument")


def test_prepare_rewrites_legacy_flat_model_path(tmp_path):
    ctx = AppContext(
        paths=AppPaths(
            root=tmp_path,
            models=tmp_path / "models",
            output=tmp_path / "output",
            output_gallery=tmp_path / "output" / ".gallery",
            output_preview=tmp_path / "output" / ".preview",
        )
    )
    (ctx.paths.models / "diffusion").mkdir(parents=True)
    (ctx.paths.models / "diffusion" / "z-image.gguf").write_bytes(b"x")

    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "img_gen",
            "args": [["--diffusion-model", "models/z-image.gguf"]],
            "seed": 42,
            "total_steps": 1,
            "params": {"diffusion_model": "models/z-image.gguf"},
        },
    )

    argv = prepared["argv"]
    assert "models/diffusion/z-image.gguf" in argv


# ── parse_step_progress ───────────────────────────────────────────────────
def test_parse_step_progress_single():
    assert generate_service.parse_step_progress("step 5/20") == (5, 20)


def test_parse_step_progress_last_match_wins():
    out = "loading model...\nstep 1/20\nstep 2/20\nstep 3/20\n"
    assert generate_service.parse_step_progress(out) == (3, 20)


def test_parse_step_progress_no_match():
    assert generate_service.parse_step_progress("nothing here") is None
    assert generate_service.parse_step_progress("") is None


def test_parse_step_progress_real_sampling_bar():
    # Real sd-cli stdout (commit 92a3b73, SD1.5): a carriage-return-buffered
    # progress bar with ANSI clear-line sequences. Latest sampling step wins.
    snippet = (
        "1/6 - 19.11s/it\x1b[K  2/6 - 19.53s/it\x1b[K  3/6 - 19.57s/it"
        "\r4/6 - 19.46s/it\r5/6\r6/6 - 20.00s/it"
    )
    assert generate_service.parse_step_progress(snippet) == (6, 6)


def test_parse_step_progress_ignores_model_load_bars():
    # Model-loading progress bars (e.g. "3/196") use MB/s, not s/it, so they
    # must NOT be mistaken for sampling steps.
    snippet = "|###  | 3/196 - 0.00MB/s\r|###  | 196/196 - 326.81MB/s"
    assert generate_service.parse_step_progress(snippet) is None


# ── sidecar round-trip ────────────────────────────────────────────────────
def test_sidecar_write_and_read(tmp_path):
    ctx = _ctx(tmp_path)
    path = generate_service.write_sidecar(ctx, {"name": "20240101T000000_42", "prompt": "cat"})
    assert path.name == "20240101T000000_42.json"
    data = generate_service.read_sidecar(path)
    assert data is not None
    assert data["prompt"] == "cat"


def test_sidecar_name_sanitized(tmp_path):
    ctx = _ctx(tmp_path)
    path = generate_service.write_sidecar(ctx, {"name": "../escape/../weird name!"})
    # No path separators survive → the file lives inside the gallery dir.
    assert path.parent.resolve() == ctx.paths.output_gallery.resolve()
    assert path.exists()


def test_read_sidecar_invalid_returns_none(tmp_path):
    bad = tmp_path / "bad.json"
    bad.write_text("{not json", encoding="utf-8")
    assert generate_service.read_sidecar(bad) is None


# ── _collect_results ──────────────────────────────────────────────────────
def test_collect_results_single_and_batch(tmp_path):
    base = "20240101T000000_42"
    (tmp_path / f"{base}.png").write_bytes(b"x")
    (tmp_path / f"{base}_1.png").write_bytes(b"y")
    results = generate_service._collect_results(tmp_path / f"{base}.png", base)
    names = [p.name for p in results]
    assert f"{base}.png" in names
    assert f"{base}_1.png" in names


def test_collect_results_ignores_unrelated(tmp_path):
    base = "20240101T000000_42"
    (tmp_path / f"{base}.png").write_bytes(b"x")
    (tmp_path / "unrelated_99.png").write_bytes(b"z")
    results = generate_service._collect_results(tmp_path / f"{base}.png", base)
    names = [p.name for p in results]
    assert names == [f"{base}.png"]


# ── _has_model ────────────────────────────────────────────────────────────
def test_has_model_detects_model_and_diffusion():
    assert generate_service._has_model([["-m", "a.gguf"]]) is True
    assert generate_service._has_model([["--diffusion-model", "b.gguf"]]) is True
    assert generate_service._has_model([["--steps", "5"]]) is False
    assert generate_service._has_model([["-m", ""]]) is False
    assert generate_service._has_model([]) is False


# ── Phase 3: mode-specific output + result collection ──────────────────


def test_prepare_uses_png_for_img_gen(tmp_path):
    ctx = _ctx(tmp_path)
    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "img_gen",
            "args": [["-m", "m.gguf"], ["--prompt", "cat"]],
            "seed": 42,
            "total_steps": 6,
            "preview_method": "vae",
        },
    )
    assert prepared["output_path"].suffix == ".png"
    assert prepared["output_path"].parent == tmp_path


def test_prepare_uses_gguf_for_convert(tmp_path):
    ctx = _ctx(tmp_path)
    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "convert",
            "args": [["-m", "src.safetensors"], ["--convert-name", "x"]],
            "seed": 1,
            "total_steps": 0,
            "preview_method": "none",
        },
    )
    assert prepared["output_path"].suffix == ".gguf"


def test_prepare_metadata_does_not_require_model(tmp_path):
    ctx = _ctx(tmp_path)
    # metadata mode: no -m / --model; only --image.
    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "metadata",
            "args": [["--image", "in.png"], ["--metadata-format", "text"]],
            "seed": 0,
            "total_steps": 0,
            "preview_method": "none",
            "params": {"image": "in.png"},
        },
    )
    assert prepared["mode"] == "metadata"
    assert prepared["sidecar"]["image"] == "in.png"


def test_prepare_upscale_requires_no_diffusion_model(tmp_path):
    ctx = _ctx(tmp_path)
    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "upscale",
            "args": [
                ["-i", "small.png"],
                ["--upscale-model", "esrgan.pth"],
                ["--upscale-repeats", "2"],
            ],
            "seed": 0,
            "total_steps": 0,
            "preview_method": "none",
            "params": {"init_img": "small.png", "upscale_model": "esrgan.pth"},
        },
    )
    assert prepared["mode"] == "upscale"
    assert prepared["sidecar"]["init_img"] == "small.png"
    assert prepared["sidecar"]["upscale_model"] == "esrgan.pth"


def test_prepare_records_image_edit_params(tmp_path):
    ctx = _ctx(tmp_path)
    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "img_gen",
            "args": [
                ["--model", "model.safetensors"],
                ["--prompt", "change the sign"],
                ["--init-img", "init.png"],
                ["--ref-image", "ref.png"],
                ["--strength", "0.55"],
                ["--img-cfg-scale", "1.25"],
            ],
            "seed": 0,
            "total_steps": 20,
            "preview_method": "none",
            "params": {
                "prompt": "change the sign",
                "init_img": "init.png",
                "ref_image": "ref.png",
                "strength": 0.55,
                "img_cfg_scale": 1.25,
            },
        },
    )
    sidecar = prepared["sidecar"]
    assert sidecar["init_img"] == "init.png"
    assert sidecar["ref_image"] == "ref.png"
    assert sidecar["strength"] == 0.55
    assert sidecar["img_cfg_scale"] == 1.25


def test_collect_results_includes_non_png(tmp_path):
    """convert mode produces a .gguf (or other non-PNG); _collect_results must
    surface it (Phase 3: globbed by extension)."""
    base = "20240101T000000_42"
    (tmp_path / f"{base}.gguf").write_bytes(b"x")
    (tmp_path / "unrelated.gguf").write_bytes(b"y")
    results = generate_service._collect_results(tmp_path / f"{base}.gguf", base)
    names = [p.name for p in results]
    assert f"{base}.gguf" in names
    assert "unrelated.gguf" not in names


# ── Phase 6: video mode (vid_gen) output + preview naming ───────────────
def test_video_mode_output_extension_is_webm():
    # sd-cli single-file video out supports .avi/.webm/.webp; .webm is the only
    # one that plays in the in-GUI <video> element, so that's the GUI default.
    assert generate_service.MODE_OUTPUT_EXT["vid_gen"] == ".webm"
    assert generate_service.preview_ext_for_mode("vid_gen") == ".webm"
    assert generate_service.preview_content_type_for_mode("vid_gen") == "video/webm"


def test_preview_ext_for_image_modes_is_png():
    assert generate_service.preview_ext_for_mode("img_gen") == ".png"
    assert generate_service.preview_ext_for_mode("upscale") == ".png"
    assert generate_service.preview_content_type_for_mode("img_gen") == "image/png"


def test_prepare_vid_gen_uses_webm_output_and_preview(tmp_path):
    ctx = _ctx(tmp_path)
    prepared = generate_service._prepare(
        ctx,
        {
            "mode": "vid_gen",
            "args": [["--diffusion-model", "wan.gguf"], ["--video-frames", "25"]],
            "seed": 7,
            "total_steps": 30,
            "preview_method": "vae",
            "params": {
                "diffusion_model": "wan.gguf",
                "video_frames": 25,
                "fps": 16,
                "vace_strength": 0.6,
                "end_img": "output/last.png",
            },
        },
    )
    assert prepared["output_path"].suffix == ".webm"
    # Preview must match the video extension so the live <video> can render it.
    assert prepared["preview_path"].suffix == ".webm"
    # argv carries -M vid_gen and the -o .webm path.
    assert "-M" in prepared["argv"]
    assert prepared["argv"][prepared["argv"].index("-M") + 1] == "vid_gen"
    assert prepared["argv"][prepared["argv"].index("-o") + 1].endswith(".webm")
    # Sidecar records the video-specific params for history restore.
    side = prepared["sidecar"]
    assert side["video_frames"] == 25
    assert side["fps"] == 16
    assert side["vace_strength"] == 0.6
    assert side["end_img"] == "output/last.png"
    assert side["mode"] == "vid_gen"


# ── run()/_run_job lifecycle regressions ──────────────────────────────────


def test_run_job_unexpected_exception_sets_error_state(tmp_path, monkeypatch):
    """A crash in the worker must not leave state stuck at "running" (which
    would 409 every subsequent /api/generate until restart)."""
    ctx = _ctx(tmp_path)
    ctx.state.generation.update(state="running", job_id="job1")

    def boom(*args, **kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(generate_service, "_run_job_inner", boom)
    generate_service._run_job(ctx, "job1", {})

    snap = ctx.state.generation.snapshot()
    assert snap["state"] == "error"
    assert "disk full" in snap["error"]
    assert snap["finished_at"] > 0


def test_run_resets_stale_fields_from_previous_job(tmp_path, monkeypatch):
    """Keys added dynamically by a previous job (warnings, stderr_tail,
    stdout_excerpt) must not leak into the next job's status payload."""
    ctx = _ctx(tmp_path)
    ctx.state.generation.update(
        state="done",
        warnings=["old warning"],
        stderr_tail="old stderr",
        stdout_tail="old stdout",
        stdout_excerpt="old metadata",
    )

    # Don't actually spawn sd-cli — capture the reset state instead.
    class _FakeThread:
        def __init__(self, *args, **kwargs):
            pass

        def start(self):
            pass

    monkeypatch.setattr(generate_service.threading, "Thread", _FakeThread)

    result = generate_service.run(
        ctx,
        {
            "mode": "img_gen",
            "args": [["-m", "m.gguf"], ["--prompt", "cat"]],
            "seed": 7,
            "total_steps": 4,
        },
    )
    assert "job_id" in result

    snap = ctx.state.generation.snapshot()
    assert snap["state"] == "running"
    assert snap["seed"] == 7
    for stale_key in ("warnings", "stderr_tail", "stdout_tail", "stdout_excerpt"):
        assert stale_key not in snap


def test_build_argv_strips_orphaned_custom_arg_values():
    """Custom launch args arrive as single-token pairs; stripping an owned flag
    must also drop its following value token (no stray positional arg)."""
    argv = generate_service.build_argv(
        [["--prompt", "cat"], ["-o"], ["evil.png"], ["--vae-tiling"]],
        "img_gen",
        Path("out/real.png"),
        Path("out/.preview/real.png"),
    )
    assert "evil.png" not in argv
    assert "--vae-tiling" in argv
    assert argv.count("-o") == 1
    assert argv[argv.index("-o") + 1] == str(Path("out/real.png"))


def test_build_argv_preview_value_in_prompt_does_not_suppress_injection():
    """A prompt equal to "--preview" is a value, not a flag — the backend must
    still inject its own --preview method."""
    argv = generate_service.build_argv(
        [["--prompt", "--preview"]],
        "img_gen",
        Path("out/x.png"),
        Path("out/.preview/x.png"),
        preview_method="tae",
    )
    # One occurrence as the prompt value, one injected as a flag with "tae".
    assert argv.count("--preview") == 2
    assert argv[argv.index("--prompt") + 1] == "--preview"
    assert "tae" in argv


def test_build_argv_custom_arg_preview_still_detected():
    """--preview supplied as single custom-arg tokens must not be duplicated."""
    argv = generate_service.build_argv(
        [["--preview"], ["proj"]],
        "img_gen",
        Path("out/x.png"),
        Path("out/.preview/x.png"),
    )
    assert argv.count("--preview") == 1
    assert argv[argv.index("--preview") + 1] == "proj"

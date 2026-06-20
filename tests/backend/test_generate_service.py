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


def test_build_argv_rejects_unsafe_token():
    try:
        generate_service.build_argv(
            [["--prompt", "line\nbreak"]], "img_gen", Path("o.png"), Path("p.png")
        )
    except ValueError:
        return
    raise AssertionError("expected ValueError for newline token")


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

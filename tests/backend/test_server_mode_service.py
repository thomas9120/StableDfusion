import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.services import server_mode_service  # noqa: E402


def test_build_argv_curated_flags_and_listener():
    result = server_mode_service.build_argv(
        {
            "host": "127.0.0.1",
            "port": 1234,
            "args": [
                ["--model", "models/sd15.gguf"],
                ["--width", "768"],
                ["--diffusion-fa"],
            ],
        }
    )

    assert result["target_url"] == "http://127.0.0.1:1234"
    assert result["args"][:4] == ["--listen-ip", "127.0.0.1", "--listen-port", "1234"]
    assert "--model" in result["args"]
    assert "models/sd15.gguf" in result["args"]
    assert "--diffusion-fa" in result["args"]


def test_build_argv_strips_listener_from_curated_pairs_and_extra_args():
    result = server_mode_service.build_argv(
        {
            "host": "0.0.0.0",
            "port": 8123,
            "args": [
                ["--listen-port", "9999"],
                ["--diffusion-model", "models/diffusion/model.gguf"],
                ["--steps", "12"],
            ],
            "extra_args": "--listen-ip 1.2.3.4 --cache-mode easycache",
        }
    )

    assert result["args"][:4] == ["--listen-ip", "0.0.0.0", "--listen-port", "8123"]
    assert "9999" not in result["args"]
    assert "1.2.3.4" not in result["args"]
    assert "--cache-mode" in result["args"]


def test_build_argv_rejects_unknown_curated_flag():
    result = None
    try:
        result = server_mode_service.build_argv({"args": [["--not-real", "x"]]})
    except ValueError as exc:
        assert "Unsupported curated server flag" in str(exc)
    assert result is None


def test_build_argv_rejects_bad_port():
    try:
        server_mode_service.build_argv({"port": 70000})
    except ValueError as exc:
        assert "port" in str(exc)
    else:
        raise AssertionError("bad port was accepted")


def test_build_argv_rejects_missing_startup_model():
    try:
        server_mode_service.build_argv({"args": [["--steps", "12"]]})
    except ValueError as exc:
        assert "model" in str(exc)
    else:
        raise AssertionError("missing model was accepted")

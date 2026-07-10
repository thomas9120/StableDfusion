"""Unit tests for backend/http.py origin allow-listing."""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.http import get_allowed_request_origins, is_safe_request_origin  # noqa: E402


def test_allowed_origins_include_loopback_defaults():
    origins = get_allowed_request_origins(None, "127.0.0.1", 5250)
    assert "http://127.0.0.1:5250" in origins
    assert "http://localhost:5250" in origins


def test_allowed_origins_include_extra_hosts():
    # SD_GUI_ALLOWED_HOSTS entries must be admitted as origins on the GUI port.
    origins = get_allowed_request_origins(
        None, "0.0.0.0", 5250, extra_hosts=("192.168.1.20", "mybox.local")
    )
    assert "http://192.168.1.20:5250" in origins
    assert "http://mybox.local:5250" in origins


def test_allowed_origins_bracket_ipv6_hosts():
    origins = get_allowed_request_origins(None, "::", 5250, extra_hosts=("fe80::1",))
    assert "http://[fe80::1]:5250" in origins
    assert "http://[::]:5250" in origins


def test_allowed_origins_include_tunnel_url():
    origins = get_allowed_request_origins("https://abc.trycloudflare.com/", "127.0.0.1", 5250)
    assert "https://abc.trycloudflare.com" in origins


def test_extra_host_origin_passes_safety_check():
    origins = get_allowed_request_origins(None, "0.0.0.0", 5250, extra_hosts=("192.168.1.20",))
    headers = {"Origin": "http://192.168.1.20:5250"}
    assert is_safe_request_origin(headers, origins) is True


def test_unknown_origin_fails_safety_check():
    origins = get_allowed_request_origins(None, "127.0.0.1", 5250)
    headers = {"Origin": "http://evil.example:5250"}
    assert is_safe_request_origin(headers, origins) is False

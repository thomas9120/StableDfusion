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


# ── Host-header validation (DNS-rebinding guard) ──────────────────────────


def test_trusted_host_allows_loopback_on_loopback_bind():
    from backend.http import is_trusted_request_host

    assert is_trusted_request_host("127.0.0.1:5250", "127.0.0.1") is True
    assert is_trusted_request_host("localhost:5250", "127.0.0.1") is True
    assert is_trusted_request_host("[::1]:5250", "127.0.0.1") is True


def test_trusted_host_rejects_foreign_host_on_loopback_bind():
    from backend.http import is_trusted_request_host

    # DNS rebinding: attacker.example resolves to 127.0.0.1 but the browser
    # still sends the attacker's Host header.
    assert is_trusted_request_host("attacker.example:5250", "127.0.0.1") is False
    assert is_trusted_request_host("attacker.example", "127.0.0.1") is False


def test_trusted_host_allows_missing_host_header():
    from backend.http import is_trusted_request_host

    # Non-browser clients may omit Host; not a rebinding vector.
    assert is_trusted_request_host("", "127.0.0.1") is True


def test_trusted_host_allows_gui_host_and_allowed_hosts():
    from backend.http import is_trusted_request_host

    assert is_trusted_request_host("192.168.1.5:5250", "192.168.1.5") is True
    assert (
        is_trusted_request_host("mybox.local:5250", "127.0.0.1", allowed_hosts=("mybox.local",))
        is True
    )
    assert (
        is_trusted_request_host("other.local:5250", "127.0.0.1", allowed_hosts=("mybox.local",))
        is False
    )


def test_trusted_host_allows_tunnel_host():
    from backend.http import is_trusted_request_host

    assert (
        is_trusted_request_host(
            "abc.trycloudflare.com", "127.0.0.1", tunnel_host="abc.trycloudflare.com"
        )
        is True
    )


def test_trusted_host_wildcard_bind_trusts_any_host():
    from backend.http import is_trusted_request_host

    # Explicit LAN-exposure mode keeps the existing trust-the-Host behavior.
    assert is_trusted_request_host("anything.example:5250", "0.0.0.0") is True
    assert is_trusted_request_host("anything.example:5250", "::") is True

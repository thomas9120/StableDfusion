"""Unit tests for GUI bind security and shared-secret API auth (F3/F6)."""

import hmac
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.config import parse_env_bool, parse_gui_token  # noqa: E402
from backend.http import (  # noqa: E402
    InsecureBindError,
    extract_request_token,
    insecure_bind_warning,
    is_gui_token_authorized,
    is_loopback_bind_host,
    request_requires_gui_token,
    require_secure_bind,
    token_matches,
)


def test_parse_gui_token_strips_and_empty():
    assert parse_gui_token(None) == ""
    assert parse_gui_token("  secret  ") == "secret"
    assert parse_gui_token("") == ""


def test_parse_env_bool_truthy_falsy():
    assert parse_env_bool("1") is True
    assert parse_env_bool("true") is True
    assert parse_env_bool("YES") is True
    assert parse_env_bool("0") is False
    assert parse_env_bool("false") is False
    assert parse_env_bool(None, default=False) is False
    assert parse_env_bool("", default=True) is True
    assert parse_env_bool("maybe", default=False) is False


def test_is_loopback_bind_host():
    assert is_loopback_bind_host("127.0.0.1") is True
    assert is_loopback_bind_host("localhost") is True
    assert is_loopback_bind_host("::1") is True
    assert is_loopback_bind_host("127.0.0.2") is True
    assert is_loopback_bind_host("0.0.0.0") is False
    assert is_loopback_bind_host("::") is False
    assert is_loopback_bind_host("192.168.1.5") is False
    assert is_loopback_bind_host("*") is False


def test_require_secure_bind_loopback_ok():
    require_secure_bind("127.0.0.1", token="", allow_insecure=False)
    require_secure_bind("localhost", token="", allow_insecure=False)


def test_require_secure_bind_non_loopback_without_token_raises():
    with pytest.raises(InsecureBindError):
        require_secure_bind("0.0.0.0", token="", allow_insecure=False)
    with pytest.raises(InsecureBindError):
        require_secure_bind("192.168.1.10", token="", allow_insecure=False)


def test_require_secure_bind_non_loopback_with_token_ok():
    require_secure_bind("0.0.0.0", token="s3cret", allow_insecure=False)


def test_require_secure_bind_allow_insecure_ok():
    require_secure_bind("0.0.0.0", token="", allow_insecure=True)
    warn = insecure_bind_warning("0.0.0.0", token="", allow_insecure=True)
    assert warn is not None
    assert "WARNING" in warn


def test_insecure_bind_warning_absent_when_token_or_loopback():
    assert insecure_bind_warning("127.0.0.1", "", False) is None
    assert insecure_bind_warning("0.0.0.0", "tok", False) is None
    assert insecure_bind_warning("0.0.0.0", "", False) is None


def test_request_requires_gui_token_policy():
    assert request_requires_gui_token("POST", "/api/generate", "") is False
    assert request_requires_gui_token("POST", "/api/generate", "tok") is True
    assert request_requires_gui_token("GET", "/api/status", "tok") is False
    assert request_requires_gui_token("DELETE", "/api/presets/x", "tok") is True
    assert request_requires_gui_token("GET", "/v1/models", "tok") is True
    assert request_requires_gui_token("POST", "/sdapi/v1/txt2img", "tok") is True
    assert request_requires_gui_token("GET", "/js/app.js", "tok") is False


def test_extract_request_token_bearer_and_header():
    assert extract_request_token({"Authorization": "Bearer abc"}) == "abc"
    assert extract_request_token({"Authorization": "bearer xyz"}) == "xyz"
    assert extract_request_token({"X-SD-GUI-Token": "from-header"}) == "from-header"
    assert extract_request_token({}) is None
    assert extract_request_token({"Authorization": "Basic nope"}) is None


def test_token_matches_compare_digest():
    assert token_matches("secret", "secret") is True
    assert token_matches("wrong", "secret") is False
    assert token_matches(None, "secret") is False
    assert token_matches("secret", "") is False
    # Different lengths must not raise (compare_digest-safe).
    assert token_matches("short", "much-longer-token") is False
    assert hmac.compare_digest("a", "a") is True


def test_is_gui_token_authorized_loopback_no_token():
    # No token configured → always authorized (desktop UX).
    assert is_gui_token_authorized({}, "POST", "/api/shutdown", "") is True


def test_is_gui_token_authorized_requires_header_when_configured():
    token = "test-token-value"
    assert is_gui_token_authorized({}, "POST", "/api/generate", token) is False
    assert (
        is_gui_token_authorized({"Authorization": "Bearer wrong"}, "POST", "/api/generate", token)
        is False
    )
    assert (
        is_gui_token_authorized(
            {"Authorization": f"Bearer {token}"}, "POST", "/api/generate", token
        )
        is True
    )
    assert (
        is_gui_token_authorized({"X-SD-GUI-Token": token}, "POST", "/api/sd-server/start", token)
        is True
    )
    # Safe GET still allowed without header.
    assert is_gui_token_authorized({}, "GET", "/api/status", token) is True
    # Proxy always requires token when configured.
    assert is_gui_token_authorized({}, "GET", "/v1/models", token) is False
    assert (
        is_gui_token_authorized({"Authorization": f"Bearer {token}"}, "GET", "/v1/models", token)
        is True
    )

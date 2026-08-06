"""Shared HTTPS download URL / asset-name guards for GitHub release assets."""

from __future__ import annotations

from pathlib import Path
from urllib.parse import urlparse

# Exact hosts used by GitHub release asset downloads (initial URL + redirects).
ALLOWED_GITHUB_DOWNLOAD_HOSTS = frozenset(
    {
        "github.com",
        "objects.githubusercontent.com",
        "release-assets.githubusercontent.com",
        "codeload.github.com",
    }
)


def validate_github_download_url(url: str) -> str:
    """Return a stripped HTTPS GitHub-asset URL, or raise ValueError."""
    if not isinstance(url, str) or not url.strip():
        raise ValueError("Download URL is empty.")
    cleaned = url.strip()
    parsed = urlparse(cleaned)
    if parsed.scheme != "https":
        raise ValueError("Download URL must use HTTPS.")
    if parsed.username is not None or parsed.password is not None:
        raise ValueError("Download URL must not contain credentials.")
    host = (parsed.hostname or "").lower()
    if host not in ALLOWED_GITHUB_DOWNLOAD_HOSTS:
        raise ValueError(f"Download host not allowed: {host or '(none)'!r}.")
    if not parsed.path or parsed.path == "/":
        raise ValueError("Download URL path is empty.")
    return cleaned


def safe_download_basename(name: str) -> str:
    """Return a single path segment suitable as a download filename."""
    if not isinstance(name, str) or not name.strip():
        raise ValueError("Download asset name is empty.")
    raw = name.strip()
    if any(sep in raw for sep in ("/", "\\")):
        raise ValueError(f"Unsafe download asset name: {name!r}.")
    base = Path(raw).name
    if not base or base in {".", ".."} or base != raw:
        raise ValueError(f"Unsafe download asset name: {name!r}.")
    return base


def parse_github_asset_digest(asset: dict) -> str | None:
    """Extract a hex SHA-256 from GitHub asset metadata when present."""
    if not isinstance(asset, dict):
        return None
    direct = asset.get("sha256")
    if isinstance(direct, str) and direct.strip():
        return direct.strip().lower()
    digest = asset.get("digest")
    if isinstance(digest, str):
        digest = digest.strip()
        if digest.lower().startswith("sha256:"):
            return digest.split(":", 1)[1].strip().lower()
    return None

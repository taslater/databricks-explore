"""The MCP bearer token (a 0600 file under the data directory), the local-only Host and Origin checks, and session ids."""
import hashlib
import hmac
import os
import secrets
import uuid
from typing import Optional
from urllib.parse import urlsplit

from .. import dbx

LOCAL_HOSTS = ("127.0.0.1", "localhost", "::1")


def token_path():
    """data/mcp_token, under whatever dbx.DATA is when called."""
    return dbx.DATA / "mcp_token"


def _write(path, token: str) -> None:
    """Write the token with mode 0600 from the start (never briefly readable by others), replacing any older file."""
    tmp = path.parent / (path.name + ".tmp")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(token + "\n")
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def get_token() -> str:
    """The token. Created on first use. A file with looser permissions is tightened to 0600."""
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        token = path.read_text(encoding="utf-8").strip()
    except OSError:
        token = ""
    if not token:
        token = secrets.token_urlsafe(32)
        _write(path, token)
    elif path.stat().st_mode & 0o077:
        os.chmod(path, 0o600)
    return token


def new_token() -> str:
    """Replace the token. Every agent configured with the old one gets a 401 until it is given the new one."""
    path = token_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    token = secrets.token_urlsafe(32)
    _write(path, token)
    return token


def bearer_ok(header: Optional[str]) -> bool:
    """True when the Authorization header is `Bearer <the token>`. Compared in constant time."""
    if not header or not header.lower().startswith("bearer "):
        return False
    return hmac.compare_digest(header[7:].strip().encode(), get_token().encode())


def _hostname(netloc_or_url: str) -> str:
    parts = urlsplit(netloc_or_url if "//" in netloc_or_url else "//" + netloc_or_url)
    return (parts.hostname or "").lower()


def host_is_local(host_header: Optional[str]) -> bool:
    """The Host header names this machine. A DNS-rebinding page reaches us under its own name, which fails this."""
    return _hostname(host_header or "") in LOCAL_HOSTS


def origin_is_local(origin: Optional[str]) -> bool:
    """No Origin (a non-browser client) is fine. A browser's Origin must be a local address; "null" is not."""
    if origin is None:
        return True
    return _hostname(origin) in LOCAL_HOSTS


def new_session_id() -> str:
    """A session id the server can recognize later without keeping a table: a random part and its HMAC under the token."""
    sid = uuid.uuid4().hex
    return f"{sid}.{_mac(sid)}"


def session_ok(session_id: Optional[str]) -> bool:
    """True for an id new_session_id() made under the current token."""
    if not session_id or "." not in session_id:
        return False
    sid, mac = session_id.rsplit(".", 1)
    return hmac.compare_digest(mac, _mac(sid))


def _mac(sid: str) -> str:
    return hmac.new(get_token().encode(), sid.encode(), hashlib.sha256).hexdigest()[:24]

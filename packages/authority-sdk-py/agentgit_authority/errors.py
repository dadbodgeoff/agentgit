"""Error types for the Python authority SDK."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal


AuthorityClientTransportErrorCode = Literal[
    "SOCKET_CONNECT_FAILED",
    "SOCKET_CONNECT_TIMEOUT",
    "SOCKET_RESPONSE_TIMEOUT",
    "SOCKET_CLOSED",
    "INVALID_RESPONSE",
]


@dataclass(slots=True)
class AuthorityClientTransportError(Exception):
    """Raised when the daemon cannot be reached or returns malformed transport data."""

    message: str
    code: AuthorityClientTransportErrorCode
    retryable: bool
    details: dict[str, object] | None = None

    def __str__(self) -> str:
        return self.message


@dataclass(slots=True)
class AuthorityDaemonResponseError(Exception):
    """Raised when the daemon returns a structured error envelope."""

    message: str
    code: str
    error_class: str
    retryable: bool
    details: dict[str, object] | None = None

    def __str__(self) -> str:
        return self.message

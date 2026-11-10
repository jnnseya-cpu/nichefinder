"""Typed errors mapped to the §16 HTTP contract."""
from __future__ import annotations


class TrendIntelError(Exception):
    code = "ERROR"
    http_status = 400
    retryable = False

    def __init__(self, message: str = "", **extra):
        super().__init__(message or self.code)
        self.message = message or self.code
        self.extra = extra


class NotFound(TrendIntelError):
    code = "NOT_FOUND"
    http_status = 404


class Conflict(TrendIntelError):
    code = "CONFLICT"
    http_status = 409


class TargetRevisionConflict(Conflict):
    code = "TARGET_REVISION_CONFLICT"


class Invalid(TrendIntelError):
    code = "INVALID"
    http_status = 422


class Forbidden(TrendIntelError):
    code = "FORBIDDEN"
    http_status = 403


class QuotaExceeded(TrendIntelError):
    code = "QUOTA_EXCEEDED"
    http_status = 429


class Unavailable(TrendIntelError):
    code = "UNAVAILABLE"
    http_status = 503
    retryable = True


class Precondition(TrendIntelError):
    code = "PRECONDITION_REQUIRED"
    http_status = 428

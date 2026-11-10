"""Trend Intelligence AI — reference engine (stack-neutral core).

Implements the deterministic, keyless core of the build spec v2.3:
signal ingestion -> scoring -> versioned Growth Brief -> gated action
execution on an owned surface -> measurement -> rollback.

The package has zero third-party dependencies (stdlib only) so the core
workflow runs anywhere. The FastAPI surface in services/api/ and the
canonical JSON-Schema validation in schema.py use optional libraries when
present and fall back to the built-in validator otherwise.
"""

__version__ = "0.1.0"
SCHEMA_VERSION = 1

"""Inference router — spec §2, §14 (host AI adapter), §17.

Three routes, selected per installation and server-authorised:

  host         reuse the platform's already-configured AI gateway. The host
               keeps provider credentials; the module never sees a key.
  deployment   model service shipped with the product (bundled/local
               inference). Customers supply no AI key.
  deterministic  local templates/scoring with no model at all.

Hard rules enforced here:
  * No implicit cross-provider fallback. On route failure we fall back only
    to templates, OR to an alternate route that was EXPLICITLY authorised
    for this installation (§14).
  * Provider secrets never enter module config, prompts, or logs (TI-18).
  * Output is schema-validated and claim-checked AFTER inference (caller).
  * Structured-output retry: up to one retry on invalid JSON (§17), bounded
    by a deadline; exhaustion -> template route (caller may make a review task).
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Callable, Optional

HOST = "host"
DEPLOYMENT = "deployment"
DETERMINISTIC = "deterministic"


class InferenceUnavailable(Exception):
    """Route could not serve. Never carries a provider secret."""


@dataclass
class InferenceRequest:
    installation_id: str
    request_id: str
    purpose: str
    model_alias: str
    schema_revision: str
    sanitized_input: dict
    deadline_s: float = 60.0
    max_tokens: int = 1024


@dataclass
class InferenceResponse:
    request_id: str
    route: str
    output: dict
    model_identifier: Optional[str]
    status: str  # ok | template | review_required
    usage: dict = field(default_factory=dict)


# A route callable takes an InferenceRequest and returns a structured dict,
# or raises InferenceUnavailable. It must NOT require a provider key argument.
RouteFn = Callable[["InferenceRequest"], dict]


class InferenceRouter:
    def __init__(
        self,
        *,
        template_fn: RouteFn,
        host_fn: Optional[RouteFn] = None,
        deployment_fn: Optional[RouteFn] = None,
        route: str = DETERMINISTIC,
        authorised_alternate: Optional[str] = None,
        validate_fn: Optional[Callable[[dict], bool]] = None,
    ):
        self.template_fn = template_fn
        self._routes = {HOST: host_fn, DEPLOYMENT: deployment_fn}
        self.route = route
        self.authorised_alternate = authorised_alternate
        self.validate_fn = validate_fn or (lambda _d: True)
        self.calls: list[str] = []  # trace (route names only; no secrets)

    def _run_with_retry(self, fn: RouteFn, req: InferenceRequest) -> dict:
        deadline = time.monotonic() + req.deadline_s
        last_err = None
        for attempt in range(2):  # initial + one retry (§17)
            if time.monotonic() > deadline:
                raise InferenceUnavailable("deadline exceeded")
            out = fn(req)
            if self.validate_fn(out):
                return out
            last_err = "invalid structured output"
        raise InferenceUnavailable(last_err or "exhausted")

    def generate_structured(self, req: InferenceRequest) -> InferenceResponse:
        order = [self.route]
        if self.authorised_alternate and self.authorised_alternate != self.route:
            order.append(self.authorised_alternate)  # explicitly authorised only

        for route in order:
            if route == DETERMINISTIC:
                break
            fn = self._routes.get(route)
            if fn is None:
                continue
            self.calls.append(route)
            try:
                out = self._run_with_retry(fn, req)
                return InferenceResponse(
                    request_id=req.request_id, route=route, output=out,
                    model_identifier=out.get("_model"), status="ok",
                    usage={"attempts": 1},
                )
            except InferenceUnavailable:
                continue  # fall through to templates (no implicit provider swap)

        # Deterministic template route — always available, keyless.
        self.calls.append(DETERMINISTIC)
        out = self.template_fn(req)
        return InferenceResponse(
            request_id=req.request_id, route=DETERMINISTIC, output=out,
            model_identifier=None, status="template", usage={},
        )

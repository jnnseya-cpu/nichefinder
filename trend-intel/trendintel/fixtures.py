"""Two synthetic installations — spec §22 first implementation ticket.

Fixture A: subscription service, Canadian English, qualified trial starts,
           uses a fake host-AI gateway, public feeds enabled.
Fixture B: storefront, French (France), completed orders, bundled local
           (deployment) inference, NO public feeds — independent first-party
           source families only.

Both run on the same core build with no platform-name branching (TI-17).
"""
from __future__ import annotations

import json
import os

from . import entitlement, profiles
from .store import Store

_FIX = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                    "contracts", "fixtures")


def _load(name: str) -> dict:
    with open(os.path.join(_FIX, name), "r", encoding="utf-8") as fh:
        return json.load(fh)


def bootstrap(store: Store) -> dict:
    out = {}
    out["A"] = _install(
        store, organisation="org_demo", profile_file="profile.fixture_platform_a.json",
        environment="prod", plan="managed_growth", draft_cap=500,
        asset_id="asset_onboarding_page",
        asset_fields={"title": "Team onboarding",
                      "meta_description": "Onboard your team.",
                      "body_block": "Getting started."},
        locales={"en-CA"},
    )
    out["B"] = _install(
        store, organisation="org_demo", profile_file="profile.fixture_platform_b.json",
        environment="prod", plan="managed_growth", draft_cap=500,
        asset_id="asset_categorie_rentree",
        asset_fields={"title": "Rentree",
                      "meta_description": "Collection de rentree.",
                      "body_block": "Decouvrez la collection."},
        locales={"fr-FR"},
    )
    return out


def _install(store: Store, *, organisation: str, profile_file: str,
             environment: str, plan: str, draft_cap: int, asset_id: str,
             asset_fields: dict, locales: set[str]) -> dict:
    profile = _load(profile_file)
    iid = store.create_installation(organisation, profile["platform_slug"],
                                    environment, mode=profile.get("mode", "draft_only"))
    policy_version = 5
    revision = profiles.put_profile(store, iid, profile, policy_version=policy_version)
    entitlement.provision(store, iid, plan=plan, draft_cap=draft_cap)
    return {
        "installation_id": iid,
        "platform_slug": profile["platform_slug"],
        "profile": profile,
        "profile_revision": revision,
        "policy_version": policy_version,
        "market": profile["default_market"],
        "locale": profile["default_locale"],
        "locales": locales,
        "asset_id": asset_id,
        "asset_fields": asset_fields,
        "public_feeds_enabled": profile.get("public_feeds_enabled", False),
    }

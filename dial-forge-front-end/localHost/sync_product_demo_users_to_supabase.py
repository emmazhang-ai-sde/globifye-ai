#!/usr/bin/env python3
"""Seed local product demo users into Supabase Auth and public product tables."""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


SCRIPT_DIR = Path(__file__).resolve().parent
FRONTEND_ROOT = SCRIPT_DIR.parent
REPO_ROOT = FRONTEND_ROOT.parent
DEMO_USERS_PATH = SCRIPT_DIR / "product_demo_users.json"
DEFAULT_ENV_PATH = REPO_ROOT / "dial-forge-ai" / "ai-pipeline" / ".env.local"


def read_env_file(path: Path) -> dict[str, str]:
    values: dict[str, str] = {}
    try:
        lines = path.read_text().splitlines()
    except OSError:
        return values

    for line in lines:
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


FILE_ENV = read_env_file(Path(os.environ.get("DIALFORGE_SUPABASE_ENV", DEFAULT_ENV_PATH)))
SUPABASE_URL = (
    os.environ.get("SUPABASE_SIP_URL")
    or os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
    or FILE_ENV.get("SUPABASE_SIP_URL")
    or FILE_ENV.get("NEXT_PUBLIC_SUPABASE_URL")
    or ""
).rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = (
    os.environ.get("SUPABASE_SIP_SERVICE_ROLE_KEY")
    or os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    or FILE_ENV.get("SUPABASE_SIP_SERVICE_ROLE_KEY")
    or FILE_ENV.get("SUPABASE_SERVICE_ROLE_KEY")
    or ""
)


def request_json(url: str, method: str = "GET", body=None, extra_headers=None):
    payload = json.dumps(body).encode() if body is not None else None
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        **(extra_headers or {}),
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as res:
        raw = res.read().decode("utf-8")
        return json.loads(raw) if raw else {}


def rest(path: str, method: str = "GET", body=None, extra_headers=None):
    return request_json(f"{SUPABASE_URL}/rest/v1{path}", method, body, extra_headers)


def auth(path: str, method: str = "GET", body=None):
    return request_json(f"{SUPABASE_URL}/auth/v1{path}", method, body)


def quote_filter(value) -> str:
    return urllib.parse.quote(str(value), safe="")


def load_demo_users():
    return json.loads(DEMO_USERS_PATH.read_text())


def get_org_by_name(name: str):
    rows = rest(f"/organizations?select=*&name=eq.{quote_filter(name)}&limit=1")
    return rows[0] if rows else None


def create_org(name: str):
    rows = rest(
        "/organizations",
        method="POST",
        body={"name": name},
        extra_headers={"Prefer": "return=representation"},
    )
    return rows[0]


def get_or_create_org(name: str):
    existing = get_org_by_name(name)
    if existing:
        return existing, "existing"
    return create_org(name), "created"


def list_auth_users():
    data = auth("/admin/users?page=1&per_page=1000")
    if isinstance(data, dict):
        return data.get("users", [])
    return data if isinstance(data, list) else []


def create_auth_user(demo_user: dict, organization: dict):
    metadata = {
        "display_name": demo_user.get("display_name") or demo_user.get("full_name"),
        "full_name": demo_user.get("full_name") or demo_user.get("display_name"),
        "avatar_url": demo_user.get("avatar_url") or "",
        "role": demo_user.get("role") or "",
        "organization_id": organization.get("id"),
        "organization_name": organization.get("name"),
        "organization_slug": demo_user.get("organization", {}).get("slug") or "",
        "organization_plan": demo_user.get("organization", {}).get("plan") or "starter",
    }
    return auth(
        "/admin/users",
        method="POST",
        body={
            "email": demo_user["email"],
            "password": demo_user["password"],
            "email_confirm": True,
            "user_metadata": metadata,
        },
    )


def update_auth_user(auth_user_id: str, demo_user: dict, organization: dict):
    metadata = {
        "display_name": demo_user.get("display_name") or demo_user.get("full_name"),
        "full_name": demo_user.get("full_name") or demo_user.get("display_name"),
        "avatar_url": demo_user.get("avatar_url") or "",
        "role": demo_user.get("role") or "",
        "organization_id": organization.get("id"),
        "organization_name": organization.get("name"),
        "organization_slug": demo_user.get("organization", {}).get("slug") or "",
        "organization_plan": demo_user.get("organization", {}).get("plan") or "starter",
    }
    return auth(
        f"/admin/users/{quote_filter(auth_user_id)}",
        method="PUT",
        body={
            "password": demo_user["password"],
            "email_confirm": True,
            "user_metadata": metadata,
        },
    )


def upsert_public_user(auth_user: dict, demo_user: dict, organization: dict):
    body = {
        "id": auth_user["id"],
        "organization_id": organization.get("id"),
        "email": demo_user["email"],
        "role": None,
        "is_active": True,
    }
    rows = rest(f"/users?select=*&id=eq.{quote_filter(auth_user['id'])}&limit=1")
    if rows:
        return rest(
            f"/users?id=eq.{quote_filter(auth_user['id'])}",
            method="PATCH",
            body=body,
            extra_headers={"Prefer": "return=representation"},
        )
    return rest(
        "/users",
        method="POST",
        body=body,
        extra_headers={"Prefer": "return=representation"},
    )


def main() -> int:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print("Missing Supabase URL or service role key.", file=sys.stderr)
        return 1

    auth_users_by_email = {
        str(user.get("email") or "").lower(): user for user in list_auth_users()
    }

    for demo_user in load_demo_users():
        email = str(demo_user["email"]).lower()
        org_name = demo_user.get("organization", {}).get("name") or "DialForge Demo"
        organization, org_status = get_or_create_org(org_name)

        auth_user = auth_users_by_email.get(email)
        if auth_user:
            auth_user = update_auth_user(auth_user["id"], demo_user, organization)
            auth_status = "updated"
        else:
            auth_user = create_auth_user(demo_user, organization)
            auth_users_by_email[email] = auth_user
            auth_status = "created"

        upsert_public_user(auth_user, demo_user, organization)
        print(
            f"{email}: auth {auth_status}, organization {org_status} "
            f"({organization.get('name')}), public.users upserted"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""Seed product demo contact data from hardcoded UI mocks into Supabase."""

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
DEMO_CONTACTS_PATH = SCRIPT_DIR / "product_demo_contacts.json"
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
    payload = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
        **(extra_headers or {}),
    }
    req = urllib.request.Request(url, data=payload, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            raw = res.read().decode("utf-8")
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as error:
        raw = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(
            f"Supabase {method} {url} failed with HTTP {error.code}: {raw}"
        ) from error


def rest(path: str, method: str = "GET", body=None, extra_headers=None):
    return request_json(f"{SUPABASE_URL}/rest/v1{path}", method, body, extra_headers)


def quote_filter(value) -> str:
    return urllib.parse.quote(str(value), safe="")


def load_demo_contacts():
    return json.loads(DEMO_CONTACTS_PATH.read_text())


def get_org_by_name(name: str):
    rows = rest(f"/organizations?select=*&name=eq.{quote_filter(name)}&limit=1")
    return rows[0] if rows else None


def find_contact(contact: dict, organization_id: int):
    email = str(contact.get("email") or "").strip()
    phone = str(contact.get("phone") or "").strip()
    name = str(contact.get("name") or "").strip()
    company = str(contact.get("company") or "").strip()

    queries = []
    if email:
        queries.append(f"/contacts?select=*&organization_id=eq.{organization_id}&email=eq.{quote_filter(email)}&limit=1")
    if phone:
        queries.append(f"/contacts?select=*&organization_id=eq.{organization_id}&phone=eq.{quote_filter(phone)}&limit=1")
    if name and company:
        queries.append(
            f"/contacts?select=*&organization_id=eq.{organization_id}"
            f"&name=eq.{quote_filter(name)}&company=eq.{quote_filter(company)}&limit=1"
        )

    for query in queries:
        rows = rest(query)
        if rows:
            return rows[0]
    return None


def contact_payload(contact: dict, organization_id: int) -> dict:
    return {
        "organization_id": organization_id,
        "name": contact["name"],
        "email": contact.get("email") or None,
        "phone": contact.get("phone") or None,
        "company": contact.get("company") or None,
    }


def upsert_contact(contact: dict, organization_id: int):
    existing = find_contact(contact, organization_id)
    payload = contact_payload(contact, organization_id)
    if existing:
        rows = rest(
            f"/contacts?id=eq.{quote_filter(existing['id'])}",
            method="PATCH",
            body=payload,
            extra_headers={"Prefer": "return=representation"},
        )
        return rows[0], "updated"

    rows = rest(
        "/contacts",
        method="POST",
        body=payload,
        extra_headers={"Prefer": "return=representation"},
    )
    return rows[0], "created"


def main() -> int:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print("Missing Supabase URL or service role key.", file=sys.stderr)
        return 1

    created = 0
    updated = 0

    for contact in load_demo_contacts():
        org_name = contact.get("organization_name") or "GlobiFYE"
        organization = get_org_by_name(org_name)
        if not organization:
            print(f"Missing organization: {org_name}", file=sys.stderr)
            return 1

        row, status = upsert_contact(contact, organization["id"])
        created += status == "created"
        updated += status == "updated"
        print(
            f"{row['name']} ({row.get('company') or 'no company'}): "
            f"{status} contact id={row['id']} organization={organization['name']}"
        )

    print(f"Done. created={created}, updated={updated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

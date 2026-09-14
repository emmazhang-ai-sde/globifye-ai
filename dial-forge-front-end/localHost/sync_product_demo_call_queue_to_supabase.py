#!/usr/bin/env python3
"""Seed product demo power-dialer queue rows into Supabase."""

from __future__ import annotations

import sys
from datetime import datetime, timedelta

from sync_product_demo_contacts_to_supabase import (
    find_contact,
    get_org_by_name,
    load_demo_contacts,
    quote_filter,
    rest,
    SUPABASE_SERVICE_ROLE_KEY,
    SUPABASE_URL,
)


PRIORITY_VALUES = {
    "high": 3,
    "medium": 2,
    "low": 1,
}


def find_queue_row(organization_id: int, contact_id: int):
    rows = rest(
        f"/call_queue?select=*&organization_id=eq.{organization_id}"
        f"&contact_id=eq.{contact_id}&limit=1"
    )
    return rows[0] if rows else None


def queue_payload(contact: dict, organization_id: int, contact_id: int, index: int):
    priority = PRIORITY_VALUES.get(str(contact.get("priority") or "").lower(), 0)
    scheduled_at = datetime.now().replace(microsecond=0) + timedelta(minutes=index * 5)
    return {
        "organization_id": organization_id,
        "contact_id": contact_id,
        "scheduled_at": scheduled_at.isoformat(sep=" "),
        "priority": priority,
        "status": "queued",
        "call_mode": "auto_dialer",
    }


def upsert_queue_row(contact: dict, organization_id: int, index: int):
    contact_row = find_contact(contact, organization_id)
    if not contact_row:
        raise RuntimeError(
            f"Missing seeded contact for {contact.get('name')} "
            f"({contact.get('company')}). Run sync_product_demo_contacts_to_supabase.py first."
        )

    payload = queue_payload(contact, organization_id, contact_row["id"], index)
    existing = find_queue_row(organization_id, contact_row["id"])
    if existing:
        rows = rest(
            f"/call_queue?id=eq.{quote_filter(existing['id'])}",
            method="PATCH",
            body=payload,
            extra_headers={"Prefer": "return=representation"},
        )
        return rows[0], contact_row, "updated"

    rows = rest(
        "/call_queue",
        method="POST",
        body=payload,
        extra_headers={"Prefer": "return=representation"},
    )
    return rows[0], contact_row, "created"


def main() -> int:
    if not SUPABASE_URL or not SUPABASE_SERVICE_ROLE_KEY:
        print("Missing Supabase URL or service role key.", file=sys.stderr)
        return 1

    created = 0
    updated = 0

    for index, contact in enumerate(load_demo_contacts()):
        org_name = contact.get("organization_name") or "GlobiFYE"
        organization = get_org_by_name(org_name)
        if not organization:
            print(f"Missing organization: {org_name}", file=sys.stderr)
            return 1

        queue_row, contact_row, status = upsert_queue_row(contact, organization["id"], index)
        created += status == "created"
        updated += status == "updated"
        print(
            f"{contact_row['name']} ({contact_row.get('company') or 'no company'}): "
            f"{status} queue id={queue_row['id']} priority={queue_row.get('priority')} "
            f"status={queue_row.get('status')}"
        )

    print(f"Done. created={created}, updated={updated}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

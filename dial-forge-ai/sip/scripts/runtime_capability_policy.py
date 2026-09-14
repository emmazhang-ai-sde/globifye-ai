"""Runtime policy helpers for capability tool execution.

This module keeps per-turn safety controls separate from the live SIP bridge.
The bridge owns telephony side effects; this module owns generic limits such as
tool-call budgets and role=tool payload sizing.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any

from runtime_vocabulary import RuntimeCapability


DEFAULT_MAX_TOOL_RESULT_CHARS = 6000


class RuntimeCapabilityPolicyError(ValueError):
    """Base error for runtime capability policy failures."""


class CapabilityCallBudgetExceeded(RuntimeCapabilityPolicyError):
    """Raised when a capability exceeds its per-turn call budget."""


@dataclass
class RuntimeCapabilityCallBudget:
    """Track capability calls for a single model turn."""

    max_calls_by_name: dict[str, int | None]
    call_counts: dict[str, int] = field(default_factory=dict)

    @classmethod
    def from_capabilities(
        cls,
        capabilities: list[RuntimeCapability] | tuple[RuntimeCapability, ...],
    ) -> "RuntimeCapabilityCallBudget":
        return cls(
            {
                capability.name: capability.max_calls_per_turn
                for capability in capabilities
            }
        )

    def reserve(self, capability_name: str) -> dict[str, Any]:
        """Reserve one call slot for a capability and return budget metadata."""

        if capability_name not in self.max_calls_by_name:
            raise CapabilityCallBudgetExceeded(
                f"capability {capability_name} is not allowed in this turn"
            )

        current_count = self.call_counts.get(capability_name, 0)
        max_calls = self.max_calls_by_name[capability_name]
        if max_calls is not None and current_count >= max_calls:
            raise CapabilityCallBudgetExceeded(
                f"capability {capability_name} exceeded max_calls_per_turn={max_calls}"
            )

        next_count = current_count + 1
        self.call_counts[capability_name] = next_count
        return {
            "capability": capability_name,
            "call_count": next_count,
            "max_calls_per_turn": max_calls,
        }


def serialize_tool_result(
    result: dict[str, Any],
    *,
    max_chars: int = DEFAULT_MAX_TOOL_RESULT_CHARS,
) -> tuple[str, bool, int]:
    """Serialize a tool result as JSON, compacting it if it is too large.

    Returns ``(content, truncated, original_char_count)``. The returned content
    is always valid JSON.
    """

    if max_chars < 200:
        raise ValueError("max_chars must be at least 200")

    content = json.dumps(result, ensure_ascii=False)
    original_char_count = len(content)
    if original_char_count <= max_chars:
        return content, False, original_char_count

    compact = _compact_tool_result(
        result,
        max_chars=max_chars,
        original_char_count=original_char_count,
    )
    content = json.dumps(compact, ensure_ascii=False)
    if len(content) <= max_chars:
        return content, True, original_char_count

    compact["evidence"] = _trim_text(
        str(compact.get("evidence") or ""),
        max_chars=max(0, max_chars - len(json.dumps({k: v for k, v in compact.items() if k != "evidence"}, ensure_ascii=False)) - 32),
    )
    content = json.dumps(compact, ensure_ascii=False)
    if len(content) <= max_chars:
        return content, True, original_char_count

    minimal = {
        "ok": bool(result.get("ok")),
        "capability": result.get("capability"),
        "truncated": True,
        "original_char_count": original_char_count,
        "max_char_count": max_chars,
        "error": (
            "Tool result was too large to include fully. "
            "Retry with a narrower query if needed."
        ),
    }
    content = json.dumps(minimal, ensure_ascii=False)
    return _trim_json_content(content, max_chars), True, original_char_count


def _compact_tool_result(
    result: dict[str, Any],
    *,
    max_chars: int,
    original_char_count: int,
) -> dict[str, Any]:
    compact: dict[str, Any] = {
        "ok": bool(result.get("ok")),
        "capability": result.get("capability"),
        "kind": result.get("kind"),
        "truncated": True,
        "original_char_count": original_char_count,
        "max_char_count": max_chars,
    }

    for key in (
        "query",
        "has_evidence",
        "fallback_policy",
        "reason",
        "urgency",
        "preferred_team",
        "endpoint",
        "error",
        "audit",
    ):
        if key in result:
            compact[key] = result[key]

    if "evidence" in result:
        compact["evidence"] = _trim_text(str(result.get("evidence") or ""), max_chars // 2)

    chunks = result.get("chunks")
    if isinstance(chunks, list):
        compact["returned_chunks"] = len(chunks)
        compact["chunk_summaries"] = [
            _chunk_summary(chunk)
            for chunk in chunks[:3]
            if isinstance(chunk, dict)
        ]

    return compact


def _chunk_summary(chunk: dict[str, Any]) -> dict[str, Any]:
    return {
        "source_file": chunk.get("source_file"),
        "section": chunk.get("section"),
        "distance": chunk.get("distance"),
        "content": _trim_text(str(chunk.get("content") or ""), 300),
    }


def _trim_text(text: str, max_chars: int) -> str:
    if max_chars <= 0:
        return ""
    if len(text) <= max_chars:
        return text
    if max_chars <= 3:
        return text[:max_chars]
    return text[: max_chars - 3] + "..."


def _trim_json_content(content: str, max_chars: int) -> str:
    if len(content) <= max_chars:
        return content
    fallback = {
        "ok": False,
        "truncated": True,
        "error": "Tool result exceeded the maximum serialized size.",
    }
    fallback_content = json.dumps(fallback, ensure_ascii=False)
    if len(fallback_content) <= max_chars:
        return fallback_content
    return json.dumps({"ok": False, "truncated": True}, ensure_ascii=False)


__all__ = [
    "CapabilityCallBudgetExceeded",
    "DEFAULT_MAX_TOOL_RESULT_CHARS",
    "RuntimeCapabilityCallBudget",
    "RuntimeCapabilityPolicyError",
    "serialize_tool_result",
]

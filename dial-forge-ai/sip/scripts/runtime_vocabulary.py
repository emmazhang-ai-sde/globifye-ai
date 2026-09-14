"""Shared vocabulary for the phone agent runtime.

This module is intentionally declarative. It gives the codebase stable names
for the Agent Runtime / RAG boundary without wiring new behavior into the live
SIP bridge yet.

Layering:

* KnowledgeBaseResource is the company-scoped information asset.
* RetrievalCapability is the controlled information access path into that asset.
* RuntimeCapability is what the LLM may be allowed to call on a turn.
* RuntimeContext is the phone-session state used to decide what is exposed.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class CapabilityKind(str, Enum):
    """Behavior categories for runtime-exposed agent capabilities."""

    INFORMATION = "information"
    STATE = "state"
    HUMAN = "human"
    ACTION = "action"


@dataclass(frozen=True)
class KnowledgeBaseResource:
    """Company-scoped information asset bound to one or more agents.

    A KB stores information and retrieval policy. It is not itself an LLM tool;
    tools such as ``retrieve_company_kb`` are controlled access paths into it.
    """

    knowledge_profile_id: str
    company_key: str
    display_name: str = ""
    legacy_kb_file: str | None = None
    corpus_path: str | None = None
    source_files: tuple[str, ...] = ()
    retrieval_policy: dict[str, Any] = field(default_factory=dict)
    fallback_policy: dict[str, Any] = field(default_factory=dict)
    status: str = "active"
    version: str | None = None
    enabled: bool = True

    def __post_init__(self) -> None:
        object.__setattr__(self, "source_files", tuple(self.source_files))


@dataclass(frozen=True)
class RuntimeCapability:
    """A capability that can be exposed to the LLM for a single runtime turn."""

    name: str
    kind: CapabilityKind | str
    description: str
    parameters_schema: dict[str, Any]
    risk_level: str = "read"
    requires_confirmation: bool = False
    max_calls_per_turn: int | None = None
    metadata: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "kind", CapabilityKind(self.kind))
        object.__setattr__(self, "parameters_schema", dict(self.parameters_schema))
        object.__setattr__(self, "metadata", dict(self.metadata))

    @property
    def is_information_tool(self) -> bool:
        return self.kind is CapabilityKind.INFORMATION

    def to_llm_tool_schema(self) -> dict[str, Any]:
        """Return the function-tool shape expected by Groq/OpenAI chat APIs."""

        return {
            "type": "function",
            "function": {
                "name": self.name,
                "description": self.description,
                "parameters": self.parameters_schema,
            },
        }


@dataclass(frozen=True)
class RetrievalCapability:
    """Information capability that retrieves evidence from a KB resource."""

    capability: RuntimeCapability
    knowledge_profile_id: str | None = None

    def __post_init__(self) -> None:
        if self.capability.kind is not CapabilityKind.INFORMATION:
            raise ValueError("retrieval capabilities must use kind='information'")


@dataclass(frozen=True)
class StageTransition:
    """Allowed node/edge transition from the current sales stage."""

    name: str
    target: str
    description: str = ""

    @classmethod
    def from_edge(cls, name: str, edge: dict[str, Any]) -> "StageTransition":
        return cls(
            name=name,
            target=str(edge["target"]),
            description=str(edge.get("description") or name.replace("_", " ")),
        )


@dataclass(frozen=True)
class RuntimeContext:
    """Phone-session context used to decide which capabilities are exposed."""

    agent_config_id: str
    company_key: str
    call_session_id: str | None = None
    owner: str = "ai"
    current_stage: str | None = None
    stage_transitions: tuple[StageTransition, ...] = ()
    knowledge_bases: tuple[KnowledgeBaseResource, ...] = ()
    session_state: dict[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        object.__setattr__(self, "stage_transitions", tuple(self.stage_transitions))
        object.__setattr__(self, "knowledge_bases", tuple(self.knowledge_bases))


INITIAL_CAPABILITY_KINDS = tuple(kind.value for kind in CapabilityKind)


__all__ = [
    "CapabilityKind",
    "INITIAL_CAPABILITY_KINDS",
    "KnowledgeBaseResource",
    "RetrievalCapability",
    "RuntimeCapability",
    "RuntimeContext",
    "StageTransition",
]

"""Capability registry for the phone agent runtime.

Phase 3 introduces the permission/exposure layer only. This module decides
which tool schemas the LLM may see for a turn; later phases will attach the
actual retrieval, stage mutation, and human handoff handlers.
"""

from __future__ import annotations

from runtime_vocabulary import (
    CapabilityKind,
    RuntimeCapability,
    RuntimeContext,
    StageTransition,
)


class CapabilityRegistryError(ValueError):
    """Base error for invalid capability registry state."""


class DuplicateCapabilityError(CapabilityRegistryError):
    """Raised when two exposed capabilities share a function name."""


class UnknownCapabilityError(CapabilityRegistryError):
    """Raised when a caller asks for a capability that is not registered."""


RETRIEVE_COMPANY_KB = RuntimeCapability(
    name="retrieve_company_kb",
    kind=CapabilityKind.INFORMATION,
    description=(
        "Retrieve grounded evidence from the active company's bound knowledge base. "
        "The runtime supplies company scope; the model only supplies the query."
    ),
    parameters_schema={
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": "The caller's question or the exact fact to look up.",
            },
        },
        "required": ["query"],
        "additionalProperties": False,
    },
    risk_level="read",
    max_calls_per_turn=3,
)


REQUEST_HANDOFF = RuntimeCapability(
    name="request_handoff",
    kind=CapabilityKind.HUMAN,
    description=(
        "Ask the runtime to invite or transfer to a human teammate when the caller "
        "needs human help, escalation, or a live follow-up."
    ),
    parameters_schema={
        "type": "object",
        "properties": {
            "reason": {
                "type": "string",
                "description": "Short caller-facing reason for requesting human help.",
            },
            "urgency": {
                "type": "string",
                "enum": ["normal", "urgent"],
                "description": "How time-sensitive the handoff is.",
            },
            "preferred_team": {
                "type": "string",
                "description": "Optional team or role that should receive the handoff.",
            },
        },
        "required": ["reason"],
        "additionalProperties": False,
    },
    risk_level="handoff",
    requires_confirmation=False,
    max_calls_per_turn=1,
)


def stage_transition_capability(
    transition: StageTransition,
    *,
    current_stage: str | None = None,
) -> RuntimeCapability:
    """Convert a graph edge into a state capability exposed for this turn."""

    return RuntimeCapability(
        name=transition.name,
        kind=CapabilityKind.STATE,
        description=transition.description,
        parameters_schema={
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why this stage transition is now appropriate.",
                },
            },
            "required": [],
            "additionalProperties": False,
        },
        risk_level="write",
        max_calls_per_turn=1,
        metadata={
            "current_stage": current_stage,
            "target_stage": transition.target,
            "source": "stage_graph_edge",
        },
    )


class CapabilityRegistry:
    """Registry that exposes allowed capabilities for a runtime turn."""

    def __init__(self, capabilities: list[RuntimeCapability] | tuple[RuntimeCapability, ...]):
        self._capabilities_by_name: dict[str, RuntimeCapability] = {}
        for capability in capabilities:
            self._register(capability)

    @classmethod
    def default(cls) -> "CapabilityRegistry":
        return cls([RETRIEVE_COMPANY_KB, REQUEST_HANDOFF])

    def _register(self, capability: RuntimeCapability) -> None:
        if capability.name in self._capabilities_by_name:
            raise DuplicateCapabilityError(f"duplicate capability name: {capability.name}")
        self._capabilities_by_name[capability.name] = capability

    def get(self, name: str) -> RuntimeCapability | None:
        return self._capabilities_by_name.get(name)

    def require(self, name: str) -> RuntimeCapability:
        capability = self.get(name)
        if capability is None:
            raise UnknownCapabilityError(f"unknown capability: {name}")
        return capability

    def base_capabilities(self) -> list[RuntimeCapability]:
        return list(self._capabilities_by_name.values())

    def allowed_for(self, context: RuntimeContext) -> list[RuntimeCapability]:
        if context.owner != "ai":
            return []

        allowed: list[RuntimeCapability] = []

        if self._has_enabled_knowledge_base(context):
            allowed.append(self.require(RETRIEVE_COMPANY_KB.name))

        for transition in context.stage_transitions:
            allowed.append(
                stage_transition_capability(
                    transition,
                    current_stage=context.current_stage,
                )
            )

        if bool(context.session_state.get("human_handoff_enabled")):
            allowed.append(self.require(REQUEST_HANDOFF.name))

        self._raise_for_duplicate_exposure(allowed)
        return allowed

    def to_llm_tools(self, context: RuntimeContext) -> list[dict]:
        return [capability.to_llm_tool_schema() for capability in self.allowed_for(context)]

    @staticmethod
    def _has_enabled_knowledge_base(context: RuntimeContext) -> bool:
        return any(kb.enabled and kb.company_key == context.company_key for kb in context.knowledge_bases)

    @staticmethod
    def _raise_for_duplicate_exposure(capabilities: list[RuntimeCapability]) -> None:
        seen: set[str] = set()
        for capability in capabilities:
            if capability.name in seen:
                raise DuplicateCapabilityError(
                    f"duplicate exposed capability name: {capability.name}"
                )
            seen.add(capability.name)


__all__ = [
    "CapabilityRegistry",
    "CapabilityRegistryError",
    "DuplicateCapabilityError",
    "REQUEST_HANDOFF",
    "RETRIEVE_COMPANY_KB",
    "UnknownCapabilityError",
    "stage_transition_capability",
]

"""Execution entrypoint for runtime capabilities.

Phase 4 implements the information capability ``retrieve_company_kb``.
Phase 5 implements stage transition execution through an injected handler.
Phase 6 implements human handoff execution through an injected handler.
"""

from __future__ import annotations

from typing import Any, Callable

from capability_registry import CapabilityRegistry, REQUEST_HANDOFF, RETRIEVE_COMPANY_KB
import rag_retrieval
from runtime_vocabulary import (
    CapabilityKind,
    KnowledgeBaseResource,
    RuntimeCapability,
    RuntimeContext,
    StageTransition,
)


class CapabilityExecutionError(ValueError):
    """Base error for capability execution failures."""


class CapabilityNotAllowedError(CapabilityExecutionError):
    """Raised when a tool call is not exposed for the current runtime context."""


class UnsupportedCapabilityExecutionError(CapabilityExecutionError):
    """Raised when a capability schema exists but its handler is not implemented."""


RetrievalHandler = Callable[..., list[dict[str, Any]]]
StageTransitionHandler = Callable[..., dict[str, Any] | None]
HumanHandoffHandler = Callable[..., dict[str, Any] | None]


def execute_capability_call(
    context: RuntimeContext,
    capability_name: str,
    arguments: dict[str, Any] | None = None,
    *,
    registry: CapabilityRegistry | None = None,
    retrieval_handler: RetrievalHandler | None = None,
    stage_transition_handler: StageTransitionHandler | None = None,
    human_handoff_handler: HumanHandoffHandler | None = None,
) -> dict[str, Any]:
    """Execute one allowed capability call for the current runtime context."""

    registry = registry or CapabilityRegistry.default()
    capability = _require_allowed_capability(
        registry=registry,
        context=context,
        capability_name=capability_name,
    )
    arguments = dict(arguments or {})

    if capability.name == RETRIEVE_COMPANY_KB.name:
        return execute_retrieve_company_kb(
            context,
            arguments,
            retrieval_handler=retrieval_handler,
        )

    if capability.kind is CapabilityKind.STATE and capability.metadata.get("source") == "stage_graph_edge":
        return execute_stage_transition(
            context,
            capability,
            arguments,
            stage_transition_handler=stage_transition_handler,
        )

    if capability.name == REQUEST_HANDOFF.name:
        return execute_request_handoff(
            context,
            arguments,
            human_handoff_handler=human_handoff_handler,
        )

    raise UnsupportedCapabilityExecutionError(
        f"capability {capability.name} is exposed but execution is not implemented yet"
    )


def execute_retrieve_company_kb(
    context: RuntimeContext,
    arguments: dict[str, Any],
    *,
    retrieval_handler: RetrievalHandler | None = None,
) -> dict[str, Any]:
    """Retrieve KB evidence using runtime-owned company scope."""

    query = arguments.get("query")
    if not isinstance(query, str) or not query.strip():
        raise CapabilityExecutionError("retrieve_company_kb requires a non-empty query")
    query = query.strip()

    knowledge_base = _select_enabled_knowledge_base(context)
    policy = dict(knowledge_base.retrieval_policy)
    top_k = int(policy.get("top_k") or 3)
    distance_floor = policy.get("distance_floor")
    if distance_floor is not None:
        distance_floor = float(distance_floor)

    handler = retrieval_handler or rag_retrieval.match_detail
    chunks = handler(
        company_key=context.company_key,
        query=query,
        k=top_k,
        distance_floor=distance_floor,
    )
    evidence = rag_retrieval.render(chunks)

    return {
        "ok": True,
        "capability": RETRIEVE_COMPANY_KB.name,
        "kind": CapabilityKind.INFORMATION.value,
        "query": query,
        "has_evidence": bool(chunks),
        "evidence": evidence,
        "chunks": chunks,
        "fallback_policy": None if chunks else dict(knowledge_base.fallback_policy),
        "audit": {
            "agent_config_id": context.agent_config_id,
            "call_session_id": context.call_session_id,
            "company_key": context.company_key,
            "knowledge_profile_id": knowledge_base.knowledge_profile_id,
            "top_k": top_k,
            "distance_floor": distance_floor,
            "returned_chunks": len(chunks),
        },
    }


def execute_stage_transition(
    context: RuntimeContext,
    capability: RuntimeCapability,
    arguments: dict[str, Any],
    *,
    stage_transition_handler: StageTransitionHandler | None = None,
) -> dict[str, Any]:
    """Execute an allowed stage graph edge through the runtime's stage handler."""

    if stage_transition_handler is None:
        raise CapabilityExecutionError("stage transition execution requires a handler")

    transition = _select_stage_transition(context, capability.name)
    reason = arguments.get("reason")
    if reason is not None and not isinstance(reason, str):
        raise CapabilityExecutionError("stage transition reason must be a string")
    reason = (reason or "").strip()

    handler_result = stage_transition_handler(
        context=context,
        transition=transition,
        transition_name=transition.name,
        previous_stage=context.current_stage,
        target_stage=transition.target,
        reason=reason,
    )

    return {
        "ok": True,
        "capability": transition.name,
        "kind": CapabilityKind.STATE.value,
        "previous_stage": context.current_stage,
        "current_stage": transition.target,
        "target_stage": transition.target,
        "reason": reason,
        "handler_result": handler_result,
        "audit": {
            "agent_config_id": context.agent_config_id,
            "call_session_id": context.call_session_id,
            "company_key": context.company_key,
            "transition_name": transition.name,
            "previous_stage": context.current_stage,
            "target_stage": transition.target,
        },
    }


def execute_request_handoff(
    context: RuntimeContext,
    arguments: dict[str, Any],
    *,
    human_handoff_handler: HumanHandoffHandler | None = None,
) -> dict[str, Any]:
    """Execute an allowed human handoff request through the runtime handler."""

    if human_handoff_handler is None:
        raise CapabilityExecutionError("request_handoff execution requires a handler")

    reason = arguments.get("reason")
    if not isinstance(reason, str) or not reason.strip():
        raise CapabilityExecutionError("request_handoff requires a non-empty reason")
    reason = reason.strip()

    urgency = arguments.get("urgency", "normal")
    if urgency is None:
        urgency = "normal"
    if urgency not in {"normal", "urgent"}:
        raise CapabilityExecutionError("request_handoff urgency must be 'normal' or 'urgent'")

    preferred_team = arguments.get("preferred_team")
    if preferred_team is not None and not isinstance(preferred_team, str):
        raise CapabilityExecutionError("request_handoff preferred_team must be a string")
    preferred_team = (preferred_team or "").strip() or None

    endpoint = context.session_state.get("default_human_endpoint")
    if endpoint is not None and not isinstance(endpoint, str):
        raise CapabilityExecutionError("default_human_endpoint must be a string")
    endpoint = (endpoint or "").strip() or None

    caller_id = context.session_state.get("human_caller_id")
    if caller_id is not None and not isinstance(caller_id, str):
        raise CapabilityExecutionError("human_caller_id must be a string")
    caller_id = (caller_id or "").strip() or None

    handler_result = human_handoff_handler(
        context=context,
        reason=reason,
        urgency=urgency,
        preferred_team=preferred_team,
        endpoint=endpoint,
        caller_id=caller_id,
    )

    return {
        "ok": True,
        "capability": REQUEST_HANDOFF.name,
        "kind": CapabilityKind.HUMAN.value,
        "reason": reason,
        "urgency": urgency,
        "preferred_team": preferred_team,
        "endpoint": endpoint,
        "handler_result": handler_result,
        "audit": {
            "agent_config_id": context.agent_config_id,
            "call_session_id": context.call_session_id,
            "company_key": context.company_key,
            "handoff_enabled": bool(context.session_state.get("human_handoff_enabled")),
            "preferred_team": preferred_team,
            "urgency": urgency,
        },
    }


def _require_allowed_capability(
    *,
    registry: CapabilityRegistry,
    context: RuntimeContext,
    capability_name: str,
):
    allowed = {capability.name: capability for capability in registry.allowed_for(context)}
    capability = allowed.get(capability_name)
    if capability is None:
        raise CapabilityNotAllowedError(
            f"capability {capability_name} is not allowed for this runtime context"
        )
    return capability


def _select_stage_transition(context: RuntimeContext, transition_name: str) -> StageTransition:
    for transition in context.stage_transitions:
        if transition.name == transition_name:
            return transition
    raise CapabilityNotAllowedError(
        f"stage transition {transition_name} is not allowed for this runtime context"
    )


def _select_enabled_knowledge_base(context: RuntimeContext) -> KnowledgeBaseResource:
    for knowledge_base in context.knowledge_bases:
        if knowledge_base.enabled and knowledge_base.company_key == context.company_key:
            return knowledge_base
    raise CapabilityNotAllowedError(
        "retrieve_company_kb requires an enabled knowledge base for the active company"
    )


__all__ = [
    "CapabilityExecutionError",
    "CapabilityNotAllowedError",
    "UnsupportedCapabilityExecutionError",
    "execute_capability_call",
    "execute_retrieve_company_kb",
    "execute_request_handoff",
    "execute_stage_transition",
]

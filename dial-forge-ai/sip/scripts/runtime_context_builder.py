"""Build RuntimeContext from the active phone-call state.

This is the first live-bridge integration step for the Runtime Capability
System. It does not change model calls or execute tools; it only translates the
current bridge/session state into the vocabulary used by CapabilityRegistry and
CapabilityExecutor.
"""

from __future__ import annotations

from typing import Any

from agent_registry import AgentConfig
from call_session import CallSession
from knowledge_base_registry import KnowledgeBaseRegistry
from runtime_vocabulary import RuntimeContext, StageTransition


class RuntimeContextBuilderError(ValueError):
    """Raised when active call state cannot safely form a RuntimeContext."""


def build_runtime_context(
    *,
    agent: AgentConfig,
    session: CallSession,
    knowledge_base_registry: KnowledgeBaseRegistry,
    current_stage: str | None = None,
    stage_graph: dict[str, dict[str, Any]] | None = None,
    default_human_endpoint: str | None = None,
    human_caller_id: str | None = None,
    session_state: dict[str, Any] | None = None,
) -> RuntimeContext:
    """Translate active bridge state into RuntimeContext.

    The stage graph is optional because the current live bridge does not expose
    the preview bridge's ``STAGES/current_node`` shape yet.
    """

    _validate_agent_session_match(agent=agent, session=session)
    knowledge_base = knowledge_base_registry.resolve_for_agent(agent)

    merged_session_state = {
        "human_handoff_enabled": agent.human_handoff_enabled,
        "default_human_endpoint": agent.default_human_endpoint or default_human_endpoint,
        "human_caller_id": human_caller_id,
    }
    merged_session_state.update(agent.handoff_policy or {})
    merged_session_state.update(session_state or {})

    return RuntimeContext(
        agent_config_id=session.agent_config_id,
        company_key=session.company_key,
        call_session_id=session.call_session_id,
        owner=session.owner,
        current_stage=current_stage if stage_graph is not None else None,
        stage_transitions=_stage_transitions_for(
            current_stage=current_stage,
            stage_graph=stage_graph,
        ),
        knowledge_bases=(knowledge_base,),
        session_state=merged_session_state,
    )


def _validate_agent_session_match(*, agent: AgentConfig, session: CallSession) -> None:
    if session.agent_config_id != agent.agent_config_id:
        raise RuntimeContextBuilderError(
            f"session agent_config_id={session.agent_config_id} does not match "
            f"agent_config_id={agent.agent_config_id}"
        )
    if session.company_key != agent.company_key:
        raise RuntimeContextBuilderError(
            f"session company_key={session.company_key} does not match "
            f"agent company_key={agent.company_key}"
        )


def _stage_transitions_for(
    *,
    current_stage: str | None,
    stage_graph: dict[str, dict[str, Any]] | None,
) -> tuple[StageTransition, ...]:
    if not current_stage or stage_graph is None:
        return ()

    stage = stage_graph.get(current_stage)
    if stage is None:
        raise RuntimeContextBuilderError(f"unknown current_stage: {current_stage}")

    edges = stage.get("edges") or {}
    if not isinstance(edges, dict):
        raise RuntimeContextBuilderError(
            f"stage {current_stage} has invalid edges; expected a dict"
        )

    return tuple(
        StageTransition.from_edge(name, edge)
        for name, edge in edges.items()
    )


__all__ = [
    "RuntimeContextBuilderError",
    "build_runtime_context",
]

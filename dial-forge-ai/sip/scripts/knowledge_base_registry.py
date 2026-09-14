"""Knowledge Base profile registry for the phone agent runtime.

This is Phase 2 of the Agent Runtime / RAG split: extract KB configuration out
of the flat company record while keeping the current ``kb_file`` bridge intact.
The live call path can keep using legacy prompt injection until retrieval tools
are introduced in later phases.
"""

from __future__ import annotations

from dataclasses import replace
import json
from pathlib import Path
from typing import Any

from agent_registry import AgentConfig
from runtime_vocabulary import KnowledgeBaseResource


class KnowledgeBaseRegistryError(ValueError):
    """Base error for invalid Knowledge Base registry state."""


class UnknownKnowledgeProfileError(KnowledgeBaseRegistryError):
    """Raised when an agent references a missing knowledge profile."""


class KnowledgeProfileValidationError(KnowledgeBaseRegistryError):
    """Raised when a knowledge profile is malformed or unsafe to bind."""


class KnowledgeBaseRegistry:
    """Loads and resolves company-scoped KnowledgeBaseResource profiles."""

    def __init__(self, resources: list[KnowledgeBaseResource]):
        self._resources_by_id: dict[str, KnowledgeBaseResource] = {}
        for resource in resources:
            if resource.knowledge_profile_id in self._resources_by_id:
                raise KnowledgeProfileValidationError(
                    f"duplicate knowledge_profile_id: {resource.knowledge_profile_id}"
                )
            self._resources_by_id[resource.knowledge_profile_id] = resource

    @classmethod
    def from_path(cls, profiles_path: str | Path) -> "KnowledgeBaseRegistry":
        with open(profiles_path) as f:
            return cls.from_profile_data(json.load(f))

    @classmethod
    def from_profile_data(cls, profiles: dict[str, dict[str, Any]]) -> "KnowledgeBaseRegistry":
        return cls(
            [
                cls._resource_from_profile(profile_id, data)
                for profile_id, data in profiles.items()
            ]
        )

    @staticmethod
    def _resource_from_profile(
        profile_id: str,
        data: dict[str, Any],
    ) -> KnowledgeBaseResource:
        knowledge_profile_id = str(data.get("knowledge_profile_id") or profile_id)
        company_key = data.get("company_key")
        if not company_key:
            raise KnowledgeProfileValidationError(
                f"knowledge profile {knowledge_profile_id} is missing company_key"
            )

        source_files = data.get("source_files") or ()
        if isinstance(source_files, str):
            source_files = (source_files,)

        legacy_kb_file = data.get("legacy_kb_file") or data.get("kb_file")
        if legacy_kb_file and legacy_kb_file not in source_files:
            source_files = (legacy_kb_file, *tuple(source_files))

        retrieval_policy = data.get("retrieval_policy") or {}
        fallback_policy = data.get("fallback_policy") or {}
        if not isinstance(retrieval_policy, dict):
            raise KnowledgeProfileValidationError(
                f"knowledge profile {knowledge_profile_id} has invalid retrieval_policy"
            )
        if not isinstance(fallback_policy, dict):
            raise KnowledgeProfileValidationError(
                f"knowledge profile {knowledge_profile_id} has invalid fallback_policy"
            )

        return KnowledgeBaseResource(
            knowledge_profile_id=knowledge_profile_id,
            company_key=str(company_key),
            display_name=str(data.get("display_name") or knowledge_profile_id),
            legacy_kb_file=str(legacy_kb_file) if legacy_kb_file else None,
            corpus_path=data.get("corpus_path"),
            source_files=tuple(str(path) for path in source_files),
            retrieval_policy=dict(retrieval_policy),
            fallback_policy=dict(fallback_policy),
            status=str(data.get("status") or "active"),
            version=str(data["version"]) if data.get("version") is not None else None,
            enabled=bool(data.get("enabled", True)),
        )

    def profiles(self) -> list[KnowledgeBaseResource]:
        return list(self._resources_by_id.values())

    def get(self, knowledge_profile_id: str | None) -> KnowledgeBaseResource | None:
        if knowledge_profile_id is None:
            return None
        return self._resources_by_id.get(str(knowledge_profile_id))

    def resolve_for_agent(self, agent: AgentConfig) -> KnowledgeBaseResource:
        knowledge_profile_id = agent.knowledge_profile_id or agent.company_key
        resource = self.get(knowledge_profile_id)
        if resource is None:
            raise UnknownKnowledgeProfileError(
                f"agent {agent.agent_config_id} references missing knowledge profile "
                f"{knowledge_profile_id}"
            )

        if resource.company_key != agent.company_key:
            raise KnowledgeProfileValidationError(
                f"agent {agent.agent_config_id} with company_key={agent.company_key} "
                f"cannot bind knowledge profile {resource.knowledge_profile_id} "
                f"with company_key={resource.company_key}"
            )

        if agent.kb_file and resource.legacy_kb_file is None:
            return replace(resource, legacy_kb_file=agent.kb_file)

        return resource


__all__ = [
    "KnowledgeBaseRegistry",
    "KnowledgeBaseRegistryError",
    "KnowledgeProfileValidationError",
    "UnknownKnowledgeProfileError",
]

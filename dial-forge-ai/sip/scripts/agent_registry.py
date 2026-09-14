"""Agent registry contract for routing inbound calls to company voice agents.

The first data source is the legacy ``sip/knowledge-base/companies.json`` file.
The public API mirrors the future Customer Registration / Dashboard model, so
the call runtime can stop depending on fixed 1000/2000 extension mappings.
"""

from __future__ import annotations

from dataclasses import dataclass, field
import json
from pathlib import Path
from typing import Any


class AgentRegistryError(ValueError):
    """Base error for invalid agent registry state."""


class UnknownAgentError(AgentRegistryError):
    """Raised when a route cannot be resolved and no valid default exists."""


@dataclass(frozen=True)
class AgentConfig:
    """Runtime-facing voice-agent config.

    ``company_key`` is kept as the compatibility bridge to today's RAG and
    prompt files. ``agent_config_id`` is the future Dashboard/API identifier.

    Vocabulary boundary:

    * ``kb_file`` is the legacy single-file prompt-injection source.
    * ``knowledge_profile_id`` is the future KnowledgeBaseResource binding.
    * human handoff fields are policy inputs for future human capabilities.
    """

    agent_config_id: str
    company_key: str
    display_name: str
    voice: str
    organization_id: str | None = None
    extension: str | None = None
    inbound_numbers: tuple[str, ...] = ()
    kb_file: str | None = None
    blurb: str = ""
    knowledge_profile_id: str | None = None
    human_handoff_enabled: bool = False
    default_human_endpoint: str | None = None
    handoff_policy: dict[str, Any] = field(default_factory=dict)
    legacy_company: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_legacy_company(cls, company_key: str, data: dict[str, Any]) -> "AgentConfig":
        inbound_numbers = data.get("inbound_numbers") or data.get("phone_numbers") or ()
        if isinstance(inbound_numbers, str):
            inbound_numbers = (inbound_numbers,)
        return cls(
            agent_config_id=str(data.get("agent_config_id") or company_key),
            company_key=company_key,
            display_name=data["display_name"],
            voice=data["voice"],
            organization_id=data.get("organization_id"),
            extension=str(data["extension"]) if data.get("extension") is not None else None,
            inbound_numbers=tuple(str(number) for number in inbound_numbers),
            kb_file=data.get("kb_file"),
            blurb=data.get("blurb", ""),
            knowledge_profile_id=data.get("knowledge_profile_id") or company_key,
            human_handoff_enabled=bool(data.get("human_handoff_enabled", False)),
            default_human_endpoint=data.get("default_human_endpoint"),
            handoff_policy=dict(data.get("handoff_policy") or {}),
            legacy_company=dict(data),
        )

    def to_legacy_company(self) -> dict[str, Any]:
        data = dict(self.legacy_company)
        data.update(
            {
                "agent_config_id": self.agent_config_id,
                "company_key": self.company_key,
                "display_name": self.display_name,
                "voice": self.voice,
                "extension": self.extension,
                "kb_file": self.kb_file,
                "blurb": self.blurb,
                "knowledge_profile_id": self.knowledge_profile_id,
                "human_handoff_enabled": self.human_handoff_enabled,
                "default_human_endpoint": self.default_human_endpoint,
                "handoff_policy": self.handoff_policy,
            }
        )
        if self.organization_id is not None:
            data["organization_id"] = self.organization_id
        if self.inbound_numbers:
            data["inbound_numbers"] = list(self.inbound_numbers)
        return data

    def to_public_dict(self) -> dict[str, Any]:
        return {
            "agent_config_id": self.agent_config_id,
            "company_key": self.company_key,
            "key": self.company_key,
            "display_name": self.display_name,
            "extension": self.extension,
            "inbound_numbers": list(self.inbound_numbers),
            "blurb": self.blurb,
            "human_handoff_enabled": self.human_handoff_enabled,
        }


@dataclass(frozen=True)
class AgentRouteResolution:
    agent: AgentConfig
    source: str
    value: str | None
    used_default: bool = False


class AgentRegistry:
    def __init__(self, agents: list[AgentConfig]):
        if not agents:
            raise AgentRegistryError("agent registry must contain at least one agent")
        self._agents_by_id = {agent.agent_config_id: agent for agent in agents}
        self._agents_by_company_key = {agent.company_key: agent for agent in agents}
        self._agents_by_extension = {
            agent.extension: agent for agent in agents if agent.extension is not None
        }
        self._agents_by_inbound_number = {
            number: agent for agent in agents for number in agent.inbound_numbers
        }

    @classmethod
    def from_legacy_companies(cls, companies_path: str | Path) -> "AgentRegistry":
        with open(companies_path) as f:
            return cls.from_legacy_company_data(json.load(f))

    @classmethod
    def from_legacy_company_data(cls, companies: dict[str, dict[str, Any]]) -> "AgentRegistry":
        return cls(
            [
                AgentConfig.from_legacy_company(company_key, data)
                for company_key, data in companies.items()
            ]
        )

    def agents(self) -> list[AgentConfig]:
        return list(self._agents_by_company_key.values())

    def get(self, agent_id_or_company_key: str) -> AgentConfig | None:
        return self._agents_by_id.get(agent_id_or_company_key) or self._agents_by_company_key.get(
            agent_id_or_company_key
        )

    def company_key_for_extension(self, extension: str | None) -> str | None:
        agent = self._agents_by_extension.get(str(extension)) if extension is not None else None
        return agent.company_key if agent else None

    def extension_for_display_name(self, display_name: str | None) -> str | None:
        if display_name is None:
            return None
        for agent in self.agents():
            if agent.display_name == display_name:
                return agent.extension
        return None

    def as_legacy_companies(self) -> dict[str, dict[str, Any]]:
        return {
            agent.company_key: agent.to_legacy_company()
            for agent in self.agents()
        }

    def resolve(
        self,
        *,
        stasis_args: list[str] | tuple[str, ...] | None = None,
        dialed_extension: str | None = None,
        inbound_number: str | None = None,
        default_agent_id: str | None = None,
    ) -> AgentRouteResolution:
        for value in stasis_args or ():
            agent = self.get(str(value))
            if agent is not None:
                return AgentRouteResolution(agent=agent, source="stasis_arg", value=str(value))

        if inbound_number is not None:
            agent = self._agents_by_inbound_number.get(str(inbound_number))
            if agent is not None:
                return AgentRouteResolution(
                    agent=agent, source="inbound_number", value=str(inbound_number)
                )

        if dialed_extension is not None:
            agent = self._agents_by_extension.get(str(dialed_extension))
            if agent is not None:
                return AgentRouteResolution(
                    agent=agent, source="dialed_extension", value=str(dialed_extension)
                )

        if default_agent_id is not None:
            agent = self.get(default_agent_id)
            if agent is not None:
                return AgentRouteResolution(
                    agent=agent,
                    source="default",
                    value=default_agent_id,
                    used_default=True,
                )

        raise UnknownAgentError(
            "could not resolve call route from stasis_args, inbound_number, or dialed_extension"
        )

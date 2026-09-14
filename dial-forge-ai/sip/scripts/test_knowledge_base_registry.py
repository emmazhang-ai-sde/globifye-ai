import unittest
from pathlib import Path

from agent_registry import AgentConfig, AgentRegistry
from knowledge_base_registry import (
    KnowledgeBaseRegistry,
    KnowledgeProfileValidationError,
    UnknownKnowledgeProfileError,
)


PROFILES = {
    "globifye": {
        "knowledge_profile_id": "globifye",
        "company_key": "globifye",
        "display_name": "GlobiFYE Knowledge Base",
        "legacy_kb_file": "globifye.md",
        "corpus_path": "globifye/",
        "source_files": ["globifye/features.md", "globifye/faq.md"],
        "retrieval_policy": {"top_k": 3},
        "fallback_policy": {"offer_handoff": True},
        "enabled": True,
    },
    "disabled": {
        "knowledge_profile_id": "disabled",
        "company_key": "globifye",
        "enabled": False,
    },
}


class KnowledgeBaseRegistryTest(unittest.TestCase):
    def test_loads_profiles_from_data(self):
        registry = KnowledgeBaseRegistry.from_profile_data(PROFILES)
        profile = registry.get("globifye")

        self.assertEqual(profile.company_key, "globifye")
        self.assertEqual(profile.display_name, "GlobiFYE Knowledge Base")
        self.assertEqual(profile.legacy_kb_file, "globifye.md")
        self.assertEqual(profile.corpus_path, "globifye/")
        self.assertEqual(profile.source_files[0], "globifye.md")
        self.assertEqual(profile.retrieval_policy["top_k"], 3)

    def test_loads_profiles_from_repository_json(self):
        profiles_path = Path(__file__).resolve().parents[1] / "knowledge-base" / "knowledge_profiles.json"
        registry = KnowledgeBaseRegistry.from_path(profiles_path)

        self.assertIsNotNone(registry.get("pacificbeef"))
        self.assertIsNotNone(registry.get("globifye"))

    def test_resolves_agent_knowledge_profile(self):
        agent = AgentConfig(
            agent_config_id="agent-globifye",
            company_key="globifye",
            display_name="GlobiFYE",
            voice="aura-2-arcas-en",
            knowledge_profile_id="globifye",
        )
        registry = KnowledgeBaseRegistry.from_profile_data(PROFILES)

        profile = registry.resolve_for_agent(agent)

        self.assertEqual(profile.knowledge_profile_id, "globifye")
        self.assertEqual(profile.company_key, agent.company_key)

    def test_agent_registry_preserves_explicit_knowledge_profile_id(self):
        registry = AgentRegistry.from_legacy_company_data(
            {
                "globifye": {
                    "agent_config_id": "agent-globifye",
                    "display_name": "GlobiFYE",
                    "voice": "aura-2-arcas-en",
                    "knowledge_profile_id": "globifye-support",
                }
            }
        )

        self.assertEqual(
            registry.get("agent-globifye").knowledge_profile_id,
            "globifye-support",
        )

    def test_agent_registry_defaults_knowledge_profile_id_to_company_key(self):
        registry = AgentRegistry.from_legacy_company_data(
            {
                "globifye": {
                    "display_name": "GlobiFYE",
                    "voice": "aura-2-arcas-en",
                }
            }
        )

        self.assertEqual(registry.get("globifye").knowledge_profile_id, "globifye")

    def test_disabled_profile_is_represented(self):
        registry = KnowledgeBaseRegistry.from_profile_data(PROFILES)

        self.assertFalse(registry.get("disabled").enabled)

    def test_missing_profile_raises_clear_error(self):
        agent = AgentConfig(
            agent_config_id="agent-missing",
            company_key="globifye",
            display_name="GlobiFYE",
            voice="aura-2-arcas-en",
            knowledge_profile_id="missing",
        )
        registry = KnowledgeBaseRegistry.from_profile_data(PROFILES)

        with self.assertRaisesRegex(UnknownKnowledgeProfileError, "missing knowledge profile"):
            registry.resolve_for_agent(agent)

    def test_company_key_mismatch_is_rejected(self):
        agent = AgentConfig(
            agent_config_id="agent-pacificbeef",
            company_key="pacificbeef",
            display_name="Pacific Beef Trading",
            voice="aura-2-thalia-en",
            knowledge_profile_id="globifye",
        )
        registry = KnowledgeBaseRegistry.from_profile_data(PROFILES)

        with self.assertRaisesRegex(KnowledgeProfileValidationError, "cannot bind"):
            registry.resolve_for_agent(agent)

    def test_rejects_invalid_policy_shape(self):
        with self.assertRaisesRegex(KnowledgeProfileValidationError, "retrieval_policy"):
            KnowledgeBaseRegistry.from_profile_data(
                {
                    "bad": {
                        "company_key": "globifye",
                        "retrieval_policy": ["not", "a", "dict"],
                    }
                }
            )


if __name__ == "__main__":
    unittest.main()

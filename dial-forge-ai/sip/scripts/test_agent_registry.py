import unittest

from agent_registry import AgentRegistry, UnknownAgentError


COMPANIES = {
    "pacificbeef": {
        "display_name": "Pacific Beef Trading",
        "extension": "1000",
        "voice": "aura-2-thalia-en",
        "kb_file": "pacificbeef.md",
        "blurb": "Beef exporter",
    },
    "globifye": {
        "agent_config_id": "agent-globifye",
        "organization_id": "org-1",
        "display_name": "GlobiFYE",
        "extension": "2000",
        "inbound_numbers": ["+15551232000"],
        "voice": "aura-2-arcas-en",
        "kb_file": "globifye.md",
        "blurb": "AI voice agents",
        "human_handoff_enabled": True,
        "default_human_endpoint": "PJSIP/sales-endpoint",
    },
}


class AgentRegistryTest(unittest.TestCase):
    def setUp(self):
        self.registry = AgentRegistry.from_legacy_company_data(COMPANIES)

    def test_resolves_stasis_arg_company_key(self):
        result = self.registry.resolve(
            stasis_args=["globifye"],
            dialed_extension="1000",
            default_agent_id="pacificbeef",
        )

        self.assertEqual(result.agent.company_key, "globifye")
        self.assertEqual(result.source, "stasis_arg")

    def test_resolves_stasis_arg_agent_config_id(self):
        result = self.registry.resolve(stasis_args=["agent-globifye"])

        self.assertEqual(result.agent.company_key, "globifye")
        self.assertEqual(result.agent.agent_config_id, "agent-globifye")

    def test_resolves_dialed_extension_when_stasis_arg_is_unknown(self):
        result = self.registry.resolve(
            stasis_args=["missing-agent"],
            dialed_extension="2000",
            default_agent_id="pacificbeef",
        )

        self.assertEqual(result.agent.company_key, "globifye")
        self.assertEqual(result.source, "dialed_extension")

    def test_resolves_inbound_number(self):
        result = self.registry.resolve(inbound_number="+15551232000")

        self.assertEqual(result.agent.company_key, "globifye")
        self.assertEqual(result.source, "inbound_number")

    def test_falls_back_to_default_agent(self):
        result = self.registry.resolve(dialed_extension="9000", default_agent_id="pacificbeef")

        self.assertEqual(result.agent.company_key, "pacificbeef")
        self.assertTrue(result.used_default)

    def test_raises_without_route_or_default(self):
        with self.assertRaises(UnknownAgentError):
            self.registry.resolve(dialed_extension="9000")

    def test_public_dict_contains_future_agent_fields(self):
        public = self.registry.get("globifye").to_public_dict()

        self.assertEqual(public["agent_config_id"], "agent-globifye")
        self.assertEqual(public["company_key"], "globifye")
        self.assertEqual(public["inbound_numbers"], ["+15551232000"])
        self.assertTrue(public["human_handoff_enabled"])


if __name__ == "__main__":
    unittest.main()

import unittest

from capability_registry import (
    CapabilityRegistry,
    DuplicateCapabilityError,
    RETRIEVE_COMPANY_KB,
    UnknownCapabilityError,
)
from runtime_vocabulary import (
    CapabilityKind,
    KnowledgeBaseResource,
    RuntimeContext,
    StageTransition,
)


class CapabilityRegistryTest(unittest.TestCase):
    def test_default_registry_lists_base_capabilities(self):
        registry = CapabilityRegistry.default()

        self.assertEqual(
            [capability.name for capability in registry.base_capabilities()],
            ["retrieve_company_kb", "request_handoff"],
        )

    def test_duplicate_base_capability_names_are_rejected(self):
        with self.assertRaisesRegex(DuplicateCapabilityError, "duplicate capability"):
            CapabilityRegistry([RETRIEVE_COMPANY_KB, RETRIEVE_COMPANY_KB])

    def test_no_capabilities_are_exposed_when_owner_is_human(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            owner="human",
            knowledge_bases=[self._enabled_kb()],
            stage_transitions=[self._stage_transition()],
            session_state={"human_handoff_enabled": True},
        )

        self.assertEqual(CapabilityRegistry.default().allowed_for(context), [])

    def test_retrieve_company_kb_requires_enabled_matching_kb(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            knowledge_bases=[self._enabled_kb()],
        )

        names = self._allowed_names(context)

        self.assertIn("retrieve_company_kb", names)

    def test_retrieve_company_kb_is_hidden_without_enabled_kb(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            knowledge_bases=[
                KnowledgeBaseResource(
                    knowledge_profile_id="kb-disabled",
                    company_key="globifye",
                    enabled=False,
                )
            ],
        )

        self.assertNotIn("retrieve_company_kb", self._allowed_names(context))

    def test_retrieve_company_kb_is_hidden_for_mismatched_company_scope(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            knowledge_bases=[
                KnowledgeBaseResource(
                    knowledge_profile_id="kb-pacificbeef",
                    company_key="pacificbeef",
                )
            ],
        )

        self.assertNotIn("retrieve_company_kb", self._allowed_names(context))

    def test_request_handoff_requires_handoff_enabled_session_state(self):
        enabled = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            session_state={"human_handoff_enabled": True},
        )
        disabled = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            session_state={"human_handoff_enabled": False},
        )

        self.assertIn("request_handoff", self._allowed_names(enabled))
        self.assertNotIn("request_handoff", self._allowed_names(disabled))

    def test_stage_edges_are_exposed_as_state_capabilities(self):
        transition = self._stage_transition()
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            current_stage="prospect",
            stage_transitions=[transition],
        )

        capabilities = CapabilityRegistry.default().allowed_for(context)
        transition_capability = next(
            capability for capability in capabilities if capability.name == transition.name
        )

        self.assertEqual(transition_capability.kind, CapabilityKind.STATE)
        self.assertEqual(transition_capability.metadata["current_stage"], "prospect")
        self.assertEqual(transition_capability.metadata["target_stage"], "contact")

    def test_duplicate_stage_edge_conflicts_with_base_capability(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            knowledge_bases=[self._enabled_kb()],
            stage_transitions=[
                StageTransition(
                    name="retrieve_company_kb",
                    target="contact",
                    description="invalid duplicate edge",
                )
            ],
        )

        with self.assertRaisesRegex(DuplicateCapabilityError, "duplicate exposed"):
            CapabilityRegistry.default().allowed_for(context)

    def test_llm_tool_schema_is_chat_api_compatible(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            knowledge_bases=[self._enabled_kb()],
            session_state={"human_handoff_enabled": True},
        )

        tools = CapabilityRegistry.default().to_llm_tools(context)
        functions = {tool["function"]["name"]: tool for tool in tools}

        self.assertEqual(functions["retrieve_company_kb"]["type"], "function")
        self.assertEqual(
            functions["retrieve_company_kb"]["function"]["parameters"]["required"],
            ["query"],
        )
        self.assertEqual(
            functions["request_handoff"]["function"]["parameters"]["required"],
            ["reason"],
        )

    def test_unknown_capability_requires_clear_error(self):
        with self.assertRaisesRegex(UnknownCapabilityError, "unknown capability"):
            CapabilityRegistry.default().require("missing_capability")

    def _allowed_names(self, context):
        return [capability.name for capability in CapabilityRegistry.default().allowed_for(context)]

    def _enabled_kb(self):
        return KnowledgeBaseResource(
            knowledge_profile_id="kb-globifye",
            company_key="globifye",
        )

    def _stage_transition(self):
        return StageTransition(
            name="confirmed_worth_automating",
            target="contact",
            description="prospect confirmed they run phone operations worth automating",
        )


if __name__ == "__main__":
    unittest.main()

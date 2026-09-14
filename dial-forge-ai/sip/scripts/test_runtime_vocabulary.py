import unittest

from runtime_vocabulary import (
    CapabilityKind,
    INITIAL_CAPABILITY_KINDS,
    KnowledgeBaseResource,
    RetrievalCapability,
    RuntimeCapability,
    RuntimeContext,
    StageTransition,
)


class RuntimeVocabularyTest(unittest.TestCase):
    def test_initial_capability_kinds_are_stable(self):
        self.assertEqual(
            INITIAL_CAPABILITY_KINDS,
            ("information", "state", "human", "action"),
        )

    def test_knowledge_base_resource_is_company_scoped_information_asset(self):
        kb = KnowledgeBaseResource(
            knowledge_profile_id="kb-globifye",
            company_key="globifye",
            display_name="GlobiFYE Product KB",
            source_files=["features.md", "pricing.md"],
            retrieval_policy={"top_k": 3},
            fallback_policy={"mode": "offer_handoff"},
        )

        self.assertEqual(kb.company_key, "globifye")
        self.assertEqual(kb.source_files, ("features.md", "pricing.md"))
        self.assertEqual(kb.retrieval_policy["top_k"], 3)

    def test_runtime_capability_normalizes_kind(self):
        capability = RuntimeCapability(
            name="retrieve_company_kb",
            kind="information",
            description="Retrieve evidence from the active company's KB.",
            parameters_schema={"type": "object"},
        )

        self.assertEqual(capability.kind, CapabilityKind.INFORMATION)
        self.assertTrue(capability.is_information_tool)

    def test_runtime_capability_builds_llm_tool_schema(self):
        capability = RuntimeCapability(
            name="retrieve_company_kb",
            kind="information",
            description="Retrieve evidence from the active company's KB.",
            parameters_schema={
                "type": "object",
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        )

        self.assertEqual(
            capability.to_llm_tool_schema(),
            {
                "type": "function",
                "function": {
                    "name": "retrieve_company_kb",
                    "description": "Retrieve evidence from the active company's KB.",
                    "parameters": {
                        "type": "object",
                        "properties": {"query": {"type": "string"}},
                        "required": ["query"],
                    },
                },
            },
        )

    def test_retrieval_capability_must_be_information_kind(self):
        capability = RuntimeCapability(
            name="set_stage",
            kind=CapabilityKind.STATE,
            description="Move the call to another sales stage.",
            parameters_schema={"type": "object"},
            risk_level="write",
        )

        with self.assertRaises(ValueError):
            RetrievalCapability(capability=capability)

    def test_runtime_context_keeps_bound_knowledge_bases(self):
        kb = KnowledgeBaseResource(
            knowledge_profile_id="kb-globifye",
            company_key="globifye",
        )
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            call_session_id="call-1",
            knowledge_bases=[kb],
        )

        self.assertEqual(context.company_key, "globifye")
        self.assertEqual(context.knowledge_bases, (kb,))

    def test_runtime_context_keeps_stage_transitions_from_graph_edges(self):
        transition = StageTransition.from_edge(
            "confirmed_worth_automating",
            {
                "target": "contact",
                "description": "prospect confirmed they run phone operations worth automating",
            },
        )
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            current_stage="prospect",
            stage_transitions=[transition],
        )

        self.assertEqual(context.stage_transitions, (transition,))
        self.assertEqual(context.stage_transitions[0].target, "contact")


if __name__ == "__main__":
    unittest.main()

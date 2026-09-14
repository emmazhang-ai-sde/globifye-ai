import unittest

from agent_registry import AgentConfig
from call_session import CallSession
from knowledge_base_registry import KnowledgeBaseRegistry, KnowledgeProfileValidationError
from runtime_context_builder import RuntimeContextBuilderError, build_runtime_context


PROFILES = {
    "globifye": {
        "knowledge_profile_id": "globifye",
        "company_key": "globifye",
        "display_name": "GlobiFYE Knowledge Base",
        "legacy_kb_file": "globifye.md",
        "retrieval_policy": {"top_k": 4},
        "fallback_policy": {"mode": "standard_line"},
    },
    "pacificbeef": {
        "knowledge_profile_id": "pacificbeef",
        "company_key": "pacificbeef",
    },
}


STAGE_GRAPH = {
    "prospect": {
        "edges": {
            "confirmed_worth_automating": {
                "target": "contact",
                "description": "prospect confirmed they run phone operations worth automating",
            }
        }
    },
    "contact": {"edges": {}},
}


class RuntimeContextBuilderTest(unittest.TestCase):
    def test_builds_context_from_agent_session_and_kb_registry(self):
        agent = self._agent()
        session = CallSession.from_agent(agent, call_session_id="call-1")
        registry = KnowledgeBaseRegistry.from_profile_data(PROFILES)

        context = build_runtime_context(
            agent=agent,
            session=session,
            knowledge_base_registry=registry,
            default_human_endpoint="PJSIP/default-sales",
            human_caller_id="Sales",
        )

        self.assertEqual(context.agent_config_id, "agent-globifye")
        self.assertEqual(context.company_key, "globifye")
        self.assertEqual(context.call_session_id, "call-1")
        self.assertEqual(context.owner, "ai")
        self.assertEqual(context.current_stage, None)
        self.assertEqual(context.stage_transitions, ())
        self.assertEqual(context.knowledge_bases[0].knowledge_profile_id, "globifye")
        self.assertEqual(context.knowledge_bases[0].retrieval_policy["top_k"], 4)
        self.assertTrue(context.session_state["human_handoff_enabled"])
        self.assertEqual(
            context.session_state["default_human_endpoint"],
            "PJSIP/globifye-sales",
        )
        self.assertEqual(context.session_state["human_caller_id"], "Sales")

    def test_agent_default_endpoint_falls_back_to_bridge_default(self):
        agent = self._agent(default_human_endpoint=None)
        session = CallSession.from_agent(agent, call_session_id="call-1")

        context = build_runtime_context(
            agent=agent,
            session=session,
            knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
            default_human_endpoint="PJSIP/default-sales",
        )

        self.assertEqual(
            context.session_state["default_human_endpoint"],
            "PJSIP/default-sales",
        )

    def test_extra_session_state_overrides_defaults(self):
        agent = self._agent()
        session = CallSession.from_agent(agent, call_session_id="call-1")

        context = build_runtime_context(
            agent=agent,
            session=session,
            knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
            session_state={
                "human_handoff_enabled": False,
                "default_human_endpoint": "PJSIP/override",
            },
        )

        self.assertFalse(context.session_state["human_handoff_enabled"])
        self.assertEqual(context.session_state["default_human_endpoint"], "PJSIP/override")

    def test_builds_stage_transitions_when_stage_graph_is_available(self):
        agent = self._agent()
        session = CallSession.from_agent(agent, call_session_id="call-1")

        context = build_runtime_context(
            agent=agent,
            session=session,
            knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
            current_stage="prospect",
            stage_graph=STAGE_GRAPH,
        )

        self.assertEqual(context.current_stage, "prospect")
        self.assertEqual(len(context.stage_transitions), 1)
        self.assertEqual(context.stage_transitions[0].name, "confirmed_worth_automating")
        self.assertEqual(context.stage_transitions[0].target, "contact")

    def test_stage_graph_without_current_stage_returns_empty_transitions(self):
        agent = self._agent()
        session = CallSession.from_agent(agent, call_session_id="call-1")

        context = build_runtime_context(
            agent=agent,
            session=session,
            knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
            stage_graph=STAGE_GRAPH,
        )

        self.assertIsNone(context.current_stage)
        self.assertEqual(context.stage_transitions, ())

    def test_unknown_current_stage_raises_clear_error(self):
        agent = self._agent()
        session = CallSession.from_agent(agent, call_session_id="call-1")

        with self.assertRaisesRegex(RuntimeContextBuilderError, "unknown current_stage"):
            build_runtime_context(
                agent=agent,
                session=session,
                knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
                current_stage="missing",
                stage_graph=STAGE_GRAPH,
            )

    def test_agent_session_mismatch_is_rejected(self):
        agent = self._agent()
        other_agent = AgentConfig(
            agent_config_id="agent-other",
            company_key="globifye",
            display_name="GlobiFYE",
            voice="aura-2-arcas-en",
            knowledge_profile_id="globifye",
        )
        session = CallSession.from_agent(other_agent, call_session_id="call-1")

        with self.assertRaisesRegex(RuntimeContextBuilderError, "agent_config_id"):
            build_runtime_context(
                agent=agent,
                session=session,
                knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
            )

    def test_kb_profile_company_mismatch_is_rejected_by_registry(self):
        agent = self._agent(knowledge_profile_id="pacificbeef")
        session = CallSession.from_agent(agent, call_session_id="call-1")

        with self.assertRaisesRegex(KnowledgeProfileValidationError, "cannot bind"):
            build_runtime_context(
                agent=agent,
                session=session,
                knowledge_base_registry=KnowledgeBaseRegistry.from_profile_data(PROFILES),
            )

    def _agent(self, *, default_human_endpoint="PJSIP/globifye-sales", knowledge_profile_id="globifye"):
        return AgentConfig(
            agent_config_id="agent-globifye",
            company_key="globifye",
            display_name="GlobiFYE",
            voice="aura-2-arcas-en",
            knowledge_profile_id=knowledge_profile_id,
            human_handoff_enabled=True,
            default_human_endpoint=default_human_endpoint,
            handoff_policy={"handoff_mode": "warm"},
        )


if __name__ == "__main__":
    unittest.main()

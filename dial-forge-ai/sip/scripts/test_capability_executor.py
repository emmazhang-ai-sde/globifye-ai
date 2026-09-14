import unittest

from capability_executor import (
    CapabilityExecutionError,
    CapabilityNotAllowedError,
    execute_capability_call,
)
from runtime_vocabulary import KnowledgeBaseResource, RuntimeContext, StageTransition


class CapabilityExecutorTest(unittest.TestCase):
    def test_retrieve_company_kb_uses_runtime_company_scope(self):
        calls = []

        def fake_retrieval_handler(**kwargs):
            calls.append(kwargs)
            return [
                {
                    "id": 1,
                    "source_file": "globifye/features.md",
                    "section": "Features",
                    "content": "GlobiFYE automates inbound and outbound calls.",
                    "distance": 0.12,
                }
            ]

        result = execute_capability_call(
            self._context(),
            "retrieve_company_kb",
            {
                "query": "What does GlobiFYE do?",
                "company_key": "pacificbeef",
            },
            retrieval_handler=fake_retrieval_handler,
        )

        self.assertTrue(result["has_evidence"])
        self.assertEqual(result["audit"]["company_key"], "globifye")
        self.assertEqual(calls[0]["company_key"], "globifye")
        self.assertEqual(calls[0]["query"], "What does GlobiFYE do?")
        self.assertEqual(calls[0]["k"], 4)

    def test_retrieve_company_kb_returns_fallback_policy_when_no_evidence(self):
        result = execute_capability_call(
            self._context(),
            "retrieve_company_kb",
            {"query": "Do you sell tractors?"},
            retrieval_handler=lambda **kwargs: [],
        )

        self.assertFalse(result["has_evidence"])
        self.assertEqual(result["evidence"], "")
        self.assertEqual(result["fallback_policy"], {"mode": "standard_line"})

    def test_retrieve_company_kb_requires_non_empty_query(self):
        with self.assertRaisesRegex(CapabilityExecutionError, "non-empty query"):
            execute_capability_call(
                self._context(),
                "retrieve_company_kb",
                {"query": "  "},
                retrieval_handler=lambda **kwargs: [],
            )

    def test_retrieve_company_kb_requires_allowed_capability(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            knowledge_bases=[],
        )

        with self.assertRaisesRegex(CapabilityNotAllowedError, "not allowed"):
            execute_capability_call(
                context,
                "retrieve_company_kb",
                {"query": "What do you do?"},
                retrieval_handler=lambda **kwargs: [],
            )

    def test_stage_transition_executes_allowed_edge_through_handler(self):
        calls = []

        def fake_stage_handler(**kwargs):
            calls.append(kwargs)
            return {"updated": True}

        result = execute_capability_call(
            self._stage_context(),
            "confirmed_worth_automating",
            {"reason": "prospect confirmed volume"},
            stage_transition_handler=fake_stage_handler,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["kind"], "state")
        self.assertEqual(result["previous_stage"], "prospect")
        self.assertEqual(result["current_stage"], "contact")
        self.assertEqual(result["reason"], "prospect confirmed volume")
        self.assertEqual(result["handler_result"], {"updated": True})
        self.assertEqual(calls[0]["transition_name"], "confirmed_worth_automating")
        self.assertEqual(calls[0]["previous_stage"], "prospect")
        self.assertEqual(calls[0]["target_stage"], "contact")

    def test_stage_transition_requires_handler(self):
        with self.assertRaisesRegex(CapabilityExecutionError, "requires a handler"):
            execute_capability_call(
                self._stage_context(),
                "confirmed_worth_automating",
                {"reason": "prospect confirmed volume"},
            )

    def test_stage_transition_rejects_non_string_reason(self):
        with self.assertRaisesRegex(CapabilityExecutionError, "reason must be a string"):
            execute_capability_call(
                self._stage_context(),
                "confirmed_worth_automating",
                {"reason": 42},
                stage_transition_handler=lambda **kwargs: None,
            )

    def test_request_handoff_executes_allowed_handoff_through_handler(self):
        calls = []

        def fake_handoff_handler(**kwargs):
            calls.append(kwargs)
            return {"invite_status": "ringing", "channel_id": "human-1"}

        result = execute_capability_call(
            self._handoff_context(),
            "request_handoff",
            {
                "reason": "caller asked for a person",
                "urgency": "urgent",
                "preferred_team": "sales",
            },
            human_handoff_handler=fake_handoff_handler,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["kind"], "human")
        self.assertEqual(result["reason"], "caller asked for a person")
        self.assertEqual(result["urgency"], "urgent")
        self.assertEqual(result["preferred_team"], "sales")
        self.assertEqual(result["endpoint"], "PJSIP/sales-endpoint")
        self.assertEqual(result["handler_result"]["invite_status"], "ringing")
        self.assertEqual(calls[0]["reason"], "caller asked for a person")
        self.assertEqual(calls[0]["endpoint"], "PJSIP/sales-endpoint")
        self.assertEqual(calls[0]["caller_id"], "Sales")

    def test_request_handoff_requires_handler(self):
        with self.assertRaisesRegex(CapabilityExecutionError, "requires a handler"):
            execute_capability_call(
                self._handoff_context(),
                "request_handoff",
                {"reason": "caller asked for a person"},
            )

    def test_request_handoff_requires_non_empty_reason(self):
        with self.assertRaisesRegex(CapabilityExecutionError, "non-empty reason"):
            execute_capability_call(
                self._handoff_context(),
                "request_handoff",
                {"reason": " "},
                human_handoff_handler=lambda **kwargs: None,
            )

    def test_request_handoff_rejects_unknown_urgency(self):
        with self.assertRaisesRegex(CapabilityExecutionError, "urgency"):
            execute_capability_call(
                self._handoff_context(),
                "request_handoff",
                {"reason": "caller asked for a person", "urgency": "soon"},
                human_handoff_handler=lambda **kwargs: None,
            )

    def test_request_handoff_requires_allowed_capability(self):
        context = RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            session_state={"human_handoff_enabled": False},
        )

        with self.assertRaisesRegex(CapabilityNotAllowedError, "not allowed"):
            execute_capability_call(
                context,
                "request_handoff",
                {"reason": "caller asked for a person"},
                human_handoff_handler=lambda **kwargs: None,
            )

    def _context(self):
        return RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            call_session_id="call-1",
            knowledge_bases=[
                KnowledgeBaseResource(
                    knowledge_profile_id="globifye",
                    company_key="globifye",
                    retrieval_policy={"top_k": 4},
                    fallback_policy={"mode": "standard_line"},
                )
            ],
        )

    def _stage_context(self):
        return RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            call_session_id="call-1",
            current_stage="prospect",
            stage_transitions=[
                StageTransition(
                    name="confirmed_worth_automating",
                    target="contact",
                    description="prospect confirmed they run phone operations worth automating",
                )
            ],
        )

    def _handoff_context(self):
        return RuntimeContext(
            agent_config_id="agent-globifye",
            company_key="globifye",
            call_session_id="call-1",
            session_state={
                "human_handoff_enabled": True,
                "default_human_endpoint": "PJSIP/sales-endpoint",
                "human_caller_id": "Sales",
            },
        )


if __name__ == "__main__":
    unittest.main()

import json
import unittest

from runtime_capability_policy import (
    CapabilityCallBudgetExceeded,
    RuntimeCapabilityCallBudget,
    serialize_tool_result,
)
from runtime_vocabulary import CapabilityKind, RuntimeCapability


class RuntimeCapabilityPolicyTest(unittest.TestCase):
    def test_call_budget_allows_calls_up_to_capability_limit(self):
        budget = RuntimeCapabilityCallBudget.from_capabilities([
            self._capability("retrieve_company_kb", max_calls=2),
        ])

        first = budget.reserve("retrieve_company_kb")
        second = budget.reserve("retrieve_company_kb")

        self.assertEqual(first["call_count"], 1)
        self.assertEqual(second["call_count"], 2)
        self.assertEqual(second["max_calls_per_turn"], 2)

    def test_call_budget_rejects_calls_over_capability_limit(self):
        budget = RuntimeCapabilityCallBudget.from_capabilities([
            self._capability("request_handoff", max_calls=1),
        ])

        budget.reserve("request_handoff")

        with self.assertRaisesRegex(CapabilityCallBudgetExceeded, "exceeded"):
            budget.reserve("request_handoff")

    def test_call_budget_rejects_unexposed_capability(self):
        budget = RuntimeCapabilityCallBudget.from_capabilities([
            self._capability("retrieve_company_kb", max_calls=3),
        ])

        with self.assertRaisesRegex(CapabilityCallBudgetExceeded, "not allowed"):
            budget.reserve("unknown_capability")

    def test_unlimited_capability_has_no_call_limit(self):
        budget = RuntimeCapabilityCallBudget.from_capabilities([
            self._capability("log_debug_note", max_calls=None),
        ])

        for _ in range(5):
            budget.reserve("log_debug_note")

        self.assertEqual(budget.call_counts["log_debug_note"], 5)

    def test_serialize_tool_result_returns_unmodified_small_result(self):
        content, truncated, original_count = serialize_tool_result(
            {"ok": True, "capability": "retrieve_company_kb", "evidence": "short"},
            max_chars=500,
        )

        decoded = json.loads(content)
        self.assertFalse(truncated)
        self.assertEqual(decoded["evidence"], "short")
        self.assertEqual(original_count, len(content))

    def test_serialize_tool_result_compacts_large_result_to_valid_json(self):
        result = {
            "ok": True,
            "capability": "retrieve_company_kb",
            "kind": "information",
            "query": "What do you do?",
            "has_evidence": True,
            "evidence": "A" * 4000,
            "chunks": [
                {
                    "source_file": "kb.md",
                    "section": "Overview",
                    "content": "B" * 2000,
                    "distance": 0.1,
                }
            ],
            "audit": {"company_key": "globifye"},
        }

        content, truncated, original_count = serialize_tool_result(
            result,
            max_chars=1000,
        )
        decoded = json.loads(content)

        self.assertTrue(truncated)
        self.assertLessEqual(len(content), 1000)
        self.assertGreater(original_count, len(content))
        self.assertTrue(decoded["truncated"])
        self.assertEqual(decoded["capability"], "retrieve_company_kb")
        self.assertIn("chunk_summaries", decoded)

    def test_serialize_tool_result_rejects_too_small_limit(self):
        with self.assertRaisesRegex(ValueError, "at least 200"):
            serialize_tool_result({"ok": True}, max_chars=100)

    def _capability(self, name, *, max_calls):
        return RuntimeCapability(
            name=name,
            kind=CapabilityKind.INFORMATION,
            description=name,
            parameters_schema={"type": "object", "properties": {}},
            max_calls_per_turn=max_calls,
        )


if __name__ == "__main__":
    unittest.main()

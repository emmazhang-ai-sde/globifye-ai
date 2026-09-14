import unittest

import rag_retrieval


class RagRetrievalTest(unittest.TestCase):
    def test_should_retrieve_skips_tiny_utterances(self):
        self.assertFalse(rag_retrieval.should_retrieve("hi"))
        self.assertTrue(rag_retrieval.should_retrieve("pricing details"))

    def test_build_query_prepends_previous_turn_for_followup(self):
        self.assertEqual(
            rag_retrieval.build_query("how much?", "Tell me about pricing."),
            "Tell me about pricing. how much?",
        )

    def test_build_query_keeps_self_contained_question(self):
        self.assertEqual(
            rag_retrieval.build_query("What integrations do you support?", "Tell me about pricing."),
            "What integrations do you support?",
        )

    def test_render_joins_chunk_content(self):
        self.assertEqual(
            rag_retrieval.render(
                [
                    {"content": "First chunk."},
                    {"content": "Second chunk."},
                    {"content": ""},
                ]
            ),
            "First chunk.\n\nSecond chunk.",
        )


if __name__ == "__main__":
    unittest.main()

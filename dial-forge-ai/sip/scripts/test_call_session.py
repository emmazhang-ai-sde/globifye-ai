import unittest

from agent_registry import AgentConfig
from call_session import CallSession


AGENT = AgentConfig(
    agent_config_id="agent-pacificbeef",
    company_key="pacificbeef",
    display_name="Pacific Beef Trading",
    voice="aura-2-thalia-en",
)

OTHER_AGENT = AgentConfig(
    agent_config_id="agent-globifye",
    company_key="globifye",
    display_name="GlobiFYE",
    voice="aura-2-arcas-en",
)


class CallSessionTest(unittest.TestCase):
    def test_owner_change_increments_epoch_once(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")

        self.assertTrue(session.set_owner("human"))
        self.assertEqual(session.owner, "human")
        self.assertEqual(session.epoch, 1)

        self.assertFalse(session.set_owner("human"))
        self.assertEqual(session.epoch, 1)

        self.assertTrue(session.set_owner("AI"))
        self.assertEqual(session.owner, "ai")
        self.assertEqual(session.epoch, 2)

    def test_rejects_unknown_owner(self):
        session = CallSession.from_agent(AGENT)

        with self.assertRaises(ValueError):
            session.set_owner("sales")

    def test_owner_change_event_keeps_reason_and_source(self):
        session = CallSession.from_agent(AGENT)

        session.set_owner("human", reason="manual_toggle", source="dtmf")

        self.assertEqual(
            session.events[-1],
            {
                "type": "owner_changed",
                "payload": {
                    "old_owner": "ai",
                    "new_owner": "human",
                    "reason": "manual_toggle",
                    "source": "dtmf",
                },
            },
        )

    def test_start_call_resets_call_specific_state_for_agent(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.set_owner("human")
        session.set_room(bridge_id="bridge-old", ai_media_channel_id="media-old")
        session.invite_human(
            endpoint="PJSIP/old-sales",
            caller_id="Old Sales",
            channel_id="human-old",
        )
        session.set_playback("playback-old")
        session.append_human_transcript("old human segment")

        history = [{"role": "system", "content": "new prompt"}]
        session.start_call(
            caller_channel_id="caller-new",
            agent=OTHER_AGENT,
            conversation_history=history,
        )

        self.assertEqual(session.status, "active")
        self.assertEqual(session.owner, "ai")
        self.assertEqual(session.epoch, 0)
        self.assertEqual(session.company_key, "globifye")
        self.assertEqual(session.voice, "aura-2-arcas-en")
        self.assertEqual(session.caller_channel_id, "caller-new")
        self.assertIsNone(session.bridge_id)
        self.assertIsNone(session.ai_media_channel_id)
        self.assertIsNone(session.human_channel_id)
        self.assertIsNone(session.human_endpoint)
        self.assertIsNone(session.human_caller_id)
        self.assertIsNone(session.human_invite_status)
        self.assertIsNone(session.handoff_accept_status)
        self.assertIsNone(session.handoff_accepted_by)
        self.assertIsNone(session.handoff_accept_source)
        self.assertIsNone(session.handoff_resume_status)
        self.assertIsNone(session.handoff_resumed_by)
        self.assertIsNone(session.handoff_resume_source)
        self.assertIsNone(session.handoff_handback_note)
        self.assertIsNone(session.handoff_failure_status)
        self.assertIsNone(session.handoff_failure_reason)
        self.assertIsNone(session.handoff_failure_source)
        self.assertEqual(session.skipped_ai_turn_count, 0)
        self.assertIsNone(session.last_skip_turn_reason)
        self.assertIsNone(session.last_skip_turn_source)
        self.assertIsNone(session.current_playback_id)
        self.assertEqual(session.conversation_history, history)
        self.assertEqual(session.human_segment_transcript, [])

    def test_room_human_playback_and_end_call_fields(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[{"role": "system", "content": "prompt"}],
        )

        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )
        session.set_human_channel("human-1")
        session.set_playback("playback-1")
        session.clear_playback()
        session.end_call()

        self.assertEqual(session.status, "ended")
        self.assertIsNone(session.caller_channel_id)
        self.assertIsNone(session.bridge_id)
        self.assertIsNone(session.ai_media_channel_id)
        self.assertIsNone(session.human_channel_id)
        self.assertIsNone(session.current_playback_id)
        self.assertEqual(
            [event["type"] for event in session.events],
            [
                "call_started",
                "call.room_created",
                "human.invite_created",
                "human.joined",
                "ai_playback_started",
                "ai_playback_cleared",
                "call_ended",
            ],
        )

    def test_room_debug_payload_exposes_room_ids(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")

        self.assertEqual(
            session.room_debug_payload(),
            {
                "call_session_id": "call-1",
                "status": "active",
                "owner": "ai",
                "agent_config_id": "agent-pacificbeef",
                "company_key": "pacificbeef",
                "display_name": "Pacific Beef Trading",
                "room": {
                    "bridge_id": "bridge-1",
                    "caller_channel_id": "caller-1",
                    "ai_media_channel_id": "media-1",
                    "human_channel_id": None,
                },
                "handoff": {
                    "human_endpoint": None,
                    "human_caller_id": None,
                    "invite_status": None,
                    "accept_status": None,
                    "accepted_by": None,
                    "accept_source": None,
                    "resume_status": None,
                    "resumed_by": None,
                    "resume_source": None,
                    "handback_note": None,
                    "failure_status": None,
                    "failure_reason": None,
                    "failure_source": None,
                },
                "skip_turn": {
                    "count": 0,
                    "last_reason": None,
                    "last_source": None,
                },
            },
        )

    def test_human_invite_status_moves_from_ringing_to_joined(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")

        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )

        self.assertEqual(session.human_endpoint, "PJSIP/sales-endpoint")
        self.assertEqual(session.human_caller_id, "Sales")
        self.assertEqual(session.human_channel_id, "human-1")
        self.assertEqual(session.human_invite_status, "ringing")
        self.assertEqual(session.events[-1]["type"], "human.invite_created")

        session.set_human_channel("human-1")

        self.assertEqual(session.human_invite_status, "joined")
        self.assertEqual(session.events[-1]["type"], "human.joined")
        self.assertEqual(
            session.room_debug_payload()["handoff"],
            {
                "human_endpoint": "PJSIP/sales-endpoint",
                "human_caller_id": "Sales",
                "invite_status": "joined",
                "accept_status": None,
                "accepted_by": None,
                "accept_source": None,
                "resume_status": None,
                "resumed_by": None,
                "resume_source": None,
                "handback_note": None,
                "failure_status": None,
                "failure_reason": None,
                "failure_source": None,
            },
        )

    def test_accept_handoff_requires_joined_human(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )

        with self.assertRaises(RuntimeError):
            session.accept_handoff(accepted_by="Sales", source="dtmf")

    def test_accept_handoff_switches_owner_and_records_acceptance(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )
        session.set_human_channel("human-1")

        self.assertTrue(session.accept_handoff(accepted_by="Sales", source="dtmf"))

        self.assertEqual(session.owner, "human")
        self.assertEqual(session.epoch, 1)
        self.assertEqual(session.handoff_accept_status, "accepted")
        self.assertEqual(session.handoff_accepted_by, "Sales")
        self.assertEqual(session.handoff_accept_source, "dtmf")
        self.assertEqual(
            [event["type"] for event in session.events[-2:]],
            ["owner_changed", "handoff.accepted"],
        )
        self.assertEqual(session.room_debug_payload()["owner"], "human")
        self.assertEqual(session.room_debug_payload()["handoff"]["accept_status"], "accepted")

    def test_resume_ai_is_noop_before_human_owns_call(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )

        self.assertFalse(
            session.resume_ai(
                handback_note="Nothing to hand back.",
                resumed_by="Sales",
                source="control_api",
            )
        )
        self.assertEqual(session.owner, "ai")
        self.assertIsNone(session.handoff_resume_status)

    def test_resume_ai_switches_owner_and_records_handback_note(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )
        session.set_human_channel("human-1")
        session.accept_handoff(accepted_by="Sales", source="dtmf")

        self.assertTrue(
            session.resume_ai(
                handback_note="Customer asked for pricing.",
                resumed_by="Sales",
                source="control_api",
            )
        )

        self.assertEqual(session.owner, "ai")
        self.assertEqual(session.epoch, 2)
        self.assertEqual(session.handoff_resume_status, "resumed")
        self.assertEqual(session.handoff_resumed_by, "Sales")
        self.assertEqual(session.handoff_resume_source, "control_api")
        self.assertEqual(session.handoff_handback_note, "Customer asked for pricing.")
        self.assertEqual(
            [event["type"] for event in session.events[-3:]],
            ["handback_note_added", "owner_changed", "handoff.resumed"],
        )
        self.assertEqual(
            session.room_debug_payload()["handoff"]["resume_status"],
            "resumed",
        )

    def test_handback_context_message_includes_note_and_human_segment(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )
        session.set_human_channel("human-1")
        session.accept_handoff(accepted_by="Sales", source="dtmf")
        session.append_human_transcript("The customer asked for pricing.")
        session.append_human_transcript("The rep promised a quick quote.")
        session.resume_ai(
            handback_note="Continue by confirming quote details.",
            resumed_by="Sales",
            source="control_api",
        )

        message = session.handback_context_message()

        self.assertEqual(message["role"], "system")
        self.assertIn("Continue by confirming quote details.", message["content"])
        self.assertIn("- The customer asked for pricing.", message["content"])
        self.assertIn("- The rep promised a quick quote.", message["content"])

    def test_skip_ai_turn_records_event_and_keeps_handback_transcript(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )
        session.set_human_channel("human-1")
        session.accept_handoff(accepted_by="Sales", source="dtmf")

        session.skip_ai_turn("Customer is still speaking to the human.", source="groq_worker")

        self.assertEqual(session.human_segment_transcript, ["Customer is still speaking to the human."])
        self.assertEqual(session.skipped_ai_turn_count, 1)
        self.assertEqual(
            session.last_skip_turn_reason,
            "owner is HUMAN; AI is listening but not responding",
        )
        self.assertEqual(session.last_skip_turn_source, "groq_worker")
        self.assertEqual(session.events[-1]["type"], "ai.turn_skipped")
        self.assertEqual(session.events[-1]["payload"]["owner"], "human")
        self.assertEqual(
            session.room_debug_payload()["skip_turn"],
            {
                "count": 1,
                "last_reason": "owner is HUMAN; AI is listening but not responding",
                "last_source": "groq_worker",
            },
        )

    def test_handoff_failure_records_outcome_and_clears_human_channel(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")
        session.start_call(
            caller_channel_id="caller-1",
            agent=AGENT,
            conversation_history=[],
        )
        session.set_room(bridge_id="bridge-1", ai_media_channel_id="media-1")
        session.invite_human(
            endpoint="PJSIP/sales-endpoint",
            caller_id="Sales",
            channel_id="human-1",
        )

        session.mark_handoff_failure(
            status="no_answer",
            reason="human channel ended before answer",
            source="ari_stasis_end",
        )

        self.assertIsNone(session.human_channel_id)
        self.assertEqual(session.human_invite_status, "no_answer")
        self.assertEqual(session.handoff_failure_status, "no_answer")
        self.assertEqual(
            session.handoff_failure_reason,
            "human channel ended before answer",
        )
        self.assertEqual(session.handoff_failure_source, "ari_stasis_end")
        self.assertEqual(session.events[-1]["type"], "handoff.failed")
        self.assertEqual(session.events[-1]["payload"]["human_channel_id"], "human-1")
        self.assertEqual(
            session.room_debug_payload()["handoff"]["failure_status"],
            "no_answer",
        )

    def test_handoff_failure_rejects_unknown_status(self):
        session = CallSession.from_agent(AGENT, call_session_id="call-1")

        with self.assertRaises(ValueError):
            session.mark_handoff_failure(
                status="maybe",
                reason="unknown failure",
                source="test",
            )


if __name__ == "__main__":
    unittest.main()

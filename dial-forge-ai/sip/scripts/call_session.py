"""Per-call state wrapper for AI-human-AI handoff.

This is deliberately small: it centralizes state that currently lives in module
globals, while existing ARI functions still perform the actual telephony work.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any
from uuid import uuid4

from agent_registry import AgentConfig


VALID_OWNERS = {"ai", "human"}
VALID_HANDOFF_FAILURE_STATUSES = {
    "declined",
    "no_answer",
    "busy",
    "failed",
    "dropped",
}


@dataclass
class CallSession:
    call_session_id: str
    agent_config_id: str
    company_key: str
    voice: str
    display_name: str
    owner: str = "ai"
    epoch: int = 0
    status: str = "idle"
    caller_channel_id: str | None = None
    bridge_id: str | None = None
    ai_media_channel_id: str | None = None
    human_channel_id: str | None = None
    human_endpoint: str | None = None
    human_caller_id: str | None = None
    human_invite_status: str | None = None
    handoff_accept_status: str | None = None
    handoff_accepted_by: str | None = None
    handoff_accept_source: str | None = None
    handoff_resume_status: str | None = None
    handoff_resumed_by: str | None = None
    handoff_resume_source: str | None = None
    handoff_handback_note: str | None = None
    handoff_failure_status: str | None = None
    handoff_failure_reason: str | None = None
    handoff_failure_source: str | None = None
    skipped_ai_turn_count: int = 0
    last_skip_turn_reason: str | None = None
    last_skip_turn_source: str | None = None
    current_playback_id: str | None = None
    conversation_history: list[dict[str, Any]] = field(default_factory=list)
    human_segment_transcript: list[str] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)

    @classmethod
    def from_agent(
        cls,
        agent: AgentConfig,
        *,
        call_session_id: str | None = None,
        conversation_history: list[dict[str, Any]] | None = None,
    ) -> "CallSession":
        return cls(
            call_session_id=call_session_id or str(uuid4()),
            agent_config_id=agent.agent_config_id,
            company_key=agent.company_key,
            voice=agent.voice,
            display_name=agent.display_name,
            conversation_history=list(conversation_history or []),
        )

    def start_call(
        self,
        *,
        caller_channel_id: str,
        agent: AgentConfig,
        conversation_history: list[dict[str, Any]],
    ) -> None:
        self.agent_config_id = agent.agent_config_id
        self.company_key = agent.company_key
        self.voice = agent.voice
        self.display_name = agent.display_name
        self.owner = "ai"
        self.epoch = 0
        self.status = "active"
        self.caller_channel_id = caller_channel_id
        self.bridge_id = None
        self.ai_media_channel_id = None
        self.human_channel_id = None
        self.human_endpoint = None
        self.human_caller_id = None
        self.human_invite_status = None
        self.handoff_accept_status = None
        self.handoff_accepted_by = None
        self.handoff_accept_source = None
        self.handoff_resume_status = None
        self.handoff_resumed_by = None
        self.handoff_resume_source = None
        self.handoff_handback_note = None
        self.handoff_failure_status = None
        self.handoff_failure_reason = None
        self.handoff_failure_source = None
        self.skipped_ai_turn_count = 0
        self.last_skip_turn_reason = None
        self.last_skip_turn_source = None
        self.current_playback_id = None
        self.conversation_history = list(conversation_history)
        self.human_segment_transcript = []
        self.append_event("call_started", caller_channel_id=caller_channel_id)

    def set_room(self, *, bridge_id: str, ai_media_channel_id: str) -> None:
        self.bridge_id = bridge_id
        self.ai_media_channel_id = ai_media_channel_id
        self.append_event("call.room_created", **self.room_debug_payload()["room"])

    def room_debug_payload(self) -> dict[str, Any]:
        return {
            "call_session_id": self.call_session_id,
            "status": self.status,
            "owner": self.owner,
            "agent_config_id": self.agent_config_id,
            "company_key": self.company_key,
            "display_name": self.display_name,
            "room": {
                "bridge_id": self.bridge_id,
                "caller_channel_id": self.caller_channel_id,
                "ai_media_channel_id": self.ai_media_channel_id,
                "human_channel_id": self.human_channel_id,
            },
            "handoff": {
                "human_endpoint": self.human_endpoint,
                "human_caller_id": self.human_caller_id,
                "invite_status": self.human_invite_status,
                "accept_status": self.handoff_accept_status,
                "accepted_by": self.handoff_accepted_by,
                "accept_source": self.handoff_accept_source,
                "resume_status": self.handoff_resume_status,
                "resumed_by": self.handoff_resumed_by,
                "resume_source": self.handoff_resume_source,
                "handback_note": self.handoff_handback_note,
                "failure_status": self.handoff_failure_status,
                "failure_reason": self.handoff_failure_reason,
                "failure_source": self.handoff_failure_source,
            },
            "skip_turn": {
                "count": self.skipped_ai_turn_count,
                "last_reason": self.last_skip_turn_reason,
                "last_source": self.last_skip_turn_source,
            },
        }

    def invite_human(
        self,
        *,
        endpoint: str,
        caller_id: str | None = None,
        channel_id: str | None = None,
    ) -> None:
        self.human_endpoint = endpoint
        self.human_caller_id = caller_id
        self.human_channel_id = channel_id
        self.human_invite_status = "ringing"
        self.append_event(
            "human.invite_created",
            endpoint=endpoint,
            caller_id=caller_id,
            human_channel_id=channel_id,
        )

    def set_human_channel(self, channel_id: str) -> None:
        self.human_channel_id = channel_id
        if self.human_invite_status == "ringing":
            self.human_invite_status = "joined"
            self.append_event("human.joined", human_channel_id=channel_id)
        else:
            self.append_event("human_channel_set", human_channel_id=channel_id)

    def accept_handoff(
        self,
        *,
        accepted_by: str | None = None,
        source: str | None = None,
        reason: str = "handoff_accepted",
    ) -> bool:
        if self.human_invite_status != "joined" or not self.human_channel_id:
            raise RuntimeError("human handoff cannot be accepted before the human joins")
        changed = self.set_owner("human", reason=reason, source=source)
        if not changed:
            return False
        self.human_segment_transcript = []
        self.handoff_accept_status = "accepted"
        self.handoff_accepted_by = accepted_by
        self.handoff_accept_source = source
        self.append_event(
            "handoff.accepted",
            accepted_by=accepted_by,
            source=source,
            human_channel_id=self.human_channel_id,
        )
        return True

    def handback_context_message(self) -> dict[str, str]:
        transcript = "\n".join(
            f"- {line}" for line in self.human_segment_transcript if line
        )
        if not transcript:
            transcript = "- No final transcript was captured during the human segment."
        note = self.handoff_handback_note or "No handback note was provided."
        return {
            "role": "system",
            "content": (
                "The human representative returned this live phone call to the AI.\n"
                f"Handback note from human: {note}\n"
                "Final transcript captured during the human-owned segment:\n"
                f"{transcript}\n"
                "Continue naturally from this context. Do not mention internal handoff mechanics."
            ),
        }

    def resume_ai(
        self,
        *,
        handback_note: str | None = None,
        resumed_by: str | None = None,
        source: str | None = None,
        reason: str = "handoff_resumed",
    ) -> bool:
        if self.owner != "human":
            return False
        if handback_note:
            self.handoff_handback_note = handback_note
            self.append_event("handback_note_added", note=handback_note, source=source)
        changed = self.set_owner("ai", reason=reason, source=source)
        if not changed:
            return False
        self.handoff_resume_status = "resumed"
        self.handoff_resumed_by = resumed_by
        self.handoff_resume_source = source
        self.append_event(
            "handoff.resumed",
            resumed_by=resumed_by,
            source=source,
            handback_note=handback_note,
        )
        return True

    def mark_handoff_failure(
        self,
        *,
        status: str,
        reason: str,
        source: str | None = None,
    ) -> None:
        if status not in VALID_HANDOFF_FAILURE_STATUSES:
            raise ValueError(
                "handoff failure status must be one of "
                f"{sorted(VALID_HANDOFF_FAILURE_STATUSES)}"
            )
        old_human_channel_id = self.human_channel_id
        self.handoff_failure_status = status
        self.handoff_failure_reason = reason
        self.handoff_failure_source = source
        self.human_invite_status = status
        self.human_channel_id = None
        self.append_event(
            "handoff.failed",
            status=status,
            reason=reason,
            source=source,
            owner=self.owner,
            human_channel_id=old_human_channel_id,
        )

    def set_playback(self, playback_id: str | None) -> None:
        self.current_playback_id = playback_id
        if playback_id:
            self.append_event("ai_playback_started", playback_id=playback_id)

    def clear_playback(self) -> None:
        if self.current_playback_id:
            self.append_event("ai_playback_cleared", playback_id=self.current_playback_id)
        self.current_playback_id = None

    def set_owner(
        self,
        owner: str,
        *,
        reason: str | None = None,
        source: str | None = None,
    ) -> bool:
        normalized = owner.lower()
        if normalized not in VALID_OWNERS:
            raise ValueError(f"owner must be one of {sorted(VALID_OWNERS)}")
        if normalized == self.owner:
            return False
        old_owner = self.owner
        self.owner = normalized
        self.epoch += 1
        payload = {"old_owner": old_owner, "new_owner": normalized}
        if reason:
            payload["reason"] = reason
        if source:
            payload["source"] = source
        self.append_event("owner_changed", **payload)
        return True

    def append_human_transcript(self, text: str) -> None:
        if text:
            self.human_segment_transcript.append(text)

    def skip_ai_turn(
        self,
        transcript: str,
        *,
        reason: str = "owner is HUMAN; AI is listening but not responding",
        source: str | None = None,
    ) -> None:
        self.append_human_transcript(transcript)
        self.skipped_ai_turn_count += 1
        self.last_skip_turn_reason = reason
        self.last_skip_turn_source = source
        self.append_event(
            "ai.turn_skipped",
            reason=reason,
            source=source,
            transcript=transcript,
            owner=self.owner,
        )

    def end_call(self) -> None:
        self.status = "ended"
        self.append_event("call_ended", caller_channel_id=self.caller_channel_id)
        self.caller_channel_id = None
        self.bridge_id = None
        self.ai_media_channel_id = None
        self.human_channel_id = None
        self.human_endpoint = None
        self.human_caller_id = None
        self.human_invite_status = None
        self.handoff_accept_status = None
        self.handoff_accepted_by = None
        self.handoff_accept_source = None
        self.handoff_resume_status = None
        self.handoff_resumed_by = None
        self.handoff_resume_source = None
        self.handoff_handback_note = None
        self.handoff_failure_status = None
        self.handoff_failure_reason = None
        self.handoff_failure_source = None
        self.current_playback_id = None

    def append_event(self, event_type: str, **payload: Any) -> None:
        self.events.append({"type": event_type, "payload": payload})

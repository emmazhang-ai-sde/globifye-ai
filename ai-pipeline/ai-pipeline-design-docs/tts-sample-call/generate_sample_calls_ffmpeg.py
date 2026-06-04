"""
generate_sample_calls_ffmpeg.py
Generates two sample sales call MP3s using Microsoft Edge TTS (edge-tts) and ffmpeg.

Requirements:
    pip install edge-tts
    brew install ffmpeg  (macOS)

Note: pydub is NOT used. It depends on the audioop C module removed in Python 3.13,
and pyaudioop (the intended replacement) has no PyPI distribution as of 2026-06.
All audio concatenation is handled by ffmpeg subprocess calls instead.

Output (written to the same directory as this script):
    script-1-winning-call.mp3
    script-2-lost-deal.mp3
"""

import asyncio
import re
import os
import subprocess
import edge_tts

# ---------------------------------------------------------------------------
# Voice mapping
# ---------------------------------------------------------------------------

VOICES = {
    "SARAH": "en-US-JennyNeural",         # Female, American
    "JAMES": "en-GB-RyanNeural",           # Male, British
    "MIKE":  "en-US-GuyNeural",            # Male, American
    "PRIYA": "en-IN-NeerjaNeural",         # Female, British-Indian
    "DAVID": "en-US-ChristopherNeural",    # Male, American, deeper tone
}

SILENCE_BETWEEN_TURNS_MS = 350

# ---------------------------------------------------------------------------
# Script 1 — The Winning Call
# ---------------------------------------------------------------------------

SCRIPT_1 = [
    ("SARAH", "Hey James, good to reconnect. Thanks for jumping back on — I know you've got a lot on this week."),
    ("JAMES", "Yeah, it's been a bit of a stretch, to be honest. But, um, I've been looking forward to this one."),
    ("SARAH", "Good, I'm glad. So — last time we talked, you mentioned your team is about fifteen reps, mostly outbound, and the thing that keeps coming up is, uh, how much time they're spending on manual logging after every call. I thought today we'd go a bit deeper into that and I can show you exactly how DialForge handles it end to end."),
    ("JAMES", "Yeah, that's exactly it. Our manager actually flagged it again this week — reps are spending close to an hour a day just on, you know, notes and CRM updates."),
    ("SARAH", "An hour a day, across fifteen reps — I mean, that adds up fast. Okay, that gives me a really clear starting point. Let me show you what this actually looks like."),

    ("SARAH", "So the core of what DialForge does — it transcribes every call in real time, and the moment the call ends, it runs an AI analysis: a summary, the key topics that came up, any objections the rep encountered, and, uh, what the rep did well. The manager doesn't have to sit in on a single call to know what's happening across the whole team."),
    ("JAMES", "And the transcription — how accurate is it? We've, um, tried tools before where it was more noise than signal."),
    ("SARAH", "That's a fair concern. So we run on Deepgram's Nova model, which is purpose-built for conversational speech. It handles accents, crosstalk, filler words — and it keeps a raw version of the transcript alongside a cleaned-up one for the UI, so you're not, you know, reading uh so like yeah in every summary."),
    ("JAMES", "Okay, that's actually a meaningful distinction. The tools we tried before just dumped everything out raw."),
    ("SARAH", "Exactly. And because the transcript feeds directly into the LLM, the analysis actually reflects what was said — hesitations, backtracking — not just the polished version."),
    ("JAMES", "Right. What about integrations? We're on Salesforce."),
    ("SARAH", "Native two-way sync. A call analysed in DialForge updates the Salesforce record automatically — summary, key topics, all of it. Your reps don't touch anything after the call ends."),
    ("JAMES", "That alone — honestly, that alone might justify this for us. The manual copying is what kills morale."),

    ("SARAH", "Tell me a bit more about how your managers are currently coaching. Are they doing call reviews?"),
    ("JAMES", "Sporadically, yeah. They'll, um, pull up a recording if something goes wrong, but there's no systematic process. It's very reactive."),
    ("SARAH", "That's really common. What tends to happen with DialForge is the coaching becomes proactive — the manager gets a weekly digest of flagged moments across all reps. Objection patterns, calls where the talk-to-listen ratio was off, deals that went quiet after a strong first call. They can, you know, spot issues before they become pipeline problems."),
    ("JAMES", "That would be a significant shift for us. Right now our manager is basically flying blind between deals."),
    ("SARAH", "It usually is a shift. And the reps tend to like it too — it feels less like surveillance and more like, you know, they're getting a coach in their corner."),
    ("JAMES", "How long does rollout typically take?"),
    ("SARAH", "For a team your size, two weeks to full deployment. We have a dedicated onboarding specialist, and we handle the Salesforce integration setup on our end. Your IT team just needs to be, uh, available for the SSO configuration."),
    ("JAMES", "Two weeks — that's actually faster than I expected."),

    ("SARAH", "Let's talk about what this looks like commercially. For a team of fifteen, you'd sit comfortably on our Growth plan — that's one hundred thousand dollars a year, which covers up to thirty seats. So you've got room to grow without hitting a ceiling."),
    ("JAMES", "A hundred thousand. That's... I mean, that's a meaningful number. I'd need to build a proper business case for that."),
    ("SARAH", "Of course. And let me give you the frame that tends to land with finance: if your reps recover even forty-five minutes a day from eliminating manual logging — which is conservative, based on what you described — at a fully-loaded cost of fifty dollars an hour, across fifteen reps, you're recovering the annual cost in under three months."),
    ("JAMES", "Okay. When you put it that way, the maths actually work."),
    ("SARAH", "And to make it lower-risk — we offer a thirty-day pilot. Up to ten seats, no contract, full access to the analysis suite. You get real data to bring to the business case conversation rather than, you know, just taking my word for it."),
    ("JAMES", "That's what I'd want, honestly. I don't want to take a hundred-thousand-dollar decision to our CFO without numbers behind it."),
    ("SARAH", "Exactly right. Let's start there."),

    ("SARAH", "I'll send over the pilot agreement today — it's a one-pager. If you can loop in your IT lead for the Salesforce setup, we can have you live by end of next week."),
    ("JAMES", "Yeah, copy in Mark on that. He'll want to know anyway."),
    ("SARAH", "Done. James, I really appreciate you being so open today. I think there's a genuine fit here, and I'm excited to show you what the data looks like after the first week."),
    ("JAMES", "Yeah, honestly — I came in a bit sceptical, but this has been one of the more useful calls I've had this month."),
    ("SARAH", "That's always the best thing to hear. We'll talk soon. Take care."),
    ("JAMES", "Cheers, Sarah. Talk soon."),
]

# ---------------------------------------------------------------------------
# Script 2 — The Lost Deal
# ---------------------------------------------------------------------------

SCRIPT_2 = [
    ("MIKE",  "Hey Priya, great to reconnect. Thanks for making the time again."),
    ("PRIYA", "Of course. Yeah, um, happy to dig in a bit more."),
    ("MIKE",  "So — when we spoke last week, you mentioned your team is around twenty-five reps, and the thing that caught your attention at the webinar was the real-time transcription piece. You wanted to understand whether it could, you know, actually be useful for coaching, or whether it's more of a compliance tool. I thought today we'd focus on exactly that."),
    ("PRIYA", "Yeah, exactly. We've looked at a couple of solutions and they all say they do AI analysis, but it ends up being, I don't know, fairly surface level in practice."),
    ("MIKE",  "That's a fair concern. Let me show you what the output actually looks like."),

    ("MIKE",  "So DialForge transcribes every call in real time, and the post-call analysis breaks down into four things: a summary, key topics, objection analysis, and what the rep did well. And these aren't generic — they're specific to that call. If a rep fumbled a pricing objection, the analysis flags it and, uh, notes where in the conversation it happened."),
    ("PRIYA", "Okay. And, um, what's the source model for the analysis? Because we've had tools that just wrap GPT-4 and call it AI."),
    ("MIKE",  "The transcription is Deepgram — purpose-built for conversational speech. The analysis layer uses a fine-tuned LLM specifically trained on sales call patterns. It's not a generic wrapper."),
    ("PRIYA", "That's — okay, that's a more specific answer than I usually get. Good."),
    ("MIKE",  "What does your current coaching process look like? You mentioned your managers are doing some call reviews."),
    ("PRIYA", "It's inconsistent, honestly. Each manager has their own approach. Some listen to recordings, some don't. There's, um, no standardised process across the team."),
    ("MIKE",  "That's really common at your scale. What DialForge does in that situation is give every manager the same baseline — a weekly digest of flagged moments, objection patterns, talk-to-listen ratios. It standardises the coaching without, you know, forcing everyone into the same workflow."),
    ("PRIYA", "Mm. We actually do something similar already with our current tool."),
    ("MIKE",  "Oh yeah? What are you on?"),
    ("PRIYA", "We're on HubSpot. We've been using it for, uh, about two years."),

    ("MIKE",  "Got it. HubSpot's call features have improved — where DialForge goes deeper is in the analysis quality. The flagging is more granular, and it's built specifically for coaching workflows, not just logging."),
    ("PRIYA", "I mean, we've built a lot around HubSpot at this point. Workflows, reporting, the whole pipeline management. Switching costs are something I, you know, take seriously."),
    ("MIKE",  "I understand. The good news is DialForge isn't a replacement for HubSpot — it sits on top of it. Native sync, so your pipeline data stays in HubSpot and DialForge just adds the call intelligence layer. No migration required."),
    ("PRIYA", "Okay, that's a better framing. But — my team has just gotten comfortable with what they have. I'm not sure this is the right moment to introduce another tool, even a complementary one."),
    ("MIKE",  "That's a fair read. How are your reps feeling about the current setup — is there frustration, or is it more good enough?"),
    ("PRIYA", "Honestly, it's probably... good enough for most of them. There are a couple of senior reps who want more data, but the broader team isn't, um, pushing for change."),
    ("MIKE",  "Understood. Oh — sorry, it looks like someone just joined."),
    ("PRIYA", "Yeah — that's David. David, we're about halfway through."),
    ("DAVID", "Hey, sorry I'm late. What are we looking at?"),
    ("PRIYA", "Mike's walking through DialForge — the call intelligence platform from the webinar."),
    ("DAVID", "Right. Quick question — what does the pricing look like?"),

    ("MIKE",  "Sure. For a team of twenty-five, you'd be on our Growth plan — that's one hundred thousand dollars a year, covers up to thirty seats."),
    ("DAVID", "A hundred thousand a year? On top of what we're already paying for HubSpot?"),
    ("MIKE",  "That's right — it's a separate contract. The value case is that you recover that cost through rep productivity gains and faster coaching cycles."),
    ("DAVID", "Look, I appreciate the framing, but a hundred K is a whole different conversation. We're in a budget review right now and nothing new is getting approved this quarter."),
    ("MIKE",  "Is there a range that would be more workable? We do have a Starter plan at eighty thousand for a smaller seat count."),
    ("DAVID", "It's not really about the number. It's about the timing. We're not adding vendors right now, full stop."),
    ("MIKE",  "I hear you. Priya — is there a point in the year where this kind of decision could move? Q3 maybe?"),
    ("PRIYA", "Maybe. But I genuinely can't commit to anything right now. And even if budget opens up, we'd, um, need to run a formal vendor evaluation. That process takes time on its own."),
    ("DAVID", "Yeah — sign-off from two VPs minimum. Six weeks easily. The timing just doesn't line up."),
    ("MIKE",  "That makes complete sense. I'm not going to push you toward something that doesn't fit your cycle."),

    ("MIKE",  "Would it be okay if I followed up at the start of Q3? Just to reconnect when the budget review is behind you."),
    ("PRIYA", "Yeah, that's fine. Check back then."),
    ("MIKE",  "I'll send over a couple of things in the meantime — a breakdown of how DialForge sits alongside HubSpot, and a case study from a team that was in a similar position. Just so you have it when the timing is right."),
    ("PRIYA", "Sure."),
    ("MIKE",  "Priya, David — I appreciate you both making the time. I hope this was useful context for when you do revisit it."),
    ("PRIYA", "Thanks, Mike. Take care."),
    ("MIKE",  "You too. Have a good rest of your day."),
    ("DAVID", "Thanks."),
]

# ---------------------------------------------------------------------------
# Generation helpers
# ---------------------------------------------------------------------------

def clean_text(text: str) -> str:
    """Strip any stage directions in [brackets] before sending to TTS."""
    return re.sub(r'\[.*?\]', '', text).strip()


SPEECH_RATE = "+10%"  # 1.25x speed; set to "+0%" for normal rate

async def generate_clip(text: str, voice: str, path: str) -> None:
    await edge_tts.Communicate(clean_text(text), voice=voice, rate=SPEECH_RATE).save(path)


async def generate_script(script: list, output_filename: str) -> None:
    tmp_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__tts_tmp__")
    os.makedirs(tmp_dir, exist_ok=True)

    print(f"\nGenerating {output_filename} ({len(script)} lines)...")

    paths = [os.path.join(tmp_dir, f"{i:03d}.mp3") for i in range(len(script))]

    # Generate all clips concurrently
    await asyncio.gather(*[
        generate_clip(text, VOICES[speaker], path)
        for (speaker, text), path in zip(script, paths)
    ])

    # Generate a short silence clip with ffmpeg
    silence_path = os.path.join(tmp_dir, "silence.mp3")
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi",
        "-i", "anullsrc=r=44100:cl=stereo",
        "-t", str(SILENCE_BETWEEN_TURNS_MS / 1000),
        "-q:a", "9", "-acodec", "libmp3lame",
        silence_path,
    ], check=True, capture_output=True)

    # Write ffmpeg concat list, interleaving silence between turns
    concat_list_path = os.path.join(tmp_dir, "concat_list.txt")
    with open(concat_list_path, "w") as f:
        for i, path in enumerate(paths):
            if i > 0:
                f.write(f"file '{silence_path}'\n")
            f.write(f"file '{path}'\n")

    # Concatenate into final output
    out_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audio-generated")
    os.makedirs(out_dir, exist_ok=True)
    out_path = os.path.join(out_dir, output_filename)
    replacing = os.path.exists(out_path)
    subprocess.run([
        "ffmpeg", "-y", "-f", "concat", "-safe", "0",
        "-i", concat_list_path,
        "-c", "copy", out_path,
    ], check=True, capture_output=True)

    # Cleanup temp files
    for p in paths:
        if os.path.exists(p):
            os.remove(p)
    os.remove(silence_path)
    os.remove(concat_list_path)
    os.rmdir(tmp_dir)

    action = "replaced" if replacing else "created"
    print(f"  -> {out_path}  ({action})")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

SCRIPTS = { # Map of script names to their corresponding lists
    "script-1-winning-call": SCRIPT_1, 
    "script-2-lost-deal":    SCRIPT_2,
}

async def main():
    for name, script in SCRIPTS.items():
        await generate_script(script, f"{name}.mp3")
    print("\nDone.")


if __name__ == "__main__":
    asyncio.run(main())

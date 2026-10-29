"""A local check-in subscriber. Contacting people belongs to another integration."""
from __future__ import annotations

import json

from events import FallEvent


class CheckInPrompt:
    """Display/console state, kept outside the detector's pose rules."""

    def __init__(self, *, interactive: bool = True) -> None:
        self.interactive = interactive
        self.active = False
        self.event: FallEvent | None = None
        self.response: str | None = None
        self.message = ""

    def on_event(self, event: FallEvent) -> None:
        if self.active:
            return
        self.event = event
        self.response = None
        self.active = True
        self.message = "Possible fall / posture change. Are you okay?"
        print(json.dumps({
            "question": "Are you okay?",
            "reason": "Possible fall / posture change",
            "source_time": event.source_time,
            "response_keys": {"o": "okay", "h": "help"} if self.interactive else {},
            "help_dispatched": False,
        }), flush=True)

    def respond(self, response: str) -> str | None:
        if response not in ("okay", "help"):
            raise ValueError("Response must be 'okay' or 'help'")
        if not self.active:
            return None
        self.active = False
        self.response = response
        self.message = "I'm okay recorded." if response == "okay" else (
            "Help requested. No contact system is configured; no help was dispatched."
        )
        print(json.dumps({
            "check_in_response": response,
            "message": self.message,
            "help_dispatched": False,
        }), flush=True)
        return self.message

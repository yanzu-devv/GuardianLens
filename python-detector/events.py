"""Events only: integrations own prompts, calling, and escalation."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
import logging
from typing import Callable


class EventType(str, Enum):
    POSSIBLE_FALL = "POSSIBLE_FALL"
    FALL = "FALL"
    SLUMP = "SLUMP"


@dataclass(frozen=True)
class FallEvent:
    timestamp: datetime
    type: EventType
    confidence: float  # Landmark visibility heuristic; NOT probability of a medical event.
    torso_angle: float | None
    source_time: float  # Monotonic webcam time or recorded-clip time, in seconds.
    evidence: str = "full_body_rule"
    shoulder_tilt: float | None = None


EventCallback = Callable[[FallEvent], None]


class EventHook:
    def __init__(self) -> None:
        self._callbacks: list[EventCallback] = []

    def on_event(self, callback: EventCallback) -> Callable[[], None]:
        if not callable(callback):
            raise TypeError("Event callback must be callable")
        self._callbacks.append(callback)

        def unsubscribe() -> None:
            if callback in self._callbacks:
                self._callbacks.remove(callback)

        return unsubscribe

    def emit(self, event: FallEvent) -> None:
        for callback in tuple(self._callbacks):
            try:
                callback(event)
            except Exception as exc:
                # A failed integration must not prevent other subscribers seeing the event.
                logging.getLogger(__name__).error("Event callback failed (%s)", type(exc).__name__)

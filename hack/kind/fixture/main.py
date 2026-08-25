import math
import os
import time


def handler(context, event):
    burn_ms = int(os.environ.get("NUCLIO_CANARY_CPU_BURN_MS", "0"))
    deadline = time.perf_counter() + (burn_ms / 1000)
    value = 0.0
    while time.perf_counter() < deadline:
        value = math.sqrt(value + 1.0)
    return {"ok": True, "echo": event.body}

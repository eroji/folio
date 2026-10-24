"""Worker entry point: `python -m folio.worker`.

TODO(M2): claim and run jobs from the `jobs` table (Task 7 owns the queue).
For now this is a heartbeat-only loop so the compose stack and the admin
health check work end to end.
"""

import time

from folio.config import get_settings

IDLE_S = 10.0


def main() -> None:
    settings = get_settings()
    heartbeat = settings.data_dir / ".worker-heartbeat"
    heartbeat.parent.mkdir(parents=True, exist_ok=True)
    while True:
        heartbeat.touch()
        time.sleep(IDLE_S)


if __name__ == "__main__":
    main()

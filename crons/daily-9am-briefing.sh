#!/usr/bin/env bash
# schedule: 0 9 * * *
set -euo pipefail

#!/usr/bin/env bash
# Memphis daily 9:00 briefing — weather + world news + filesystem state
set -uo pipefail
exec /home/memphis/memphis/crons/daily-9am-briefing.sh

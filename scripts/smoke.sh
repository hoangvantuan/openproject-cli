#!/usr/bin/env bash
#
# Real-lifecycle smoke gate for op-cli, run by hand before every publish.
# There are no automated integration tests by design, so this script is the
# regression net for real write paths: it drives a create, update, time log,
# and delete lifecycle against a scratch project on a live instance.
#
# Configuration (environment):
#   OPENPROJECT_URL       base URL of the instance      (required unless
#                         OP_CLI_SMOKE_DRY=1)
#   OPENPROJECT_API_KEY   API key with write access     (required unless
#                         OP_CLI_SMOKE_DRY=1)
#   OP_CLI_SMOKE_BIN      binary to exercise; defaults to the freshly
#                         built dist/bin.js of this repository
#   OP_CLI_SMOKE_DRY      1 simulates the whole run: every external
#                         command is echoed, none executes; exit 0 when
#                         the script itself parses and stays coherent
#
# The scratch project itself is left behind on purpose; remove it afterwards
# with `op-cli project delete <id> --yes` or through the OpenProject web UI.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -n "${OP_CLI_SMOKE_BIN:-}" ]; then
  BIN="$OP_CLI_SMOKE_BIN"
elif [ -f "$REPO_ROOT/dist/bin.js" ]; then
  BIN="node $REPO_ROOT/dist/bin.js"
else
  echo "smoke: no binary to exercise." >&2
  echo "smoke: run 'npm run build' first, or point OP_CLI_SMOKE_BIN at an installed op-cli." >&2
  exit 2
fi

CURRENT_STEP=""
DRY=0
case "${OP_CLI_SMOKE_DRY:-}" in
  1|true|yes) DRY=1 ;;
esac
on_error() {
  echo "smoke: FAIL at step: ${CURRENT_STEP:-<unknown>}" >&2
  if [ -n "${SCRATCH_IDENT:-}" ]; then
    echo "smoke: leftover scratch project '${SCRATCH_IDENT}' (id ${PROJ_ID:-?}); remove it via the web UI." >&2
  fi
}
trap on_error ERR

step() {
  CURRENT_STEP="$1"
  echo "[smoke] $1"
}

if [ "$DRY" = "1" ]; then
  # The dry gate: prove the script parses, then shadow every launcher with
  # an echo so no external command runs. Shell functions take precedence
  # over PATH lookups, so "$BIN ..." and the node assertions below all
  # degrade to echoes and the lifecycle walks through without side effects.
  bash -n "$REPO_ROOT/scripts/smoke.sh"
  node() {
    if [ "${1:-}" = "-e" ]; then
      echo "[smoke:dry] node -e <inline script>"
    else
      echo "[smoke:dry] node $*"
    fi
  }
  launcher="${BIN%% *}"
  if [ "$launcher" != "node" ]; then
    eval "${launcher}() { echo \"[smoke:dry] ${launcher} \$*\"; }"
  fi
fi

json_field() {
  # Read JSON from stdin, print one top-level field, or fail loudly.
  # CAUTION: $1 is interpolated straight into the JavaScript literal below;
  # only call this helper with fixed literals from this script, never with
  # data read from the instance or the environment.
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const value = data[process.argv[1]];
    if (value === undefined) {
      console.error("smoke: JSON record carries no '"$1"' field");
      process.exit(3);
    }
    console.log(String(value));
  ' "$1"
}

if [ "$DRY" != "1" ] && { [ -z "${OPENPROJECT_URL:-}" ] || [ -z "${OPENPROJECT_API_KEY:-}" ]; }; then
  echo "smoke: this gate needs a real instance to write to." >&2
  echo "smoke: export OPENPROJECT_URL and OPENPROJECT_API_KEY first, then rerun." >&2
  echo "smoke: or set OP_CLI_SMOKE_DRY=1 to simulate the run without any writes." >&2
  exit 2
fi

step "preflight: doctor against ${OPENPROJECT_URL:-<dry: no instance>}"
if [ "$DRY" = "1" ]; then
  $BIN doctor
else
  $BIN doctor > /dev/null
fi

STAMP="$(date +%Y%m%d-%H%M%S)"
SCRATCH_IDENT="op-cli-smoke-$STAMP"

# --- Project create --------------------------------------------------------

step "create scratch project '$SCRATCH_IDENT'"
PROJ_JSON="$($BIN project create "op-cli smoke $STAMP" --identifier "$SCRATCH_IDENT" --json)"
PROJ_ID="$(printf '%s' "$PROJ_JSON" | json_field id)"

# --- Work package create ----------------------------------------------------

step "create work package in project $PROJ_ID"
WP_JSON="$($BIN wp create "smoke subject A" --project "$PROJ_ID" --type Task --json)"
WP_ID="$(printf '%s' "$WP_JSON" | json_field id)"

# --- Work package update ----------------------------------------------------

step "update work package $WP_ID"
UPDATED_JSON="$($BIN wp update "$WP_ID" --subject "smoke subject B" --json)"
GOT_SUBJECT="$(printf '%s' "$UPDATED_JSON" | json_field subject)"
if [ "$DRY" != "1" ] && [ "$GOT_SUBJECT" != "smoke subject B" ]; then
  echo "smoke: update echoed subject '$GOT_SUBJECT' instead of 'smoke subject B'" >&2
  false
fi

# --- Time log ---------------------------------------------------------------
# The activity vocabulary hangs off the project; pick its first entry so the
# script adapts to any instance instead of hardcoding "Development".

step "resolve an activity of project $PROJ_ID"
ACT_JSON="$($BIN meta activities --project "$PROJ_ID" --json)"
ACT_NAME="$(node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const row = Array.isArray(rows) ? rows[0] : undefined;
  if (!row || typeof row.name !== "string") {
    console.error("smoke: instance exposes no time entry activity for the scratch project");
    process.exit(3);
  }
  console.log(row.name);
' <<<"$ACT_JSON")"

step "log 1h30m on work package $WP_ID (activity '$ACT_NAME')"
ENTRY_JSON="$($BIN time log "$WP_ID" --hours 1h30m --activity "$ACT_NAME" --json)"
ENTRY_ID="$(printf '%s' "$ENTRY_JSON" | json_field id)"

# --- Regression paths only reachable against a live API ---------------------
# time list --wp builds the entity_type/entity_id filter pair; --updated-after
# builds the <>d date-range operator. Mocked tests cover their shapes, but
# only a real instance proves OpenProject accepts them.

step "time list --wp $WP_ID --from today (entity_type/entity_id filters)"
TIME_ROWS="$($BIN time list --wp "$WP_ID" --from today --json)"
node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const id = process.argv[1];
  if (!Array.isArray(rows) || !rows.some((r) => String(r.id) === id)) {
    console.error("smoke: time list missed the entry " + id + " it just created");
    process.exit(3);
  }
' "$ENTRY_ID" <<<"$TIME_ROWS"

# A SINGLE entry of 24 hours or more comes back spelled with a day
# component ("P1DT1H"), the form that used to make every wide enough
# report refuse the instance's own answer. One entry has to cross the
# boundary by itself: every entry is parsed on its own before anything is
# summed, so a total built from smaller entries never reaches that form.
step "log 25h on work package $WP_ID so one entry crosses a day"
DAY_ENTRY_JSON="$($BIN time log "$WP_ID" --hours 25h --activity "$ACT_NAME" --json)"
DAY_ENTRY_ID="$(printf '%s' "$DAY_ENTRY_JSON" | json_field id)"
DAY_ENTRY_ISO="$(printf '%s' "$DAY_ENTRY_JSON" | json_field hours_iso)"
if [ "$DRY" != "1" ]; then
  # Without a day component in the answer, the step still passes while
  # covering nothing; say so instead of reporting a hollow green.
  case "$DAY_ENTRY_ISO" in
    *D*) ;;
    *)
      echo "smoke: the instance spelled 25 hours as '$DAY_ENTRY_ISO', with no day component; this step no longer covers the read path it exists for" >&2
      false
      ;;
  esac
fi

step "time report --wp $WP_ID over an entry spelled $DAY_ENTRY_ISO"
REPORT_JSON="$($BIN time report --wp "$WP_ID" --json)"
node -e '
  const groups = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const total = Array.isArray(groups)
    ? groups.reduce((carry, group) => carry + Number(group.hours), 0)
    : Number.NaN;
  if (!(total >= 25)) {
    console.error("smoke: time report totalled " + total + " hours, so it never read the entry that crosses a day");
    process.exit(3);
  }
' <<<"$REPORT_JSON"

step "wp list --updated-after 1d on project $PROJ_ID (<>d operator)"
# 1d instead of today: the instance evaluates <>d in its own timezone, so
# a just-made update can carry yesterday's UTC stamp; the two-day window
# stays immune while exercising the same operator.
WP_ROWS="$($BIN wp list --project "$PROJ_ID" --updated-after 1d --json)"
node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const id = Number(process.argv[1]);
  if (!Array.isArray(rows) || !rows.some((r) => r.id === id)) {
    console.error("smoke: wp list --updated-after missed work package " + id);
    process.exit(3);
  }
' "$WP_ID" <<<"$WP_ROWS"

step "star and unstar project $PROJ_ID (favourite endpoints)"
$BIN project star "$PROJ_ID" > /dev/null
$BIN project unstar "$PROJ_ID" > /dev/null

# --- Teardown ---------------------------------------------------------------

step "delete time entry $ENTRY_ID"
$BIN time delete "$ENTRY_ID" --yes > /dev/null

step "delete time entry $DAY_ENTRY_ID"
$BIN time delete "$DAY_ENTRY_ID" --yes > /dev/null

step "delete work package $WP_ID"
$BIN wp delete "$WP_ID" --yes > /dev/null

trap - ERR
if [ "$DRY" = "1" ]; then
  echo "[smoke] PASS: dry simulation coherent, nothing was executed or written."
else
  echo "[smoke] PASS: full lifecycle succeeded."
  echo "smoke: leftover scratch project '$SCRATCH_IDENT' (id $PROJ_ID); remove it via the web UI."
fi

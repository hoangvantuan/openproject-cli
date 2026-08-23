#!/usr/bin/env bash
#
# Real-lifecycle smoke gate for op-cli, run by hand before every publish.
# There are no automated integration tests by design, so this script is the
# regression net for real write paths: it drives a create, update, time log,
# and delete lifecycle against a scratch project on a live instance.
#
# Configuration (environment):
#   OPENPROJECT_URL       base URL of the instance      (required)
#   OPENPROJECT_API_KEY   API key with write access     (required)
#   OP_CLI_SMOKE_BIN      binary to exercise; defaults to the freshly
#                         built dist/bin.js of this repository
#
# The scratch project itself is left behind on purpose: the CLI refuses to
# delete projects, so remove it through the OpenProject web UI afterwards.

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

json_field() {
  # Read JSON from stdin, print one top-level field, or fail loudly.
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

# --- Preflight -------------------------------------------------------------

if [ -z "${OPENPROJECT_URL:-}" ] || [ -z "${OPENPROJECT_API_KEY:-}" ]; then
  echo "smoke: this gate needs a real instance to write to." >&2
  echo "smoke: export OPENPROJECT_URL and OPENPROJECT_API_KEY first, then rerun." >&2
  exit 2
fi

step "preflight: doctor against ${OPENPROJECT_URL}"
$BIN doctor > /dev/null

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
if [ "$GOT_SUBJECT" != "smoke subject B" ]; then
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

step "delete work package $WP_ID"
$BIN wp delete "$WP_ID" --yes > /dev/null

trap - ERR
echo "[smoke] PASS: full lifecycle succeeded."
echo "smoke: leftover scratch project '$SCRATCH_IDENT' (id $PROJ_ID); remove it via the web UI."

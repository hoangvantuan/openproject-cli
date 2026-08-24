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
  # Read JSON from stdin, print one field, or fail loudly. A dotted path
  # walks into a nested object, so a Formattable field is read as
  # "description.raw".
  # CAUTION: $1 is interpolated straight into the JavaScript literal below;
  # only call this helper with fixed literals from this script, never with
  # data read from the instance or the environment.
  node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    let value = data;
    for (const step of process.argv[1].split(".")) {
      value = value === null || typeof value !== "object"
        ? undefined
        : value[step];
    }
    if (value === undefined || value === null) {
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

step "create scratch project '$SCRATCH_IDENT' with a description"
PROJ_DESC="smoke description **A**"
PROJ_JSON="$($BIN project create "op-cli smoke $STAMP" --identifier "$SCRATCH_IDENT" \
  --description "$PROJ_DESC" --json)"
PROJ_ID="$(printf '%s' "$PROJ_JSON" | json_field id)"
# description is Formattable: a plain-string payload is accepted, ignored,
# and reported as success, so only an echo-back can see the difference.
GOT_DESC="$(printf '%s' "$PROJ_JSON" | json_field description.raw)"
if [ "$DRY" != "1" ] && [ "$GOT_DESC" != "$PROJ_DESC" ]; then
  echo "smoke: project create echoed description '$GOT_DESC' instead of '$PROJ_DESC'" >&2
  false
fi

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

# --- List custom field ------------------------------------------------------
# A list field's value is a CustomOption resource: the text form is accepted
# and dropped, so only a live instance proves the href form lands. Which
# fields a project exposes is instance configuration, so the step adapts and
# skips when there is no list field to exercise.

step "look for a list custom field on project $PROJ_ID"
# meta fields loads the project vocabulary; meta show then hands over the
# whole store, which is the only place the owning type of a field is
# readable. A field is only usable with the type it hangs off. The defect
# this step guards bites hardest on a required list field, so required
# ones are preferred when the instance exposes several.
$BIN meta fields --project "$PROJ_ID" > /dev/null
META_JSON="$($BIN meta show --json)"
LIST_PROBE="$(node -e '
  const store = JSON.parse(require("fs").readFileSync(0, "utf8")) ?? {};
  const scoped = store.projectScoped ?? {};
  const byType = (scoped[process.argv[1]] ?? {}).custom_fields ?? {};
  const typeName = new Map((store.types ?? []).map((t) => [String(t.id), t.name]));
  const candidates = [];
  for (const [typeId, fields] of Object.entries(byType)) {
    if (!typeName.has(typeId)) {
      continue;
    }
    for (const row of fields ?? []) {
      if (row.is_list === true
          && Array.isArray(row.allowed_options)
          && row.allowed_options.length > 0) {
        candidates.push({
          key: row.key,
          name: row.name,
          options: row.allowed_options,
          value: row.allowed_options[0].name,
          type: typeName.get(typeId),
          multi: row.is_multi === true,
          required: row.is_required === true,
        });
      }
    }
  }
  // A required single-valued field exercises the strictest path; a
  // multi-valued one is the fallback, and the assertions below read both
  // shapes. Creating on a type whose other required list fields sit empty
  // would bounce off the API, so those ride along as extra pairs. A
  // required field can never be cleared, so its second option is handed
  // over for an update instead.
  candidates.sort((a, b) =>
    Number(b.required) - Number(a.required)
    || Number(a.multi) - Number(b.multi));
  const pick = candidates[0];
  if (pick !== undefined) {
    console.log(pick.key);
    console.log(pick.name);
    console.log(pick.value);
    console.log(pick.type);
    console.log(pick.multi ? 1 : 0);
    console.log(pick.required ? 1 : 0);
    console.log(pick.options[1] ? pick.options[1].name : "");
    for (const other of candidates) {
      if (other !== pick && other.type === pick.type && other.required) {
        console.log(`${other.name}=${other.value}`);
      }
    }
  }
' "$PROJ_ID" <<<"$META_JSON")"
LIST_KEY="$(printf '%s\n' "$LIST_PROBE" | sed -n 1p)"
LIST_NAME="$(printf '%s\n' "$LIST_PROBE" | sed -n 2p)"
LIST_VALUE="$(printf '%s\n' "$LIST_PROBE" | sed -n 3p)"
LIST_TYPE="$(printf '%s\n' "$LIST_PROBE" | sed -n 4p)"
LIST_MULTI="$(printf '%s\n' "$LIST_PROBE" | sed -n 5p)"
LIST_REQUIRED="$(printf '%s\n' "$LIST_PROBE" | sed -n 6p)"
LIST_SECOND="$(printf '%s\n' "$LIST_PROBE" | sed -n 7p)"
if [ "$DRY" = "1" ]; then
  LIST_KEY="customField0"
  LIST_NAME="dry list field"
  LIST_VALUE="dry option"
  LIST_TYPE="Task"
  LIST_MULTI="0"
  LIST_REQUIRED="0"
  LIST_SECOND="dry second option"
fi
EXTRA_FIELD_ARGS=()
while IFS= read -r pair; do
  [ -z "$pair" ] && continue
  EXTRA_FIELD_ARGS+=(--field "$pair")
done < <(printf '%s\n' "$LIST_PROBE" | tail -n +8)

if [ -z "$LIST_NAME" ]; then
  echo "[smoke] project $PROJ_ID exposes no list custom field; list step skipped."
else
  # json_field interpolates its argument into an inline script, so the key
  # read off the instance is proven to be a bare customFieldN first.
  case "$LIST_KEY" in
    customField[0-9]*) ;;
    *)
      echo "smoke: '$LIST_KEY' is not a customFieldN key" >&2
      false
      ;;
  esac

  step "create a $LIST_TYPE setting list field '$LIST_NAME'"
  LIST_WP_JSON="$($BIN wp create "smoke list field" --project "$PROJ_ID" \
    --type "$LIST_TYPE" --field "$LIST_NAME=$LIST_VALUE" \
    ${EXTRA_FIELD_ARGS[@]+"${EXTRA_FIELD_ARGS[@]}"} --json)"
  LIST_WP_ID="$(printf '%s' "$LIST_WP_JSON" | json_field id)"
  # A single-valued field flattens to one {id,name}; a multi-valued one
  # to a list of them. The echo-back reads both shapes; in dry mode node
  # is shadowed, so the check runs live only.
  if [ "$DRY" != "1" ]; then
    printf '%s' "$LIST_WP_JSON" | node -e '
      const record = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const value = record[process.argv[1]];
      const want = process.argv[2];
      const names = Array.isArray(value)
        ? value.map((entry) => entry && entry.name)
        : [value && value.name];
      if (!names.includes(want)) {
        console.error("smoke: create echoed " + JSON.stringify(value)
          + " instead of " + JSON.stringify(want));
        process.exit(3);
      }
    ' "$LIST_KEY" "$LIST_VALUE"
  fi

  if [ "$LIST_REQUIRED" = "1" ]; then
    # A required field can never read blank, so clearing is refused by
    # design; moving it to another allowed option still proves the update
    # path writes the href form.
    if [ -n "$LIST_SECOND" ]; then
      step "move list field '$LIST_NAME' to '$LIST_SECOND' on work package $LIST_WP_ID"
      MOVED_JSON="$($BIN wp update "$LIST_WP_ID" --project "$PROJ_ID" \
        --field "$LIST_NAME=$LIST_SECOND" --json)"
      if [ "$DRY" != "1" ]; then
        printf '%s' "$MOVED_JSON" | node -e '
          const record = JSON.parse(require("fs").readFileSync(0, "utf8"));
          const value = record[process.argv[1]];
          const want = process.argv[2];
          const names = Array.isArray(value)
            ? value.map((entry) => entry && entry.name)
            : [value && value.name];
          if (!names.includes(want)) {
            console.error("smoke: update echoed " + JSON.stringify(value)
              + " instead of " + JSON.stringify(want));
            process.exit(3);
          }
        ' "$LIST_KEY" "$LIST_SECOND"
      fi
    fi
  else
    step "clear list field '$LIST_NAME' on work package $LIST_WP_ID"
    CLEARED_JSON="$($BIN wp update "$LIST_WP_ID" --project "$PROJ_ID" \
      --field "$LIST_NAME=" --json)"
    node -e '
      const record = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const raw = record[process.argv[1]];
      const entries = Array.isArray(raw) ? raw : [raw];
      const left = entries.filter((entry) =>
        entry !== null && entry !== undefined
        && (typeof entry !== "object"
          || (entry.id !== null && entry.id !== undefined)));
      if (left.length > 0) {
        console.error("smoke: clearing the list field left " + JSON.stringify(raw));
        process.exit(3);
      }
    ' "$LIST_KEY" <<<"$CLEARED_JSON"
  fi

  step "delete work package $LIST_WP_ID"
  $BIN wp delete "$LIST_WP_ID" --yes > /dev/null
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

# --- Time entry update ------------------------------------------------------
# comment is Formattable like a project description; the echo-back is the
# only way to see a payload the API accepts and then ignores.

step "update the comment of time entry $ENTRY_ID"
ENTRY_COMMENT="smoke comment **B**"
UPDATED_ENTRY_JSON="$($BIN time update "$ENTRY_ID" --comment "$ENTRY_COMMENT" --json)"
GOT_COMMENT="$(printf '%s' "$UPDATED_ENTRY_JSON" | json_field comment)"
if [ "$DRY" != "1" ] && [ "$GOT_COMMENT" != "$ENTRY_COMMENT" ]; then
  echo "smoke: time update echoed comment '$GOT_COMMENT' instead of '$ENTRY_COMMENT'" >&2
  false
fi

# --- Regression paths only reachable against a live API ---------------------
# time list --wp builds the entity_type/entity_id filter pair; --updated-after
# builds the <>d date-range operator. Mocked tests cover their shapes, but
# only a real instance proves OpenProject accepts them.

# --- Project scope (#19) ----------------------------------------------------
# An instance-wide listing also contains the scratch id, so only a total
# compared against the project's own collection can see a dropped scope.
# The comparison reads that collection with filters=[] on purpose: without
# an explicit filters parameter the endpoint applies its default open-status
# filter and the two totals stop being comparable.
#
# This is the one read in the gate that bypasses the CLI, and ADR-0001 is
# not in question: that decision governs what the CLI ships to callers, and
# an oracle routed through `wp count` would only ever agree with itself.
# The URL and the key are read from the environment, never passed as
# arguments, so the key stays out of the process list.

step "wp count --project $PROJ_ID matches the project's own work package total"
COUNTED="$($BIN wp count --project "$PROJ_ID")"
PROJECT_TOTAL="$(node -e '
  const [project] = process.argv.slice(1);
  const base = process.env.OPENPROJECT_URL ?? "";
  const key = process.env.OPENPROJECT_API_KEY ?? "";
  const url = base.replace(/\/+$/, "")
    + "/api/v3/projects/" + project + "/work_packages?pageSize=1&filters=%5B%5D";
  const auth = "Basic " + Buffer.from("apikey:" + key).toString("base64");
  fetch(url, { headers: { Authorization: auth } })
    .then((response) => {
      if (!response.ok) {
        throw new Error("HTTP " + String(response.status));
      }
      return response.json();
    })
    .then((body) => {
      if (typeof body.total !== "number") {
        throw new Error("the collection carried no total");
      }
      console.log(String(body.total));
    })
    .catch((error) => {
      console.error("smoke: could not read the project total: " + error.message);
      process.exit(3);
    });
' "$PROJ_ID")"
if [ "$DRY" != "1" ] && [ "$COUNTED" != "$PROJECT_TOTAL" ]; then
  echo "smoke: wp count --project $PROJ_ID reported '$COUNTED'," >&2
  echo "smoke: while the project itself holds '$PROJECT_TOTAL' work packages." >&2
  false
fi

step "time list --project $PROJ_ID --wp $WP_ID --from today (entity and project filters)"
TIME_ROWS="$($BIN time list --project "$PROJ_ID" --wp "$WP_ID" --from today --json)"
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
# 1d instead of today: the instance evaluates <>d in its own timezone,
# so when it trails the operator's a just-made update can still carry
# yesterday's stamp; the yesterday lower bound absorbs that skew. The
# upper bound is open (#24), so this step now fails if same-day updates
# drop out again.
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

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
#   OP_CLI_SMOKE_PROJECT  existing numeric project ID; creates only disposable
#                         work packages/time entries inside it, not a project
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
# Reject explicit but empty/invalid scope before any external request or write.
if [ "${OP_CLI_SMOKE_PROJECT+x}" = x ]; then
  if [[ ! "$OP_CLI_SMOKE_PROJECT" =~ ^[1-9][0-9]*$ ]]; then
    echo "smoke: OP_CLI_SMOKE_PROJECT must be a positive numeric project ID." >&2
    exit 2
  fi
fi
WP_ID=""
LIST_WP_ID=""
ENTRY_ID=""
DAY_ENTRY_ID=""
SMOKE_TMP=""
on_error() {
  echo "smoke: FAIL at step: ${CURRENT_STEP:-<unknown>}" >&2
  if [ -n "${OP_CLI_SMOKE_PROJECT:-}" ]; then
    echo "smoke: scoped run in existing project $OP_CLI_SMOKE_PROJECT; cleaning known created IDs." >&2
    echo "smoke: a timed-out creation can leave an unknown ID; inspect the project before retrying." >&2
  elif [ -n "${SCRATCH_IDENT:-}" ]; then
    echo "smoke: leftover scratch project '${SCRATCH_IDENT}' (id ${PROJ_ID:-?}); remove it via the web UI." >&2
  fi
}
trap on_error ERR

cleanup_scoped() {
  local original=$?
  local cleanup_failed=0
  trap - ERR EXIT
  if [ -n "$SMOKE_TMP" ]; then rm -rf "$SMOKE_TMP"; fi
  if [ -n "${OP_CLI_SMOKE_PROJECT:-}" ] && [ "$DRY" != "1" ]; then
    # These variables are populated only from this run's creation responses.
    # Never delete by subject, search result, or IDs supplied by the caller.
    for id in "$DAY_ENTRY_ID" "$ENTRY_ID"; do
      if [[ "$id" =~ ^[1-9][0-9]*$ ]]; then
        if ! $BIN time delete "$id" --yes > /dev/null; then
          echo "smoke: cleanup failed for created time entry $id" >&2
          cleanup_failed=1
        fi
      fi
    done
    for id in "$LIST_WP_ID" "$WP_ID"; do
      if [[ "$id" =~ ^[1-9][0-9]*$ ]]; then
        if ! $BIN wp delete "$id" --yes > /dev/null; then
          echo "smoke: cleanup failed for created work package $id" >&2
          cleanup_failed=1
        fi
      fi
    done
  fi
  if [ "$original" != "0" ]; then exit "$original"; fi
  exit "$cleanup_failed"
}
trap cleanup_scoped EXIT

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
    # json_field pipes a record into `node -e`. The shadow must drain that
    # pipe: under `pipefail` an unread stdin is SIGPIPE (141), and the race
    # is what made the unscoped dry gate fail in CI.
    cat >/dev/null || true
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

wp_writable() {
  # True when the disposable work package's schema lists FIELD as writable.
  # Reads $SCHEMA_JSON; the dry shadow of node always answers yes, so every
  # optional step still walks through in a dry run.
  printf '%s' "$SCHEMA_JSON" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const field = process.argv[1];
    process.exit(Array.isArray(rows)
      && rows.some((row) => row.field === field && row.writable === true) ? 0 : 1);
  ' "$1"
}

wp_expect() {
  # wp_expect <path> <want> [<path> <want>]...: read the work package back
  # with `wp get --json` and fail unless every dotted path reads as wanted.
  # A {id,name} link or a list of them compares by name, "" means empty, "*"
  # any non-empty value, and "a|b" accepts either spelling. The failure
  # message names the path; the step name is already printed by the trap.
  # The paths and wanted values are argv, never interpolated into the script.
  $BIN wp get "$WP_ID" --json | node -e '
    const data = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const text = (entry) => {
      if (entry === null || entry === undefined) return "";
      if (typeof entry === "object") return entry.name === null || entry.name === undefined ? "" : String(entry.name);
      return String(entry);
    };
    const args = process.argv.slice(1);
    for (let i = 0; i < args.length; i += 2) {
      let value = data;
      for (const step of args[i].split(".")) {
        value = value === null || typeof value !== "object" ? undefined : value[step];
      }
      const got = Array.isArray(value) ? value.map(text).filter((s) => s !== "").join(",") : text(value);
      const want = args[i + 1];
      const ok = want === "*" ? got !== "" : want.split("|").includes(got);
      if (!ok) {
        console.error("smoke: wp get reads " + args[i] + " = " + JSON.stringify(got) + " instead of " + JSON.stringify(want));
        process.exit(3);
      }
    }
  ' "$@" || return $?
  # The explicit return hands the failure to the caller, where the ERR
  # trap that names the step is armed; a function would otherwise exit
  # under set -e without the trap seeing it.
}

vocab_first() {
  # First entry name of a project vocabulary (meta versions|sprints|buckets),
  # empty when the instance does not expose it to this account or the
  # project has none; an open version is preferred. The optional steps skip
  # on an empty answer.
  local json
  if ! json="$($BIN meta "$1" --project "$PROJ_ID" --json 2> /dev/null)"; then
    return 0
  fi
  node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!Array.isArray(rows)) process.exit(0);
    const open = rows.find((row) => row && row.status === "open");
    const row = open ?? rows[0];
    if (row && typeof row.name === "string") console.log(row.name);
  ' <<<"$json"
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

# --- Project create or explicit existing-project scope ----------------------

if [ -n "${OP_CLI_SMOKE_PROJECT:-}" ]; then
  step "verify existing project $OP_CLI_SMOKE_PROJECT (no project-level writes)"
  PROJ_JSON="$($BIN project get "$OP_CLI_SMOKE_PROJECT" --json)"
  PROJ_ID="$(printf '%s' "$PROJ_JSON" | json_field id)"
  if [ "$DRY" = "1" ]; then PROJ_ID="$OP_CLI_SMOKE_PROJECT"; fi
  if [ "$PROJ_ID" != "$OP_CLI_SMOKE_PROJECT" ]; then
    echo "smoke: project identity mismatch; refusing writes." >&2
    exit 2
  fi
else
step "create scratch project '$SCRATCH_IDENT' with a description"
PROJ_DESC="smoke description **A**"
PROJ_JSON="$($BIN project create "op-cli smoke $STAMP" --identifier "$SCRATCH_IDENT" \
  --description "$PROJ_DESC" --json)"
PROJ_ID="$(printf '%s' "$PROJ_JSON" | json_field id)"
if [ "$DRY" = "1" ]; then PROJ_ID="1"; fi
# description is Formattable: a plain-string payload is accepted, ignored,
# and reported as success, so only an echo-back can see the difference.
GOT_DESC="$(printf '%s' "$PROJ_JSON" | json_field description.raw)"
if [ "$DRY" != "1" ] && [ "$GOT_DESC" != "$PROJ_DESC" ]; then
  echo "smoke: project create echoed description '$GOT_DESC' instead of '$PROJ_DESC'" >&2
  false
fi

fi

# --- Work package create ----------------------------------------------------

step "create work package in project $PROJ_ID"
# description is Formattable here exactly as on the project: only the
# echo-back can see a payload the API accepts and then ignores (#22).
WP_DESC="smoke description **WP**"
WP_JSON="$($BIN wp create "smoke subject A" --project "$PROJ_ID" --type Task \
  --description "$WP_DESC" --json)"
WP_ID="$(printf '%s' "$WP_JSON" | json_field id)"
if [ "$DRY" != "1" ]; then
  GOT_WP_DESC="$(printf '%s' "$WP_JSON" | json_field description.raw)"
  [ "$GOT_WP_DESC" = "$WP_DESC" ]
fi

# --- Work package update ----------------------------------------------------

step "update work package $WP_ID"
UPDATED_JSON="$($BIN wp update "$WP_ID" --subject "smoke subject B" \
  --description "smoke description **WP2**" --json)"
GOT_SUBJECT="$(printf '%s' "$UPDATED_JSON" | json_field subject)"
if [ "$DRY" != "1" ] && [ "$GOT_SUBJECT" != "smoke subject B" ]; then
  echo "smoke: update echoed subject '$GOT_SUBJECT' instead of 'smoke subject B'" >&2
  false
fi
if [ "$DRY" != "1" ]; then
  GOT_UPDATED_DESC="$(printf '%s' "$UPDATED_JSON" | json_field description.raw)"
  [ "$GOT_UPDATED_DESC" = "smoke description **WP2**" ]
fi

step "add a comment to work package $WP_ID and read it back"
COMMENT_TEXT="smoke comment **C**"
$BIN wp comment "$WP_ID" "$COMMENT_TEXT" > /dev/null
COMMENTS_JSON="$($BIN wp comments "$WP_ID" --json)"
if [ "$DRY" != "1" ]; then
  printf '%s' "$COMMENTS_JSON" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const want = process.argv[1];
    if (!Array.isArray(rows) || !rows.some((row) => row.comment === want)) {
      console.error("smoke: reading the comments back found none equal to " + JSON.stringify(want));
      process.exit(3);
    }
  ' "$COMMENT_TEXT"
fi

# --- Write paths of #43-#49 -------------------------------------------------
# Every step writes with `wp update`, then reads the record back with
# `wp get --json` (wp_expect): an accepted-then-ignored payload only shows on
# the read. Which fields exist is instance configuration, so each optional
# step probes first (wp schema, meta versions|sprints|buckets) and prints a
# "skip:" line instead of failing. The disposable work package is deleted at
# teardown whatever is set on it, so nothing here needs its own cleanup.

step "probe the writable fields of work package $WP_ID"
SCHEMA_JSON="$($BIN wp schema "$WP_ID" --json)"

step "edit the comment on work package $WP_ID and read it back"
COMMENT_EDITED="smoke comment **C2**"
ACTIVITY_ID="$(printf '%s' "$COMMENTS_JSON" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const row = Array.isArray(rows) ? rows.find((r) => r.comment === process.argv[1]) : undefined;
  if (!row || row.id === undefined || row.id === null) {
    console.error("smoke: no activity carries the comment just posted");
    process.exit(3);
  }
  console.log(String(row.id));
' "$COMMENT_TEXT")"
$BIN wp comment-edit "$ACTIVITY_ID" "$COMMENT_EDITED" > /dev/null
EDITED_JSON="$($BIN wp comments "$WP_ID" --json)"
if [ "$DRY" != "1" ]; then
  printf '%s' "$EDITED_JSON" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const want = process.argv[1];
    if (!Array.isArray(rows) || !rows.some((row) => row.comment === want)) {
      console.error("smoke: reading the comments back found none equal to " + JSON.stringify(want));
      process.exit(3);
    }
  ' "$COMMENT_EDITED"
fi

step "watch and unwatch work package $WP_ID (default: me)"
$BIN wp watch "$WP_ID" > /dev/null
WATCHERS_JSON="$($BIN wp watchers "$WP_ID" --json)"
if [ "$DRY" != "1" ]; then
  printf '%s' "$WATCHERS_JSON" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!Array.isArray(rows) || rows.length === 0) {
      console.error("smoke: wp watch left the watcher list empty");
      process.exit(3);
    }
  '
fi
$BIN wp unwatch "$WP_ID" > /dev/null
UNWATCHED_JSON="$($BIN wp watchers "$WP_ID" --json)"
if [ "$DRY" != "1" ]; then
  printf '%s' "$UNWATCHED_JSON" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!Array.isArray(rows) || rows.length !== 0) {
      console.error("smoke: wp unwatch left " + JSON.stringify(rows) + " in the watcher list");
      process.exit(3);
    }
  '
fi

# The attachment dies with the work package at teardown (the API offers no
# attachment delete on this surface); only the local temp directory needs
# its own cleanup, which the EXIT trap does.
step "attach a small file to work package $WP_ID and download it back"
SMOKE_TMP="$(mktemp -d)"
ATTACH_SRC="$SMOKE_TMP/up.txt"
ATTACH_DST="$SMOKE_TMP/down.txt"
printf 'smoke attachment %s\n' "$STAMP" > "$ATTACH_SRC"
ATTACH_JSON="$($BIN wp attach "$WP_ID" "$ATTACH_SRC" --name "smoke-$STAMP.txt" \
  --description "smoke attachment" --json)"
ATTACH_ID="$(printf '%s' "$ATTACH_JSON" | json_field id)"
ATTACHMENTS_JSON="$($BIN wp attachments "$WP_ID" --json)"
$BIN wp attachment-download "$ATTACH_ID" --output "$ATTACH_DST" > /dev/null
if [ "$DRY" != "1" ]; then
  printf '%s' "$ATTACHMENTS_JSON" | node -e '
    const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
    if (!Array.isArray(rows) || !rows.some((row) => String(row.id) === process.argv[1])) {
      console.error("smoke: wp attachments missed the attachment " + process.argv[1]);
      process.exit(3);
    }
  ' "$ATTACH_ID"
  if ! cmp -s "$ATTACH_SRC" "$ATTACH_DST"; then
    echo "smoke: the downloaded attachment differs from the uploaded file" >&2
    false
  fi
fi

# Internal comments need the instance's internal_comments feature and the
# permission to write them; a rejection is a skip, not a failure.
INTERNAL_TEXT="smoke internal **I**"
if $BIN wp comment "$WP_ID" "$INTERNAL_TEXT" --internal --json > /dev/null 2>&1; then
  step "read the internal comment on work package $WP_ID back flagged internal"
  INTERNAL_JSON="$($BIN wp comments "$WP_ID" --json)"
  if [ "$DRY" != "1" ]; then
    printf '%s' "$INTERNAL_JSON" | node -e '
      const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const want = process.argv[1];
      if (!Array.isArray(rows) || !rows.some((r) => r.comment === want && r.internal === true)) {
        console.error("smoke: no comment equal to " + JSON.stringify(want) + " reads back as internal");
        process.exit(3);
      }
    ' "$INTERNAL_TEXT"
  fi
else
  echo "[smoke] skip: the instance rejected an internal comment on work package $WP_ID; internal comment step skipped."
fi

if wp_writable startDate && wp_writable dueDate; then
  step "set, then clear, start and due dates on work package $WP_ID"
  $BIN wp update "$WP_ID" --start 2030-01-07 --due 2030-01-11 --json > /dev/null
  wp_expect startDate 2030-01-07 dueDate 2030-01-11
  $BIN wp update "$WP_ID" --start "" --due "" --json > /dev/null
  wp_expect startDate "" dueDate ""
else
  echo "[smoke] skip: startDate/dueDate are not writable on work package $WP_ID; dates step skipped."
fi

if wp_writable estimatedTime && wp_writable remainingTime; then
  step "set, then clear, estimate and remaining work on work package $WP_ID"
  $BIN wp update "$WP_ID" --estimate 4h --remaining 2h --json > /dev/null
  wp_expect estimatedTime PT4H remainingTime PT2H
  $BIN wp update "$WP_ID" --estimate "" --remaining "" --json > /dev/null
  wp_expect estimatedTime "" remainingTime ""
else
  echo "[smoke] skip: estimatedTime/remainingTime are not writable on work package $WP_ID; estimate step skipped."
fi

if wp_writable percentageDone; then
  step "set, then clear, percent complete on work package $WP_ID"
  $BIN wp update "$WP_ID" --done 50 --json > /dev/null
  wp_expect percentageDone 50
  $BIN wp update "$WP_ID" --done "" --json > /dev/null
  wp_expect percentageDone "|0"
else
  echo "[smoke] skip: percentageDone is not writable (derived from status); percent complete step skipped."
fi

if wp_writable storyPoints; then
  step "set, then clear, story points on work package $WP_ID"
  $BIN wp update "$WP_ID" --story-points 3 --json > /dev/null
  wp_expect storyPoints 3
  $BIN wp update "$WP_ID" --story-points "" --json > /dev/null
  wp_expect storyPoints ""
else
  echo "[smoke] skip: storyPoints is not in the schema of work package $WP_ID; story points step skipped."
fi

if wp_writable responsible; then
  step "set, then clear, the accountable of work package $WP_ID"
  $BIN wp update "$WP_ID" --accountable me --json > /dev/null
  wp_expect responsible "*"
  $BIN wp update "$WP_ID" --accountable "" --json > /dev/null
  wp_expect responsible ""
else
  echo "[smoke] skip: responsible (accountable) is not writable on work package $WP_ID; accountable step skipped."
fi

VERSION_NAME="$(vocab_first versions)"
if [ "$DRY" = "1" ]; then VERSION_NAME="dry version"; fi
if [ -z "$VERSION_NAME" ]; then
  echo "[smoke] skip: project $PROJ_ID has no versions visible to this account; version steps skipped."
else
  if wp_writable version || wp_writable targetVersions; then
    step "set, then clear, version '$VERSION_NAME' (targetVersions) on work package $WP_ID"
    $BIN wp update "$WP_ID" --version "$VERSION_NAME" --project "$PROJ_ID" --json > /dev/null
    wp_expect version "$VERSION_NAME" targetVersions "$VERSION_NAME"
    $BIN wp update "$WP_ID" --version "" --project "$PROJ_ID" --json > /dev/null
    wp_expect version "" targetVersions ""
  else
    echo "[smoke] skip: version is not writable on work package $WP_ID; version step skipped."
  fi
  if wp_writable observedInVersions; then
    step "set, then clear, observed-in '$VERSION_NAME' on work package $WP_ID"
    $BIN wp update "$WP_ID" --observed-in "$VERSION_NAME" --project "$PROJ_ID" --json > /dev/null
    wp_expect observedInVersions "$VERSION_NAME"
    $BIN wp update "$WP_ID" --observed-in "" --project "$PROJ_ID" --json > /dev/null
    wp_expect observedInVersions ""
  else
    echo "[smoke] skip: observedInVersions is not writable on work package $WP_ID; observed-in step skipped."
  fi
fi

# A work package sits in a sprint or a backlog bucket, never both: moving
# between them is clear-then-set, and the placement is empty in between.
SPRINT_NAME="$(vocab_first sprints)"
BUCKET_NAME="$(vocab_first buckets)"
if [ "$DRY" = "1" ]; then
  SPRINT_NAME="dry sprint"
  BUCKET_NAME="dry bucket"
fi
if [ -n "$SPRINT_NAME" ] && ! wp_writable sprint; then SPRINT_NAME=""; fi
if [ -n "$BUCKET_NAME" ] && ! wp_writable backlogBucket; then BUCKET_NAME=""; fi
if [ -z "$SPRINT_NAME" ] && [ -z "$BUCKET_NAME" ]; then
  echo "[smoke] skip: project $PROJ_ID has no usable sprints or buckets; placement steps skipped."
fi
if [ -n "$SPRINT_NAME" ]; then
  step "place work package $WP_ID in sprint '$SPRINT_NAME'"
  $BIN wp update "$WP_ID" --sprint "$SPRINT_NAME" --project "$PROJ_ID" --json > /dev/null
  wp_expect sprint "$SPRINT_NAME"
  if [ -z "$BUCKET_NAME" ]; then
    step "clear the sprint of work package $WP_ID"
    $BIN wp update "$WP_ID" --sprint "" --project "$PROJ_ID" --json > /dev/null
    wp_expect sprint ""
  fi
fi
if [ -n "$BUCKET_NAME" ]; then
  if [ -n "$SPRINT_NAME" ]; then
    step "move work package $WP_ID from the sprint to bucket '$BUCKET_NAME' (clear, then set)"
    $BIN wp update "$WP_ID" --sprint "" --project "$PROJ_ID" --json > /dev/null
    wp_expect sprint ""
  else
    step "place work package $WP_ID in bucket '$BUCKET_NAME'"
  fi
  $BIN wp update "$WP_ID" --bucket "$BUCKET_NAME" --project "$PROJ_ID" --json > /dev/null
  wp_expect backlogBucket "$BUCKET_NAME" sprint ""
  step "clear the bucket of work package $WP_ID"
  $BIN wp update "$WP_ID" --bucket "" --project "$PROJ_ID" --json > /dev/null
  wp_expect backlogBucket ""
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
  LIST_WP_ID=""
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

step "wp list --updated-after today on project $PROJ_ID returns the fresh update"
# The server evaluates <>d in its own timezone, so when the instance's
# clock trails this host's a write stamped moments ago can land on the
# instance's yesterday. One refresh re-stamps the record; only a second
# miss fails, which keeps the oracle strict about dropped same-day
# updates (#24) without letting timezone skew flake the gate.
TODAY_ROWS="$($BIN wp list --project "$PROJ_ID" --updated-after today --json)"
if ! printf '%s' "$TODAY_ROWS" | node -e '
  const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
  const id = Number(process.argv[1]);
  process.exit(Array.isArray(rows) && rows.some((r) => r.id === id) ? 0 : 3);
' "$WP_ID" 2> /dev/null; then
  if [ "$DRY" != "1" ]; then
    $BIN wp update "$WP_ID" --subject "smoke subject C" --json > /dev/null
    TODAY_ROWS="$($BIN wp list --project "$PROJ_ID" --updated-after today --json)"
    printf '%s' "$TODAY_ROWS" | node -e '
      const rows = JSON.parse(require("fs").readFileSync(0, "utf8"));
      const id = Number(process.argv[1]);
      if (!Array.isArray(rows) || !rows.some((r) => r.id === id)) {
        console.error("smoke: wp list --updated-after today missed work package " + id);
        process.exit(3);
      }
    ' "$WP_ID"
  fi
fi

step "wp list --all --json on project $PROJ_ID streams one JSON record per line"
NDJSON="$($BIN wp list --project "$PROJ_ID" --all --json)"
if [ "$DRY" != "1" ]; then
  printf '%s\n' "$NDJSON" | node -e '
    const lines = require("fs").readFileSync(0, "utf8").trimEnd().split("\n");
    if (lines.length === 0 || lines[0] === "") {
      console.error("smoke: --all --json produced no records");
      process.exit(3);
    }
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        console.error("smoke: --all --json emitted a line that is not JSON");
        process.exit(3);
      }
      if (record === null || typeof record !== "object" || Array.isArray(record)
          || typeof record.id !== "number") {
        console.error("smoke: --all --json emitted a line that is not one flat record");
        process.exit(3);
      }
    }
  '
fi

if [ -z "${OP_CLI_SMOKE_PROJECT:-}" ]; then
  step "star and unstar project $PROJ_ID (favourite endpoints)"
  $BIN project star "$PROJ_ID" > /dev/null
  $BIN project unstar "$PROJ_ID" > /dev/null
fi

# --- Teardown ---------------------------------------------------------------

step "delete time entry $ENTRY_ID"
$BIN time delete "$ENTRY_ID" --yes > /dev/null
ENTRY_ID=""

step "delete time entry $DAY_ENTRY_ID"
$BIN time delete "$DAY_ENTRY_ID" --yes > /dev/null
DAY_ENTRY_ID=""

step "delete work package $WP_ID"
$BIN wp delete "$WP_ID" --yes > /dev/null
WP_ID=""

trap - ERR
if [ "$DRY" = "1" ]; then
  echo "[smoke] PASS: dry simulation coherent, nothing was executed or written."
elif [ -n "${OP_CLI_SMOKE_PROJECT:-}" ]; then
  echo "[smoke] PASS: scoped lifecycle succeeded in existing project $PROJ_ID; created records removed."
  echo "smoke: project creation, project description writes and favourites were not exercised."
else
  echo "[smoke] PASS: full lifecycle succeeded."
  echo "smoke: leftover scratch project '$SCRATCH_IDENT' (id $PROJ_ID); remove it via the web UI."
fi

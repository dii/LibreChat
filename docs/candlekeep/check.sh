#!/usr/bin/env bash
# Pre-deploy checks for the Candlekeep fork, run the way upstream's own CI runs them.
#
# WHY THIS EXISTS, and it is not "we should have more tests".
#
# On 2026-08-08 a build shipped to production that crash-looped, and the review
# note at the time said "nothing local could have caught it". That was wrong, and
# the cost of believing it was an outage plus a week of assuming the local
# feedback loop was broken. Measured 2026-08-14:
#
#   export const X = 30 * 60 * 1000        (no type annotation)
#     npx tsc --noEmit   -> exit 0   PASSES. Does not model isolatedDeclarations.
#     npm run build:api  -> exit 1   TS9010, names the file and line, ~2 seconds.
#
# `packages/api` is bundled by tsdown/rolldown with --isolatedDeclarations, which
# is a stricter contract than the type checker's. Only the real build enforces it,
# so THE BUILD IS THE TEST, and it is the step this script exists to make routine.
#
# The second belief this corrects: the bundle is not unbuildable here. It cannot
# be built by the `dii` user directly, because node_modules and packages/api/dist
# are root-owned from a container run in July, and gorion has no local node. It
# builds fine in a container in about two seconds. Everything below therefore runs
# in docker, pinned to the same Node upstream CI pins (24.16.0).
#
# WHICH NODE IMAGE, and why it is not the one production runs.
#
# The deploy image is `node:24.16.0-alpine` (see the repo Dockerfile). This script
# uses the glibc image instead, matching what upstream's own CI runs on, for one
# concrete reason: `mongodb-memory-server` downloads a real mongod binary, mongod
# is built against glibc, and on musl it cannot start at all. Measured 2026-08-14:
# on alpine, 276 test failures across 92 of 184 suites in the `api` workspace came
# from `MongoMemoryServer.create()` alone. That is not a baseline, it is a blindfold,
# and this fork's own upcoming work (a Folder collection with ownership rules) is
# exactly the kind that must be tested against a real database rather than a mock,
# per the repo's own testing policy.
#
# The trade is explicit: this checks types, contracts and behaviour, and it does
# NOT prove the alpine image links. The real alpine build still happens on alaundo
# and is still verified there before deployment, which the custom-image runbook
# covers. Bundle output is platform-independent JavaScript, so the
# isolatedDeclarations gate is unaffected by the base image.
#
# Usage:
#   ./check.sh build              the three package builds (the isolatedDeclarations gate)
#   ./check.sh test [ws] [pat]    jest for a workspace, compared against the known-failure baseline
#   ./check.sh lint [paths...]    eslint
#   ./check.sh all                everything; this is the pre-build gate
#   ./check.sh baseline [ws]      re-record the known-failure baseline (deliberate act, see below)
#
# Workspaces: api | packages/api | packages/data-provider | packages/data-schemas | client

set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NODE_IMAGE="node:24.16.0"
BASELINE_DIR="${REPO}/docs/candlekeep/test-baselines"

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

# --security-opt label=disable is required on this SELinux host or every mounted
# read fails with EACCES; it is the same flag the custom-image runbook uses.
in_node() {
  docker run --rm --security-opt label=disable -v "${REPO}:/app" -w "/app${1:+/$1}" \
    "${NODE_IMAGE}" sh -c "$2"
}

cmd_build() {
  bold "== build (data-provider, data-schemas, api) =="
  echo "   the api build is the isolatedDeclarations gate; tsc --noEmit does NOT cover it"
  if in_node "" 'npm run build:data-provider && npm run build:data-schemas && npm run build:api' \
      > /tmp/candlekeep-build.log 2>&1; then
    green "   build OK"
    return 0
  fi
  red "   BUILD FAILED"
  grep -E "TS[0-9]{4}|ERROR|error" /tmp/candlekeep-build.log | head -20
  echo "   full log: /tmp/candlekeep-build.log"
  return 1
}

# Jest reports failures against a moving target here: packages/api carries a set
# of suites that fail on a clean tree, and SOME OF THEM ARE FLAKY. On 2026-08-07 a
# single run reported 13 failed suites / 202 failed tests against a 12/121
# baseline, which read as an 81-test regression that did not exist; re-running gave
# 12/121 with the new work passing. So a raw count is not evidence. This compares
# the SET of failing suites against a recorded baseline and reports only what is
# new, which is the part that can actually be caused by your change.
cmd_test() {
  local ws="${1:-packages/api}" pattern="${2:-}"
  local baseline="${BASELINE_DIR}/$(echo "$ws" | tr '/' '-').txt"
  bold "== test ${ws} ${pattern} =="

  # Use the workspace's OWN test:ci script, not bare jest. packages/api's test:ci
  # excludes integration suites (`--testPathIgnorePatterns` for integration,
  # helper and manual specs) because those need Redis and Mongo, which upstream
  # runs in separate CI workflows with services attached. Invoking bare jest here
  # produced a 36-suite "baseline" of infrastructure failures that had nothing to
  # do with any change, which would have buried a real regression in noise.
  local jest_cmd
  if [[ -n "$pattern" ]]; then
    jest_cmd="npm run test:ci -- --silent ${pattern}"
  else
    jest_cmd="npm run test:ci -- --silent"
  fi
  in_node "$ws" "$jest_cmd" > /tmp/candlekeep-test.log 2>&1
  local status=$?

  grep -oE "^(FAIL) +[^ ]+" /tmp/candlekeep-test.log | awk '{print $2}' | sort -u \
    > /tmp/candlekeep-failing.txt
  local failing_now
  failing_now=$(wc -l < /tmp/candlekeep-failing.txt)

  if [[ ! -f "$baseline" ]]; then
    echo "   no baseline for ${ws} (${failing_now} failing suites)"
    echo "   record one with: ./check.sh baseline ${ws}"
    tail -5 /tmp/candlekeep-test.log
    return $status
  fi

  local new_failures
  new_failures=$(comm -23 /tmp/candlekeep-failing.txt <(sort -u "$baseline") || true)

  grep -E "^(Tests|Test Suites):" /tmp/candlekeep-test.log | sed 's/^/   /'

  # Only meaningful on a full run. Under a pattern filter the baseline suites were
  # never executed, so reporting them as "passed" would be a plain lie — and the
  # first version of this script told exactly that lie.
  if [[ -z "$pattern" ]]; then
    local fixed
    fixed=$(comm -13 /tmp/candlekeep-failing.txt <(sort -u "$baseline") || true)
    [[ -n "$fixed" ]] && { echo "   baseline suites that passed this run (flaky or fixed):";
                           echo "$fixed" | sed 's/^/     ~ /'; }
  fi

  if [[ -n "$new_failures" ]]; then
    red "   NEW failing suites, not in the baseline — these are yours:"
    echo "$new_failures" | sed 's/^/     + /'
    echo "   full log: /tmp/candlekeep-test.log"
    return 1
  fi
  green "   no new failures against the baseline"
  return 0
}

# Re-recording the baseline is deliberate and should be a reviewed commit: it is
# the line between "known broken on a clean tree" and "broken by us". Never run it
# to make a red run green.
cmd_baseline() {
  local ws="${1:-packages/api}"
  local baseline="${BASELINE_DIR}/$(echo "$ws" | tr '/' '-').txt"
  bold "== recording baseline for ${ws} =="
  mkdir -p "$BASELINE_DIR"
  in_node "$ws" "npm run test:ci -- --silent" > /tmp/candlekeep-test.log 2>&1
  grep -oE "^(FAIL) +[^ ]+" /tmp/candlekeep-test.log | awk '{print $2}' | sort -u > "$baseline"
  echo "   $(wc -l < "$baseline") failing suite(s) recorded in ${baseline#"$REPO"/}"
  cat "$baseline" | sed 's/^/     /'
  grep -E "^(Tests|Test Suites):" /tmp/candlekeep-test.log | sed 's/^/   /'
}

cmd_lint() {
  bold "== lint =="
  local targets="${*:-}"
  if [[ -z "$targets" ]]; then
    targets=$(cd "$REPO" && git diff --name-only HEAD -- '*.ts' '*.tsx' '*.js' '*.jsx' | tr '\n' ' ')
    [[ -z "$targets" ]] && { echo "   no changed lintable files"; return 0; }
    echo "   changed files: ${targets}"
  fi
  if in_node "" "npx eslint ${targets}" > /tmp/candlekeep-lint.log 2>&1; then
    green "   lint OK"
    return 0
  fi
  red "   LINT FAILED"
  tail -25 /tmp/candlekeep-lint.log
  return 1
}

cmd_all() {
  local failed=0
  cmd_build || failed=1
  # Run the fork's own surfaces. Client tests are slow and unaffected by most of
  # this fork's work, so they are opt-in rather than part of the gate.
  cmd_test "packages/api" || failed=1
  cmd_test "api" || failed=1
  cmd_lint || failed=1
  echo
  if [[ $failed -eq 0 ]]; then
    green "ALL CHECKS PASSED — safe to build the image"
  else
    red "CHECKS FAILED — do not build the image from this tree"
  fi
  return $failed
}

case "${1:-all}" in
  build)    cmd_build ;;
  test)     shift; cmd_test "${1:-packages/api}" "${2:-}" ;;
  baseline) shift; cmd_baseline "${1:-packages/api}" ;;
  lint)     shift; cmd_lint "$@" ;;
  all)      cmd_all ;;
  *)        sed -n '/^# Usage:/,/^# Workspaces/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac

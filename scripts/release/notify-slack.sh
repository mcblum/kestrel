#!/bin/sh
# Posts "a release is ready to start" to Slack, from CI, once the Windows and Linux builds of a
# new version are made: the version, the commit, and a link straight to the waiting `release` job,
# whose play button builds the Mac app and publishes all three (RELEASING.md).
#
#   scripts/release/notify-slack.sh            post it
#   scripts/release/notify-slack.sh --print    print the message instead (no webhook needed)
#
# Environment:
#   KESTREL_SLACK_WEBHOOK_URL  a Slack incoming webhook (a CI variable, masked). Without it nothing
#                              is posted and the job says so: the release can still be started
#                              from the pipeline page.
#   KESTREL_SLACK_MENTION      optional: who to tag, as Slack writes a mention (<@MEMBERID>)
#   and GitLab's own CI_* variables.
# Needs curl and jq.
set -eu
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
RELEASE_JOB="${KESTREL_RELEASE_JOB:-release}"
print=0
[ "${1:-}" = "--print" ] && print=1

version="$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$ROOT/app/package.json" | head -1)"
[ -n "$version" ] || { echo "!! notify-slack: app/package.json has no version" >&2; exit 1; }
mention="${KESTREL_SLACK_MENTION:-}"
commit_url="${CI_PROJECT_URL:-}/-/commit/${CI_COMMIT_SHA:-}"

# The waiting job's own page; the pipeline page, which shows the same play button, when it cannot be found.
jobs='[]'
if [ -n "${CI_JOB_TOKEN:-}" ]; then
  jobs="$(curl -sf -H "JOB-TOKEN: $CI_JOB_TOKEN" "$CI_API_V4_URL/projects/$CI_PROJECT_ID/pipelines/$CI_PIPELINE_ID/jobs?per_page=100&include_retried=false" || echo '[]')"
fi
release_url="$(printf '%s' "$jobs" | jq -r --arg name "$RELEASE_JOB" --arg fallback "${CI_PIPELINE_URL:-}" '(if type == "array" then map(select(.name == $name)) else [] end) | first.web_url // $fallback')"

payload="$(jq -n \
  --arg version "$version" --arg mention "$mention" --arg title "${CI_COMMIT_TITLE:-}" --arg short "${CI_COMMIT_SHORT_SHA:-}" \
  --arg commit_url "$commit_url" --arg release_url "$release_url" --arg pipeline_url "${CI_PIPELINE_URL:-}" '
  def esc: gsub("&"; "&amp;") | gsub("<"; "&lt;") | gsub(">"; "&gt;");
  ($mention | if . == "" then "" else . + " " end) as $who
  | {
      text: "\($who)Kestrel \($version) is ready to release",
      blocks: [
        {type: "header", text: {type: "plain_text", text: "Kestrel \($version) is ready to release"}},
        {type: "section", text: {type: "mrkdwn",
          text: "\($who)<\($commit_url)|\($short)> \($title | esc)\nThe Windows installer and the Linux AppImage are built. Starting the release builds and notarizes the Mac app and publishes all three."}},
        {type: "section", text: {type: "mrkdwn",
          text: "<\($release_url)|Start the release> · <\($pipeline_url)|See the pipeline>"}}
      ]
    }')"

if [ "$print" = 1 ]; then
  printf '%s\n' "$payload"
  exit 0
fi
if [ -z "${KESTREL_SLACK_WEBHOOK_URL:-}" ]; then
  echo "No KESTREL_SLACK_WEBHOOK_URL (Settings → CI/CD → Variables): nothing posted. Start the release here: $release_url"
  exit 0
fi
printf '%s' "$payload" | curl -sSf -X POST -H 'Content-Type: application/json' --data-binary @- "$KESTREL_SLACK_WEBHOOK_URL" >/dev/null
echo "Posted to Slack: Kestrel $version is ready to release ($release_url)"

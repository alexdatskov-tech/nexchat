#!/usr/bin/env bash
# NexChat bot helpers for shell scripts. Needs curl only (no jq).
#
#   source nexchat.sh
#   nx_login "$BASE" robo_helper "$PASSWORD"     # sets NX_TOKEN
#   nx_send  "$BASE" <channel-id> "hello"
#   nx_messages "$BASE" <channel-id> 20
#
# BASE is the bot-api function URL, e.g. https://<project>.supabase.co/functions/v1/bot-api

nx_login() {
  local base="$1" user="$2" pass="$3" body
  body=$(printf '{"username":"%s","password":"%s"}' "$user" "$pass")
  NX_TOKEN=$(curl -sS -X POST "$base/v1/auth/login" -H 'content-type: application/json' -d "$body" \
    | sed -n 's/.*"access_token":"\([^"]*\)".*/\1/p')
  [ -n "$NX_TOKEN" ] || { echo "login failed" >&2; return 1; }
  export NX_TOKEN
}

nx_send() {
  local base="$1" channel="$2" text="$3" body
  body=$(printf '{"content":"%s"}' "${text//\"/\\\"}")
  curl -sS -X POST "$base/v1/channels/$channel/messages" \
    -H "authorization: Bearer $NX_TOKEN" -H 'content-type: application/json' -d "$body"
  echo
}

nx_messages() {
  curl -sS "$1/v1/channels/$2/messages?limit=${3:-50}" -H "authorization: Bearer $NX_TOKEN"
  echo
}

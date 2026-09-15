#!/bin/sh
set -eu

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not configured}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not configured}"

api_base="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
auth_header="Authorization: Bearer $CLOUDFLARE_API_TOKEN"
response_file=$(mktemp)
trap 'rm -f "$response_file"' EXIT

if ! curl --fail-with-body --silent --show-error \
		--connect-timeout 10 --max-time 30 \
		--header "$auth_header" "$api_base" \
		--output "$response_file"; then
	echo "Unable to list Cloudflare D1 databases" >&2
	exit 1
fi
if ! jq --exit-status '.success == true' "$response_file" >/dev/null; then
	echo "Cloudflare rejected the D1 database list request" >&2
	exit 1
fi

database_id=$(jq --raw-output '[.result[] | select(.name == "brainwaves_db") | .uuid][0] // empty' "$response_file")

if [ -z "$database_id" ]; then
	echo "Production Brainwaves D1 database not found" >&2
	exit 1
fi

payload=$(jq --null-input --compact-output '{sql: "SELECT id, email, name FROM \"user\" ORDER BY email"}')
curl --fail-with-body --silent --show-error \
	--connect-timeout 10 --max-time 30 \
	--header "$auth_header" \
	--header "Content-Type: application/json" \
	--data "$payload" \
	"$api_base/$database_id/query" |
	jq --exit-status '.result'

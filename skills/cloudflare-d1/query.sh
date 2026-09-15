#!/bin/sh
set -eu

: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is not configured}"
: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is not configured}"

database_name=${1:?usage: query.sh DATABASE_NAME SQL}
sql=${2:?usage: query.sh DATABASE_NAME SQL}

case "$sql" in
	*";"*)
		echo "Multiple SQL statements are not allowed" >&2
		exit 2
		;;
	SELECT* | select* | EXPLAIN* | explain*) ;;
	*)
		echo "Only read-only SQL statements are allowed" >&2
		exit 2
		;;
esac

api_base="https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database"
auth_header="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

database_id=$(
	curl --fail-with-body --silent --show-error --header "$auth_header" "$api_base" |
		jq --exit-status --raw-output --arg name "$database_name" \
			'.result[] | select(.name == $name) | .uuid' |
		head -n 1
)

if [ -z "$database_id" ]; then
	echo "D1 database not found: $database_name" >&2
	exit 1
fi

payload=$(jq --null-input --compact-output --arg sql "$sql" '{sql: $sql}')
curl --fail-with-body --silent --show-error \
	--header "$auth_header" \
	--header "Content-Type: application/json" \
	--data "$payload" \
	"$api_base/$database_id/query" |
	jq --exit-status '.result'

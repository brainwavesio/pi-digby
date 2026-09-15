#!/usr/bin/env python3
"""Conservatively validate and normalize one read-only SQLite statement."""

import sys


def semicolons_outside_literals(sql: str) -> list[int]:
	positions: list[int] = []
	quote: str | None = None
	i = 0
	while i < len(sql):
		char = sql[i]
		if quote is not None:
			if char == quote:
				if i + 1 < len(sql) and sql[i + 1] == quote:
					i += 2
					continue
				quote = None
		elif char in ("'", '"', "`"):
			quote = char
		elif char == ";":
			positions.append(i)
		i += 1
	return positions


def main() -> int:
	statement = sys.argv[1].strip() if len(sys.argv) == 2 else ""
	if not statement:
		print("SQL statement is required", file=sys.stderr)
		return 2

	semicolons = semicolons_outside_literals(statement)
	if len(semicolons) > 1 or (semicolons and semicolons[0] != len(statement) - 1):
		print("Multiple SQL statements are not allowed", file=sys.stderr)
		return 2
	if semicolons:
		statement = statement[:-1].rstrip()

	first_word = statement.split(maxsplit=1)[0].upper()
	if first_word not in {"SELECT", "EXPLAIN"}:
		print("Only read-only SQL statements are allowed", file=sys.stderr)
		return 2

	print(statement)
	return 0


if __name__ == "__main__":
	raise SystemExit(main())

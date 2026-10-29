# Reduce Digby model costs

This change prepares Sonnet 5.5 and records run usage. It does not change the deployed model, schedules, prompts, or stored conversations.

## Activate and roll back

1. Deploy the reviewed image through the existing deployment process, after approval. Keep the previous image digest and a private copy of `digby.json`.
2. Keep the current model first. Confirm that an ordinary scheduled run creates a record under `/data/.usage/YYYY-MM-DD/`.
3. After approval to switch the live model, set `model` in `/data/digby.json` to `amazon-bedrock/us.anthropic.claude-sonnet-5-5` and set `thinkingLevel` to `off`. Preserve all other settings. The configuration refreshes within two minutes and the next runner uses it. `off` sends `between_tools` with low effort on this model. Higher thinking levels use adaptive thinking. No paid test run is required by this procedure.
4. Inspect the next natural run for request errors, missing tools and unexpected actions. Compare costs per job over comparable periods. Do not treat changes in task volume as model savings.
5. To roll back the model, restore the previous `model` and `thinkingLevel` values. `amazon-bedrock/us.anthropic.claude-opus-5` remains supported. To roll back code, redeploy the previous image. Do not delete conversation or memory files.

The provider drops thinking blocks from a different model while retaining visible replies and tool history. Stored conversation files remain intact. The request adapter rejects forced tool selection on Sonnet 5.5 instead of silently weakening it. It removes unsupported sampling fields.

See the [Sonnet 5.5 migration guide](https://platform.claude.com/docs/en/models/sonnet-5-5/migration-guide) for thinking and tool restrictions.

## Read the usage records

Each completed Slack or Linear run writes a separate JSON file. Scheduled runs include the event filename as `jobId`. Records include run identity, times, outcome, silent flag and assistant-call tokens grouped by provider and model. The token fields separate input, output, cache reads and cache writes. `estimatedCostUsd` uses SDK rates, before credits or tax.

Records contain no prompts, responses, tool arguments, credentials or error text. `.usage` is hidden by the existing wiki access rules. New daily directories use mode 0700 and files use mode 0600. Files are retained; no automatic deletion is introduced.

These records are not invoices. They exclude compaction calls and external tool charges. Missing usage increments `missingCalls`; no observed usage yields a null total. An error after partial inference may have incomplete usage. A process crash before finalization leaves no record. A write failure produces `Run usage write failed` in application logs and does not prevent channel cleanup. AWS billing remains the source for total spend.

For cost analysis, group records by `jobId`, then provider/model, and sum each token field and estimated cost. Separate records with missing usage or failed outcomes. Preserve unknown usage as unknown.

## Remaining job changes

Deterministic memory Git sync and smaller Granola/digest contexts require the complete deployed job instructions. They are not included in this change because that source required sign-in consent during implementation. Do not replace backup or monitoring work based on abbreviated logs.

Once those instructions are available, preserve the current schedule and backup scope. Run ordinary Git operations without an LLM, escalate conflicts or failures to the agent, and retain the previous job definition for rollback. For Granola and digest, check for new source data first and use only the context each task needs. Keep durable checkpoints and the existing approval boundaries for external actions.

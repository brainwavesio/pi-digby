---
name: claude-code
description: Delegate a coding task to a Claude Code session. Clones a repo, runs Claude Code in --print mode, and reports results. Use for implementation tasks from tickets, PRs, or ad-hoc requests.
---

# Claude Code Delegation

Delegate a coding task to a Claude Code `--print` session. Each task runs in its own worktree directory, fully isolated.

## When to use

- User asks you to implement a ticket, feature, or fix in a codebase
- User asks you to pick up a GitHub issue or Linear ticket and code it
- Any task that requires sustained coding work in an external repo

## Setup

Task worktrees live in `{baseDir}/tasks/`. Each task gets a directory named by a short slug.

## Workflow

### 1. Prepare the task

```bash
TASK_SLUG="<short-descriptive-slug>"
TASK_DIR="{baseDir}/tasks/${TASK_SLUG}"
mkdir -p "$TASK_DIR"
```

If a repo needs cloning:
```bash
gh repo clone <owner/repo> "$TASK_DIR/repo"
```

If the repo already exists (follow-up run):
```bash
cd "$TASK_DIR/repo" && git pull
```

### 2. Write the prompt

Write the full task prompt to a file. Include:
- What to implement (from the ticket, PR, or user request)
- Any constraints or context from the conversation
- Which branch to work on, PR conventions, etc.

```bash
cat > "$TASK_DIR/prompt.md" << 'PROMPT'
<the full task description and context>
PROMPT
```

### 3. Run Claude Code

```bash
cd "$TASK_DIR/repo"
claude -p \
  --dangerously-skip-permissions \
  --output-format json \
  --max-budget-usd 5 \
  "$(cat "$TASK_DIR/prompt.md")" \
  > "$TASK_DIR/result.json" 2> "$TASK_DIR/stderr.log"
echo $? > "$TASK_DIR/exit_code"
```

Important flags:
- `--print` (`-p`): non-interactive, runs to completion
- `--dangerously-skip-permissions`: no permission prompts (headless)
- `--output-format json`: structured output for parsing
- `--max-budget-usd 5`: cost cap (adjust based on task complexity)

For follow-up runs (steering), add `--continue` to resume the previous session:
```bash
claude -p --continue \
  --dangerously-skip-permissions \
  --output-format json \
  --max-budget-usd 5 \
  "$(cat "$TASK_DIR/prompt.md")" \
  > "$TASK_DIR/result.json" 2> "$TASK_DIR/stderr.log"
```

### 4. Check results

```bash
# Exit code
cat "$TASK_DIR/exit_code"

# Parse the JSON result for the final response
cat "$TASK_DIR/result.json" | jq -r '.result // .error // "no output"'

# Check what Claude Code did
cd "$TASK_DIR/repo"
git log --oneline -5
git diff --stat HEAD~1 2>/dev/null

# Check if a PR was created
gh pr list --head "$(git branch --show-current)" --json url --jq '.[0].url'
```

### 5. Report to user

Tell the user:
- What was implemented (summary of changes)
- Link to PR if one was created
- Any issues or areas that need review
- Whether follow-up steering is needed

## Steering (follow-up runs)

If the user wants to adjust the output:
1. Update `prompt.md` with the new instructions
2. Run Claude Code again with `--continue`
3. Report the updated results

## Cost control

- Default budget: $5 per run
- Simple tasks (bug fixes, small features): $2
- Complex tasks (new features, refactors): $5-10
- Ask the user before exceeding $10

## Authentication

Claude Code needs a long-lived token to authenticate. The token is stored at `~/.claude/` which persists on EFS across restarts.

### Check if auth is set up

```bash
claude auth status 2>&1
```

If this shows authenticated, you're good. If not, tell the user:

> Claude Code isn't authenticated yet. You need to run this once via ECS exec:
> ```
> aws ecs execute-command --cluster pi-digby --task <task-id> --container pi-digby --interactive --command "claude setup-token"
> ```
> This sets up a long-lived token from your Claude subscription. It only needs to be done once — the token persists on EFS.

To find the task ID:
```bash
aws ecs list-tasks --cluster pi-digby --service pi-digby --query 'taskArns[0]' --output text
```

Do NOT attempt to run `claude setup-token` yourself — it requires interactive browser auth that only the user can complete.

## Notes

- Each task directory persists across conversations — you can resume work
- Clean up old task directories when done: `rm -rf {baseDir}/tasks/<slug>`

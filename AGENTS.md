# Development Rules

## Code Quality
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead of guessing
- Always ask before removing functionality or code that appears to be intentional

## Commands
- After code changes: `npm run check` (lint + typecheck). Fix all errors and warnings before committing.
- NEVER run: `npm run build` (CI builds, not local dev)
- Use `npx tsgo --noEmit` for quick typecheck without lint

## Commits
- Use conventional commits: `feat(scope):`, `fix(scope):`, `docs:`, etc.
- Run `npm run check` before committing (pre-commit hook enforces this)

## Code Style
- Biome handles formatting (tabs, 120 line width) and linting
- ESM with `.js` extensions in imports
- TypeScript strict mode

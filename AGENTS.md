# Repository module boundaries

- `modules/frontend-design/` is the frontend design area. Its `web/` and `shots/` directories contain the original repository frontend and previews.
- `modules/data-collection/` is the local Zhihu user-data collection area. Keep its source, tests, dependencies, configuration template, and integration documentation together.
- New independent modules get their own directory and README beneath `modules/`. Do not flatten module implementation files into the repository root.
- Root files are for shared navigation, ignore rules, and repository-wide instructions. Do not move unrelated existing root files as part of a module update.
- Before syncing, inspect remote updates and the working tree. Never force-push or overwrite another member's work to resolve a conflict.
- Stage only the intended module and explicitly reviewed shared documentation. Test the modified module before pushing.
- For the data collector, use Node.js 24+, run `npm ci` and `npm test` from `modules/data-collection/`. Normal tests use demo or mock data and do not require a real Zhihu login or Ollama model.
- Never commit actual `.env` files, browser profiles, cookies, tokens, SQLite databases, logs, exported user records, or `node_modules/`. Only configuration templates and synthetic fixtures belong in Git.
- CLI work is deferred. The separately requested official Zhihu API content-search collector is future work, not part of the existing browser-session collector upload.

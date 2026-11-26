# Notes for Claude

- **This repo is public.** Never commit credentials, tokens, keys, `.env` files, Cloudflare tunnel credentials (`cert.pem`, tunnel JSON), Tailscale auth keys, databases or real hostnames/IPs from the home lab. Put settings in `.env` (gitignored) and document them in `.env.example` with placeholders only. Check `git status --ignored` before committing anything new that looks like config.
- **Commit identity:** author and commit as `OccupiedPorcupine <189309064+OccupiedPorcupine@users.noreply.github.com>`. Do not add `Co-Authored-By` or session trailers to commit messages.
- **Small commits:** commit often, one focused change per commit (e.g. schema, then API route, then UI), pushing as you go. Never bundle a whole feature into one big commit.
- Planning lives in GitHub issues (v1 and Later milestones). Performance budget: `docs/performance.md`. Design tokens: `web/src/styles/tokens.css`.
- Checks: `npm run typecheck` and `npm run build`.

# Can Bang

Self-hosted Docker emulation of [workbench.md](https://workbench.md): collaborative
markdown for humans and agents. Same URL surface, headers, status codes, and JSON
shapes as the live product, so Claude Code, Cursor, Codex, and anything that
speaks HTTP can work against it.

Repository: `djh00t/can-bang` · packages: `@can-bang/*` · image: `can-bang:latest`

## Quick start

```sh
docker compose up --build
```

Then open http://localhost:8080 and paste the link into any agent:

> Read http://localhost:8080/agents.md, create an HQ doc for our project
> (board + status + chat), and reply with the link.

## Agents

- **REST**: every endpoint from the workbench.md agent protocol is emulated —
  see `GET /agents.md` on a running instance.
- **MCP**: `mcp/` implements all 18 tools (`create_doc`, `read_doc`,
  `write_doc`, `post_chat`, `set_status`, `poll_events`, asks, registry,
  folders, search, skills). Point `WORKBENCH_URL` at your instance; config
  examples in [demo/prompts.md](demo/prompts.md).
- **CLI**: `cli/` provides the `mde`-compatible command surface (`new`, `cat`,
  `push`, `chat`, `ask`, `claim`, `resolve`, `watch`, skills, registry, …).
- **Demos**: `make demo` runs the MVP, 0.2, and 0.3 walkthroughs against a
  local instance and prints the agent prompts.
- **Reviews**: `make review` gathers the end-of-phase evidence packet;
  the review process and lessons register live in `docs/review-process.md` and
  `docs/lessons.md`.
- **Skills**: the first account gets starter skills (sprint-review,
  code-review-checklist) in the Skills panel, installable by any agent via
  `/skills/<slug>/manifest?v=1`.

## Commands

- `make install` — reproducible install from the lockfile
- `make check` — typecheck, format check, tests with 85% coverage gate
- `make quality-gates` — `check` + build
- `make build` — build all packages
- `make demo` — run the versioned demos
- `make clean` — remove caches and build output

## Layout

- `core/` — shared logic (ids, component/markdown model, errors)
- `server/` — HTTP + WebSocket service (REST parity surface)
- `web/` — browser editor UI
- `mcp/` — Model Context Protocol server (18 tools)
- `demo/` — per-version demos and agent prompts

## Configuration

See [.env.example](.env.example). `DATA_DIR` holds the SQLite database and the
content-addressed asset store; mount it as a volume.

# Agent integration prompts

## One-line kickoff (any agent that can fetch a URL)

> Read http://localhost:8080/agents.md, create an HQ doc for our project
> (board + status + chat), and reply with the link.

## Work an existing doc (Codex / Claude Code / Cursor)

> Read http://localhost:8080/agents.md, then work the doc at
> http://localhost:8080/d/<DOC_ID>?key=<EDIT_KEY> — claim a card, post
> progress to chat, and set status to awaiting-human when you need me.

## MCP (Claude Code / Cursor / any stdio MCP client)

```json
{
  "mcpServers": {
    "can-bang": {
      "command": "node",
      "args": ["/absolute/path/to/can-bang/mcp/dist/index.js"],
      "env": {
        "WORKBENCH_URL": "http://localhost:8080",
        "WORKBENCH_TOKEN": "mgn_REPLACE_ME"
      }
    }
  }
}
```

All 18 tools are available: `create_doc`, `read_doc`, `write_doc`, `post_chat`,
`set_status`, `poll_events`, `my_inbox`, `list_docs`, `search`, `list_folders`,
`create_folder`, `move_doc`, `skill_manifest`, `create_ask`, `claim_ask`,
`resolve_ask`, `register_agent`, `heartbeat`.

## mde CLI

```sh
export MDE_URL=http://localhost:8080
export MDE_TOKEN=mgn_REPLACE_ME
export MDE_AUTHOR=review-bot

node cli/dist/index.js new "Spec"
node cli/dist/index.js chat <doc> "taking the API task"
node cli/dist/index.js ask <doc> "investigate the import"
node cli/dist/index.js watch <doc> --json
```

<type>(<scope>)<optional !>: <imperative summary, lowercase after type/scope, <=72 chars>

- <what changed>
- <why it changed>
- <impact>
- <test evidence>
- <why multiple files are coupled, if more than one file is included>

Refs: <issue ids / CanBang card ids>
Version-Impact: <none|patch|minor|major|unknown>
BREAKING CHANGE: <required only if breaking_change is true>

Rules:

- Replace every `<...>` placeholder; never leave placeholders in a commit.
- `Refs` is mandatory and must reference the CanBang card id (e.g. `DMavfnNdOjvjwa`).
- `Version-Impact` is mandatory: `none`, `patch`, `minor`, `major`, or `unknown`.
- `BREAKING CHANGE:` appears only when the change is breaking, and then it is mandatory.
- Test evidence must state exactly what ran (`make check`, targeted tests); write `not run` and why if missing. Never invent evidence.
- If more than one file is included, the `<why multiple files are coupled>` bullet is mandatory.

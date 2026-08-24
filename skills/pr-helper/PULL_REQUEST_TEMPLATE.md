## Agent / Thread

- Session ID: {session_id}
- Title: {codex_thread_name}
- CWD: {codex_cwd}
- Brute version: {brute_version}
- Brute URL: {brute_url}
- Codex URL: {codex_url}
- Identity provenance: {identity_provenance}

## Summary

- ...

## Conventional Commit Breakdown

| Commit | Type | Scope | Issue | Version impact | Notes |
| ------ | ---- | ----- | ----- | -------------- | ----- |
| ...    | ...  | ...   | ...   | ...            | ...   |

## Release Notes Draft

### Customer-facing

- ...

### Internal / operational

- ...

## Behaviour Changes

- ...

## API / Schema / Contract Changes

- ...

## Testing Evidence

- `make check`: Not provided
- Targeted tests: Not provided

## Coverage Evidence

Not provided

## Quality Gate Evidence

- `make quality-gates`: Not provided

## Demo Evidence

### UI Evidence

- Screenshots: Not applicable. UI changes MUST include red-circled annotated screenshots under `docs/screenshots/{pr_id}/`.
- Screenshot image URLs must be uploaded and reachable before `pr-body-check` runs.
- Video: Not applicable. Use a short screen capture for complex behavior when useful.
- Browser/runtime: Not applicable. Include browser, version, runtime source, and Playwright version when browser capture is used.

### CLI Evidence

```shell
# CLI changes MUST include the exact command and captured output here.
```

## Versioning / SemVer Impact

Recommended impact: `none | patch | minor | major | unknown`

Reason:

## Risk and Rollback

- Risk:
- Rollback:

## Operational Notes

- ...

## Linked Work

- Refs:

## Reviewer Checklist

- [ ] Acceptance criteria satisfied
- [ ] Tests are meaningful
- [ ] `make check` passed
- [ ] `make quality-gates` passed
- [ ] dependency-advisor evidence reviewed for package or lockfile changes
- [ ] Coverage evidence reviewed
- [ ] Demo evidence reviewed
- [ ] UI-related PRs include reachable marked-up screenshots in Demo Evidence
- [ ] UI screenshots are red-annotated and stored under `docs/screenshots/{pr_id}/`
- [ ] CLI-related PRs include captured output in a `shell` block
- [ ] Adversarial review completed
- [ ] Version impact is correct
- [ ] Rollback plan is credible

## Adversarial Review Result

- Verdict: Not provided
- Blocking findings: Not provided
- Follow-ups: Not provided

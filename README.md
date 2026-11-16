# Forge — a GitHub-compatible git forge in one process

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/theyschool/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/theyschool/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node 22 program
(`main.ts`, standard library only — no git binary, no outside service, no
dependencies). It binds an ephemeral port, registers it with the trial env,
and serves four surfaces from one in-memory store with a real SHA-1 object
model (loose objects + pack read/write, implemented by hand):

| Surface | What it serves |
| --- | --- |
| git smart HTTP `/{owner}/{repo}.git` | upload-pack protocol v2 (`ls-refs`, `fetch`, shallow/deepen, thin packs), receive-pack v0 (`report-status`, `side-band-64k`, `delete-refs`), fast-forward-only pushes with per-ref `ok`/`ng` lines |
| REST v3 `/api/v3` | repositories, branches, commits, contents (PUT/DELETE with sha), labels, issues, comments, pull requests, files and squash merges; every reply `application/json` with `X-GitHub-Request-Id`; `401` without a Bearer token, JSON `404`s |
| GraphQL v4 `/api/graphql` | the documents `gh` and `github-mcp-server` send: `viewer`, `repository` (+ issues with ordering and cursor pagination, pull requests, files), `node(id:)`, `__type` introspection, `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` / `addComment`, operation batching, unknown fields as HTTP 200 with `errors` |
| MCP `/mcp` | JSON-RPC 2.0 Streamable HTTP, revision `2026-07-28` (`server/discover`, `initialize`, `tools/list`, `tools/call`): `create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request` (+ `list_repos`, `get_issue`), acting on the same store as REST |

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22. The lifecycle is the
harness's: bind an ephemeral port, `POST {"port": N}` to
`$MAKEFUN_ENV_URL/register`, long-poll `GET $MAKEFUN_ENV_URL/done`, exit 0
when it says done. Without `MAKEFUN_ENV_URL` the program serves standalone
on its ephemeral port (handy for local testing).

## Local grade

With the kit's conformance runner against a running forge:

```sh
MAKEFUN_SHOP_TOKEN=test-token-123 node main.ts &
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:$PORT --token test-token-123 [--perf]
```

Local conformance (practice trial-0 seed): **120/120 checks, 200/200 agent**;
`grade-local --driver process`: **score 860** (feature 585, agent 200,
perf 75 on the first run; 120/120 + perf 60 on the local runner — the dev
box is heavily contended, so perf varies run to run).

## Layout

- `main.ts` — the whole forge: lifecycle, object store, packfiles, REST,
  git smart HTTP, GraphQL, MCP.
- `LICENSE` (MIT).

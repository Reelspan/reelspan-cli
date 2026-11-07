# Changelog

## 0.1.0

First release.

- `reelspan login | logout | whoami | platforms`
- `reelspan post video | photos | text | document`, with `--schedule`, `--timezone`, `--queue`, `--first-comment`,
  `--repeat-every`, `-o key=value` for any API field, `--idempotency-key`, `--async`, `--wait` and `--dry-run`.
  Local files are uploaded (big ones in parts); URLs, including Drive and Dropbox links, are fetched by Reelspan.
- `status`, `retry`, `history`, `scheduled list | cancel | edit`, `queue preview | next`, `analytics` (account,
  history, best times, one post), `library list | add`, `captions` (AI), `webhook get | set | test`, `profiles list |
  create | delete | connect-link | use`.
- `reelspan api <METHOD> <path>` for any endpoint.
- `--json` on every command; errors as JSON on stderr; exit codes 0 / 1 (error) / 2 (usage) / 3 (some networks failed).
- One bundled file with no runtime dependencies, so `npx @reelspan/cli` starts fast.

# @reelspan/cli

[Reelspan](https://reelspan.com) from the terminal. Publish videos, photos and text to TikTok, YouTube, Instagram,
Facebook, X, Threads, LinkedIn, Pinterest, Bluesky, Reddit and 12 more networks, schedule them, retry the failures and
read how they did. It works the same for you, a shell script, a CI job or an AI agent.

```bash
npx @reelspan/cli login
npx @reelspan/cli post video launch.mp4 --to tiktok,youtube,instagram -p my-brand --title "Launch day"
```

Or install it: `npm install -g @reelspan/cli`, then use `reelspan …`. Node 20+. One bundled file, no dependencies.

## Sign in

```bash
reelspan login          # asks for the key (hidden), checks it, saves it
reelspan whoami         # plan and this month's usage
```

Create a key in the dashboard under **Developers → API keys**. The key is saved to `~/.config/reelspan/config.json`
(`%APPDATA%\reelspan` on Windows) readable only by you. `REELSPAN_API_KEY` or `--api-key` take precedence, which is
what you want in CI.

## Post

```bash
# a video: a local file (big files go up in parts) or a public URL (Google Drive and Dropbox links work)
reelspan post video clip.mp4 --to tiktok,youtube,instagram -p my-brand --title "How we did it" --first-comment "Link in bio"

# a carousel, in order, with alt text
reelspan post photos a.jpg b.jpg c.jpg --to instagram,linkedin -p my-brand --title "Before and after" --alt "Before" --alt "After" --alt "Team"

# text (long text becomes a thread on X and Bluesky); - reads stdin
reelspan post text "We shipped it." --to x,bluesky,threads,linkedin -p my-brand
cat notes.md | reelspan post text - --to linkedin -p my-brand

# a PDF as a swipeable LinkedIn document
reelspan post document deck.pdf --to linkedin -p my-brand --title "Q3 in 10 slides"
```

Every post command takes:

| Option | |
|---|---|
| `-t, --to <list>` | networks, comma-separated |
| `-p, --profile <name>` | the profile; or `REELSPAN_PROFILE`, or `reelspan profiles use <name>` once |
| `--title`, `--description` | caption, and a longer description where the network has one |
| `--schedule <iso>` + `--timezone <tz>` | publish later (`2026-12-01T09:00` + `America/New_York`) |
| `--queue` | take the profile's next free queue slot |
| `--first-comment <text>` | posted as the first comment |
| `--repeat-every day\|week\|month --repeat-times <n>` | a repeating series |
| `-o key=value` | any other API field, repeatable: `-o privacy_level=PUBLIC_TO_EVERYONE -o reddit_subreddit=videos` |
| `--idempotency-key <k>` | run the same command twice, post once |
| `--async`, `--wait` | return a request_id at once; or wait until every network has finished |
| `--dry-run` | print what would be sent |

Upload-Post field names work in `-o` too, so existing settings carry over.

## After posting

```bash
reelspan status req_abc --wait          # each network's result
reelspan retry req_abc --platforms instagram -o title="Shorter caption"
reelspan history --platform tiktok --status failed
reelspan scheduled                      # list; then: reelspan scheduled cancel job_123
reelspan scheduled edit job_123 --schedule 2026-12-02T10:00
reelspan queue -p my-brand --count 10   # upcoming queue slots
reelspan analytics -p my-brand          # followers, reach, engagement
reelspan analytics -p my-brand --best-times
reelspan analytics --post req_abc       # one post's numbers
```

## More

```bash
reelspan profiles                        # every profile and its networks
reelspan profiles create acme --name "Acme Inc"
reelspan profiles connect-link acme      # a link where a client connects their own accounts
reelspan library add ./b-roll.mp4        # upload once, reuse by media_id: -o video_media_id=...
reelspan captions --text "Our new espresso blend" --platforms tiktok,instagram,linkedin
reelspan webhook set https://example.com/hooks/reelspan
reelspan api GET /v1/me                  # any endpoint
```

## For scripts and AI agents

- `--json` prints the API's answer as JSON on stdout; errors go to stderr as `{"error":{"type","status","code","message"}}`.
- Exit codes: `0` done, `1` API or network error, `2` bad usage, `3` the post went out but some networks failed.
- Nothing is interactive unless you run `login` without a key.
- Posts are retried safely on network errors and 5xx answers: each carries an idempotency key.

```bash
if ! out=$(reelspan --json post video "$FILE" --to tiktok,youtube -p brand --title "$TITLE"); then
  echo "failed: $out" >&2
fi
echo "$out" | jq -r '.request_id'
```

## Links

[API reference](https://reelspan.com/docs) · [Node SDK](https://github.com/Reelspan/reelspan-node) ·
[MCP server](https://github.com/Reelspan/reelspan-mcp) · [GitHub Action](https://github.com/Reelspan/reelspan-action)

MIT licensed. Security reports: see [SECURITY.md](SECURITY.md).

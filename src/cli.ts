#!/usr/bin/env node
// reelspan: publish to every major social network from the terminal, a script or an AI agent.
import { Command, Option } from 'commander';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { Reelspan, ReelspanError, ReelspanConnectionError, type FileInput, type PostCommon, type PostResponse, type Json } from 'reelspan';
import { clearConfig, configPath, readConfig, writeConfig } from './config.js';

export const VERSION = '0.1.0';

/** 0 done · 1 API or network error · 2 bad usage · 3 the post went out but some networks failed */
export const EXIT = { ok: 0, error: 1, usage: 2, partial: 3 } as const;

export class UsageError extends Error {}

type Io = { out: (s: string) => void; err: (s: string) => void; env: NodeJS.ProcessEnv; readSecret?: (prompt: string) => Promise<string> };

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.m4v': 'video/x-m4v', '.avi': 'video/x-msvideo', '.mkv': 'video/x-matroska',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.heic': 'image/heic',
  '.pdf': 'application/pdf', '.ppt': 'application/vnd.ms-powerpoint', '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

const isUrl = (s: string) => /^https?:\/\//i.test(s);

/** A local path becomes bytes; an http(s) URL is passed through for the server to fetch. */
export async function fileInput(pathOrUrl: string): Promise<FileInput> {
  if (isUrl(pathOrUrl)) return pathOrUrl;
  try {
    await stat(pathOrUrl);
  } catch {
    throw new UsageError(`No such file: ${pathOrUrl}`);
  }
  return { data: await readFile(pathOrUrl), name: basename(pathOrUrl), type: MIME[extname(pathOrUrl).toLowerCase()] };
}

/** `-o key=value` pairs become extra API fields; repeated keys (or key[]=) become arrays. */
export function parseExtra(pairs: string[] = []): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const p of pairs) {
    const i = p.indexOf('=');
    if (i < 1) throw new UsageError(`-o expects key=value, got "${p}"`);
    const k = p.slice(0, i);
    const v = p.slice(i + 1);
    const prev = out[k];
    out[k] = prev === undefined ? (k.endsWith('[]') ? [v] : v) : [...(Array.isArray(prev) ? prev : [prev]), v];
  }
  return out;
}

const list = (v: string) => v.split(',').map((s) => s.trim()).filter(Boolean);
const collect = (v: string, prev: string[] = []) => [...prev, v];

function table(rows: Record<string, unknown>[], cols: string[]): string {
  if (!rows.length) return '(none)';
  const cell = (v: unknown) => (v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v)).replace(/\s+/g, ' ');
  const w = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => cell(r[c]).length))));
  const line = (vals: string[]) => vals.map((v, i) => (v.length > w[i] ? v.slice(0, w[i] - 1) + '…' : v.padEnd(w[i]))).join('  ').trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...rows.map((r) => line(cols.map((c) => cell(r[c]))))].join('\n');
}

/** Per-network lines for a post answer; returns how many networks failed. */
function describePost(r: PostResponse | Json, out: (s: string) => void): number {
  const ids = [r.request_id && `request_id ${r.request_id}`, r.job_id && `job_id ${r.job_id}`].filter(Boolean).join(' · ');
  if (r.job_id && !r.results) out(`Scheduled${r.scheduled_date ? ` for ${r.scheduled_date}` : ''}. ${ids}`);
  else if (!r.results || !Object.keys(r.results).length) out(`Accepted. ${ids}${r.status ? ` · ${r.status}` : ''}`);
  let failed = 0;
  const results: Json[] = Array.isArray(r.results) ? r.results : Object.entries(r.results ?? {}).map(([platform, v]) => ({ platform, ...(v as Json) }));
  for (const x of results) {
    if (x.success) out(`✓ ${x.platform}  ${x.url ?? x.post_id ?? 'published'}`);
    else if (x.skipped) out(`- ${x.platform}  skipped${x.error ? `: ${x.error}` : ''}`);
    else if (x.success === false || x.error) {
      failed++;
      out(`✗ ${x.platform}  ${x.error ?? 'failed'}${x.error_code ? ` (${x.error_code})` : ''}`);
    } else out(`… ${x.platform}  ${x.status ?? 'in progress'}`);
  }
  if (results.length && ids) out(ids);
  return failed;
}

export function buildProgram(io: Io) {
  let exitCode: number = EXIT.ok;
  const program = new Command();
  program
    .name('reelspan')
    .description('Publish videos, photos and text to TikTok, YouTube, Instagram, X, LinkedIn and more.')
    .version(VERSION)
    .option('--json', 'machine-readable output (the API answer as JSON)')
    .option('--api-key <key>', 'API key (default: REELSPAN_API_KEY, then `reelspan login`)')
    .option('--base-url <url>', 'API base URL (default https://api.reelspan.com)')
    .configureOutput({ writeOut: (s) => io.out(s.trimEnd()), writeErr: (s) => io.err(s.trimEnd()) })
    .exitOverride()
    .showHelpAfterError('(run with --help for usage)');

  const g = () => program.opts<{ json?: boolean; apiKey?: string; baseUrl?: string }>();
  const cfg = () => readConfig(io.env);
  const client = () => {
    const apiKey = g().apiKey ?? io.env.REELSPAN_API_KEY ?? cfg().apiKey;
    if (!apiKey) throw new UsageError('No API key. Run `reelspan login`, set REELSPAN_API_KEY, or pass --api-key.');
    return new Reelspan({ apiKey, baseUrl: g().baseUrl ?? io.env.REELSPAN_BASE_URL ?? cfg().baseUrl, headers: { 'x-reelspan-client': `cli/${VERSION}` } });
  };
  const profileOf = (o: { profile?: string }) => {
    const p = o.profile ?? io.env.REELSPAN_PROFILE ?? cfg().profile;
    if (!p) throw new UsageError('Which profile? Pass --profile <username>, set REELSPAN_PROFILE, or run `reelspan profiles use <username>`.');
    return p;
  };
  /** Prints JSON with --json, otherwise the human version. */
  const show = (data: unknown, human?: () => void) => (g().json || !human ? io.out(JSON.stringify(data, null, 2)) : human());

  // ─── account ──────────────────────────────────────────────────────────────────────────────────

  program
    .command('login')
    .description('Save an API key (checked first) for later commands')
    .option('--key <key>', 'the key (otherwise asked for, hidden; avoid this flag in shared shells)')
    .action(async (o: { key?: string }) => {
      const key = o.key ?? io.env.REELSPAN_API_KEY ?? (io.readSecret ? await io.readSecret('Reelspan API key (dashboard → Developers → API keys): ') : undefined);
      if (!key) throw new UsageError('Pass --key or set REELSPAN_API_KEY (no terminal to ask in).');
      const baseUrl = g().baseUrl ?? io.env.REELSPAN_BASE_URL;
      const me = await new Reelspan({ apiKey: key.trim(), baseUrl }).me();
      writeConfig({ ...cfg(), apiKey: key.trim(), ...(baseUrl ? { baseUrl } : {}) }, io.env);
      show({ saved: configPath(io.env), account: me }, () => io.out(`Logged in${me.email ? ` as ${me.email}` : ''}${me.plan ? ` (${typeof me.plan === 'object' ? (me.plan as Json).name ?? (me.plan as Json).id : me.plan} plan)` : ''}. Key saved to ${configPath(io.env)}`));
    });

  program
    .command('logout')
    .description('Forget the saved API key')
    .action(() => {
      clearConfig(io.env);
      io.out('Logged out.');
    });

  program
    .command('whoami')
    .description('The account, plan and this month’s usage')
    .action(async () => show(await client().me(), undefined));

  program
    .command('platforms')
    .description('Every network and what it takes')
    .action(async () => {
      const r = (await client().platforms()) as Json;
      const rows: Json[] = Array.isArray(r.platforms) ? r.platforms : Array.isArray(r) ? (r as unknown as Json[]) : [];
      show(r, rows.length ? () => io.out(table(rows, ['id', 'name', 'status'].filter((c) => rows.some((x) => x[c] !== undefined)))) : undefined);
    });

  // ─── profiles ─────────────────────────────────────────────────────────────────────────────────

  const profiles = program.command('profiles').description('Profiles (one brand or client each) and their accounts');
  profiles
    .command('list', { isDefault: true })
    .description('Every profile and its connected networks')
    .action(async () => {
      const r = await client().profiles.list();
      show(r, () =>
        io.out(
          table(
            r.profiles.map((p) => ({ username: p.username, name: p.display_name, networks: Object.entries(p.social_accounts ?? {}).filter(([, v]) => v).map(([k]) => k).join(', ') })),
            ['username', 'name', 'networks'],
          ),
        ),
      );
    });
  profiles
    .command('create <username>')
    .option('--name <display name>')
    .action(async (username: string, o: { name?: string }) => show(await client().profiles.create(username, o.name), () => io.out(`Created ${username}. Connect accounts with: reelspan profiles connect-link ${username}`)));
  profiles
    .command('delete <username>')
    .requiredOption('--yes', 'confirm: deletes the profile and disconnects its accounts')
    .action(async (username: string) => show(await client().profiles.delete(username), () => io.out(`Deleted ${username}.`)));
  profiles
    .command('connect-link <username>')
    .description('A link (48 h) where someone connects their accounts to the profile, no login needed')
    .option('--platforms <list>', 'only these networks, comma-separated', list)
    .option('--redirect-url <url>')
    .action(async (username: string, o: { platforms?: string[]; redirectUrl?: string }) => {
      const r = await client().connect.link(username, { platforms: o.platforms, redirect_url: o.redirectUrl });
      show(r, () => io.out(r.access_url));
    });
  profiles
    .command('use <username>')
    .description('Make this the default profile for post commands')
    .action((username: string) => {
      writeConfig({ ...cfg(), profile: username }, io.env);
      io.out(`Default profile: ${username}`);
    });

  // ─── posting ──────────────────────────────────────────────────────────────────────────────────

  const post = program.command('post').description('Publish now, at a time, or in the queue');
  const postOptions = (c: Command) =>
    c
      .requiredOption('-t, --to <platforms>', 'networks, comma-separated (tiktok,youtube,instagram,…)', list)
      .option('-p, --profile <username>', 'profile (default REELSPAN_PROFILE or `profiles use`)')
      .option('--title <text>', 'caption / title')
      .option('--description <text>', 'longer description where the network has one')
      .option('--schedule <iso>', 'publish at this time (ISO-8601, e.g. 2026-12-01T09:00)')
      .option('--timezone <tz>', 'IANA timezone for --schedule, e.g. America/New_York')
      .option('--queue', 'take the profile’s next free queue slot')
      .option('--first-comment <text>', 'posted as the first comment')
      .addOption(new Option('--repeat-every <unit>', 'repeat the post').choices(['day', 'week', 'month']))
      .option('--repeat-times <n>', 'posts in the series (2-30)', Number)
      .option('--external-id <id>', 'your own id, echoed in webhooks and history')
      .option('-o, --option <key=value>', 'any other API field, repeatable (e.g. -o privacy_level=PUBLIC_TO_EVERYONE -o reddit_subreddit=videos)', collect)
      .option('--idempotency-key <key>', 'repeating the command with the same key never posts twice')
      .option('--async', 'return at once with a request_id')
      .option('--wait', 'with --async: wait until every network has finished')
      .option('--dry-run', 'print what would be sent, send nothing');

  type PostOpts = { to: string[]; profile?: string; title?: string; description?: string; schedule?: string; timezone?: string; queue?: boolean; firstComment?: string; repeatEvery?: 'day' | 'week' | 'month'; repeatTimes?: number; externalId?: string; option?: string[]; idempotencyKey?: string; async?: boolean; wait?: boolean; dryRun?: boolean };

  const common = (o: PostOpts, title?: string): PostCommon => ({
    user: profileOf(o),
    platforms: o.to,
    title: title ?? o.title,
    description: o.description,
    scheduledDate: o.schedule,
    timezone: o.timezone,
    addToQueue: o.queue,
    firstComment: o.firstComment,
    repeatEvery: o.repeatEvery,
    repeatTimes: o.repeatTimes,
    externalId: o.externalId,
    extra: parseExtra(o.option),
    idempotencyKey: o.idempotencyKey,
    async: o.async || o.wait,
  });

  const send = async (o: PostOpts, preview: Json, run: (c: Reelspan) => Promise<PostResponse>) => {
    if (o.dryRun) return show({ dry_run: true, ...preview }, () => io.out(`Would send:\n${JSON.stringify(preview, null, 2)}`));
    const c = client();
    let r: PostResponse | Json = await run(c);
    if (o.wait && r.request_id && !r.job_id) r = await c.posts.wait(r.request_id);
    let failed = 0;
    show(r, () => {
      failed = describePost(r, io.out);
    });
    if (g().json) {
      const res: Json[] = Array.isArray(r.results) ? r.results : Object.values(r.results ?? {});
      failed = res.filter((x) => x.success === false && !x.skipped).length;
    }
    if (failed) exitCode = EXIT.partial;
  };

  const redact = (p: PostCommon) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== undefined && !(typeof v === 'object' && v && !Array.isArray(v) && !Object.keys(v).length)));

  postOptions(post.command('video <file-or-url>').description('A video: a local file or a public URL (Drive and Dropbox links work)'))
    .option('--thumbnail <file-or-url>')
    .action(async (file: string, o: PostOpts & { thumbnail?: string }) => {
      const p = common(o);
      await send(o, { type: 'video', video: file, thumbnail: o.thumbnail, ...redact(p) }, async (c) => c.posts.video({ ...p, video: await fileInput(file), thumbnail: o.thumbnail ? await fileInput(o.thumbnail) : undefined }));
    });

  postOptions(post.command('photos <files-or-urls...>').description('One photo or a carousel, in order'))
    .option('--alt <text>', 'alt text, once per photo in order', collect)
    .action(async (files: string[], o: PostOpts & { alt?: string[] }) => {
      const p = common(o);
      await send(o, { type: 'photos', photos: files, alt_text: o.alt, ...redact(p) }, async (c) => c.posts.photos({ ...p, photos: await Promise.all(files.map(fileInput)), altTexts: o.alt }));
    });

  postOptions(post.command('text <text>').description('Text only; long text becomes a thread on X and Bluesky. Use - to read stdin.'))
    .action(async (text: string, o: PostOpts) => {
      const body = text === '-' ? await readStdin() : text;
      if (!body.trim()) throw new UsageError('The text is empty.');
      const p = common(o, body);
      await send(o, { type: 'text', ...redact(p) }, (c) => c.posts.text(p));
    });

  postOptions(post.command('document <file-or-url>').description('A PDF (or PPT/DOCX) shown as a swipeable document on LinkedIn'))
    .action(async (file: string, o: PostOpts) => {
      const p = common(o);
      await send(o, { type: 'document', document: file, ...redact(p) }, async (c) => c.posts.document({ ...p, document: await fileInput(file) }));
    });

  // ─── after posting ────────────────────────────────────────────────────────────────────────────

  program
    .command('status <id>')
    .description('Each network’s result for a request_id (or a job_id with --job)')
    .option('--job', 'the id is a scheduled job_id')
    .option('--wait', 'wait until every network has finished')
    .action(async (id: string, o: { job?: boolean; wait?: boolean }) => {
      const c = client();
      const r = o.wait && !o.job ? await c.posts.wait(id) : await c.posts.status(o.job ? { jobId: id } : { requestId: id });
      let failed = 0;
      show(r, () => {
        io.out(`Status: ${r.status}`);
        failed = describePost(r, io.out);
      });
      if (g().json) failed = (r.results ?? []).filter((x) => x.success === false && !x.skipped).length;
      if (failed && ['completed', 'failed'].includes(r.status)) exitCode = EXIT.partial;
    });

  program
    .command('retry <request-id>')
    .description('Send the failed networks again, with the media Reelspan already has')
    .option('--platforms <list>', 'only these', list)
    .option('-o, --option <key=value>', 'change a field for this try, repeatable', collect)
    .action(async (id: string, o: { platforms?: string[]; option?: string[] }) => {
      const extra = parseExtra(o.option);
      const r = await client().posts.retry(id, { platforms: o.platforms, fields: Object.keys(extra).length ? extra : undefined });
      let failed = 0;
      show(r, () => {
        failed = describePost(r, io.out);
      });
      if (failed) exitCode = EXIT.partial;
    });

  program
    .command('history')
    .description('Recent posts, one row per network')
    .option('-p, --profile <username>')
    .option('--platform <name>')
    .addOption(new Option('--status <status>').choices(['success', 'failed']))
    .addOption(new Option('--limit <n>').choices(['10', '20', '50', '100']).default('20'))
    .option('--page <n>', 'page', '1')
    .action(async (o: { profile?: string; platform?: string; status?: 'success' | 'failed'; limit: string; page: string }) => {
      const r = await client().posts.history({ profile_username: o.profile, platform: o.platform, status: o.status, limit: Number(o.limit) as 20, page: Number(o.page) });
      show(r, () => {
        io.out(table(r.history, ['upload_timestamp', 'platform', 'profile_username', 'success', 'post_url', 'request_id'].filter((c) => r.history.some((x) => x[c] !== undefined))));
        if (r.total > r.page * r.limit) io.out(`page ${r.page} of ${Math.ceil(r.total / r.limit)} (--page ${r.page + 1} for more)`);
      });
    });

  // ─── scheduled and queue ──────────────────────────────────────────────────────────────────────

  const scheduled = program.command('scheduled').description('Posts waiting for their time');
  scheduled
    .command('list', { isDefault: true })
    .option('-p, --profile <username>')
    .action(async (o: { profile?: string }) => {
      const r = (await client().scheduled.list({ profile_username: o.profile })) as Json;
      const rows: Json[] = r.scheduled_posts ?? r.scheduled ?? r.jobs ?? (Array.isArray(r) ? r : []);
      show(r, () => io.out(table(rows, ['job_id', 'scheduled_date', 'profile_username', 'platforms', 'title'].filter((c) => rows.some((x) => x[c] !== undefined)))));
    });
  scheduled
    .command('cancel <job-id>')
    .option('--with-later-repeats', 'also cancel the later posts of a repeating series')
    .action(async (id: string, o: { withLaterRepeats?: boolean }) => show(await client().scheduled.cancel(id, o), () => io.out(`Cancelled ${id}.`)));
  scheduled
    .command('edit <job-id>')
    .option('--schedule <iso>')
    .option('--timezone <tz>')
    .option('--title <text>')
    .option('--description <text>')
    .action(async (id: string, o: { schedule?: string; timezone?: string; title?: string; description?: string }) =>
      show(await client().scheduled.edit(id, { scheduled_date: o.schedule, timezone: o.timezone, title: o.title, description: o.description }), () => io.out(`Updated ${id}.`)),
    );

  const queue = program.command('queue').description('The posting queue of a profile');
  queue
    .command('preview', { isDefault: true })
    .option('-p, --profile <username>')
    .option('--count <n>', 'how many slots', Number)
    .action(async (o: { profile?: string; count?: number }) => show(await client().queue.preview(profileOf(o), o.count)));
  queue
    .command('next')
    .option('-p, --profile <username>')
    .action(async (o: { profile?: string }) => show(await client().queue.nextSlot(profileOf(o))));

  // ─── analytics, library, AI ───────────────────────────────────────────────────────────────────

  program
    .command('analytics')
    .description('Followers, reach and engagement of a profile, or of one post with --post')
    .option('-p, --profile <username>')
    .option('--post <request-id>', 'one post’s numbers instead')
    .option('--platforms <list>', 'only these networks', list)
    .option('--days <n>', 'with --history: how many days', Number)
    .option('--history', 'day-by-day numbers')
    .option('--best-times', 'the best hours to post')
    .action(async (o: { profile?: string; post?: string; platforms?: string[]; days?: number; history?: boolean; bestTimes?: boolean }) => {
      const c = client();
      if (o.post) return show(await c.analytics.post(o.post, o.platforms?.[0]));
      const user = profileOf(o);
      if (o.bestTimes) return show(await c.analytics.bestTimes(user, { platforms: o.platforms }));
      if (o.history) return show(await c.analytics.history(user, { days: o.days, platforms: o.platforms }));
      show(await c.analytics.account(user, o.platforms));
    });

  const library = program.command('library').description('Your saved media');
  library
    .command('list', { isDefault: true })
    .addOption(new Option('--kind <kind>').choices(['video', 'photo', 'document']))
    .option('--limit <n>', '', Number)
    .action(async (o: { kind?: 'video' | 'photo' | 'document'; limit?: number }) => show(await client().library.list(o)));
  library
    .command('add <file-or-url>')
    .description('Upload a file (or import a Drive/Dropbox/https link) and keep it; prints its media_id')
    .option('--title <text>')
    .action(async (file: string, o: { title?: string }) => {
      const c = client();
      if (isUrl(file)) return show(await c.library.import(file, o.title));
      const input = (await fileInput(file)) as { data: Uint8Array; name: string; type?: string };
      const r = await c.media.upload(input, { save: true, title: o.title });
      show(r, () => io.out(r.media_id));
    });

  program
    .command('captions')
    .description('Captions written by AI for each network (one AI credit)')
    .option('--text <text>', 'what the post is about')
    .option('--video <file-or-url>', 'write them from a video instead (frames and speech)')
    .option('--platforms <list>', 'networks to write for', list)
    .option('--language <code>')
    .action(async (o: { text?: string; video?: string; platforms?: string[]; language?: string }) => {
      const c = client();
      if (o.video) return show(await c.ai.captionsFromVideo(await fileInput(o.video), { platforms: o.platforms, language: o.language }));
      if (!o.text) throw new UsageError('Pass --text or --video.');
      show(await c.ai.writeCaptions({ text: o.text, platforms: o.platforms, language: o.language, kind: 'text' }));
    });

  // ─── webhooks and raw API ─────────────────────────────────────────────────────────────────────

  const webhook = program.command('webhook').description('Where Reelspan sends post results');
  webhook.command('get', { isDefault: true }).action(async () => show(await client().webhooks.get()));
  webhook
    .command('set <url>')
    .option('--events <list>', 'only these events', list)
    .action(async (url: string, o: { events?: string[] }) => show(await client().webhooks.set(url, o.events)));
  webhook.command('test').action(async () => show(await client().webhooks.test()));

  program
    .command('api <method> <path>')
    .description('Any endpoint, e.g. `reelspan api GET /v1/me` or `reelspan api POST /v1/profiles -d \'{"username":"x"}\'`')
    .option('-d, --data <json>', 'JSON body')
    .option('-q, --query <key=value>', 'query parameter, repeatable', collect)
    .action(async (method: string, path: string, o: { data?: string; query?: string[] }) => {
      let json: unknown;
      if (o.data !== undefined) {
        try {
          json = JSON.parse(o.data === '-' ? await readStdin() : o.data);
        } catch {
          throw new UsageError('--data is not valid JSON.');
        }
      }
      const query = parseExtra(o.query) as Record<string, string>;
      io.out(JSON.stringify(await client().request(method.toUpperCase(), path.startsWith('/') ? path : `/${path}`, { json, query }), null, 2));
    });

  return { program, exitCode: () => exitCode };
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

/** Runs the CLI and returns the exit code (no process.exit, so tests can call it). */
export async function run(argv: string[], io: Io): Promise<number> {
  const { program, exitCode } = buildProgram(io);
  try {
    await program.parseAsync(argv, { from: 'user' });
    return exitCode();
  } catch (err) {
    const e = err as Error & { code?: string; exitCode?: number };
    if (e.code === 'commander.helpDisplayed' || e.code === 'commander.version' || e.code === 'commander.help') return EXIT.ok;
    if (e.code?.startsWith('commander.')) return EXIT.usage;
    const json = argv.includes('--json');
    if (err instanceof UsageError) {
      io.err(json ? JSON.stringify({ error: { type: 'usage', message: e.message } }) : e.message);
      return EXIT.usage;
    }
    if (err instanceof ReelspanError) {
      io.err(json ? JSON.stringify({ error: { type: 'api', status: err.status, code: err.code, message: err.message, body: err.body } }) : `Error ${err.status}${err.code ? ` ${err.code}` : ''}: ${err.message}${err.status === 401 ? '\nRun `reelspan login` with a valid key.' : ''}`);
      return EXIT.error;
    }
    if (err instanceof ReelspanConnectionError) {
      io.err(json ? JSON.stringify({ error: { type: 'network', message: e.message } }) : e.message);
      return EXIT.error;
    }
    io.err(json ? JSON.stringify({ error: { type: 'internal', message: e.message } }) : `Unexpected error: ${e.stack ?? e.message}`);
    return EXIT.error;
  }
}

// Runs commands against a local stand-in for the API (no network) and checks what is sent, printed and returned.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, parseExtra, EXIT } from '../dist/cli.js';

const seen = [];
let server, base;
const dir = mkdtempSync(join(tmpdir(), 'reelspan-cli-'));

before(async () => {
  server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks).toString('latin1');
    seen.push({ method: req.method, url: req.url, headers: req.headers, body });
    const reply = (status, json) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
    if (req.headers.authorization !== 'Bearer rs_test_key') return reply(401, { success: false, message: 'Invalid API key', error_code: 'UNAUTHORIZED' });
    const path = req.url.split('?')[0];
    if (path === '/v1/me') return reply(200, { email: 'me@example.com', plan: 'pro' });
    if (path === '/v1/profiles' && req.method === 'GET') return reply(200, { profiles: [{ username: 'brand', display_name: 'Brand', social_accounts: { tiktok: { handle: 'b' }, x: '' } }], limit: 5, plan: 'pro' });
    if (path === '/v1/posts/text') return reply(200, { success: true, request_id: 'req_1', results: { x: { success: true, url: 'https://x.com/b/1' }, bluesky: { success: false, error: 'Too long', error_code: 'TEXT_TOO_LONG' } } });
    if (path === '/v1/posts/video') return reply(202, { success: true, job_id: 'job_9', scheduled_date: '2026-12-01T09:00:00Z' });
    if (path === '/v1/posts/status') return reply(200, { status: 'completed', results: [{ platform: 'tiktok', success: true, url: 'https://tiktok.com/v/1' }] });
    return reply(200, { ok: true, path });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

async function cli(args, env = {}) {
  const out = [];
  const err = [];
  const code = await run(args, { out: (s) => out.push(s), err: (s) => err.push(s), env: { REELSPAN_BASE_URL: base, REELSPAN_CONFIG_DIR: dir, ...env } });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
const KEY = { REELSPAN_API_KEY: 'rs_test_key' };

test('login checks the key, saves it, and later commands use it', async () => {
  const r = await cli(['login', '--key', 'rs_test_key']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Logged in as me@example.com \(pro plan\)/);
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).apiKey, 'rs_test_key');
  const w = await cli(['whoami']);
  assert.equal(JSON.parse(w.out).email, 'me@example.com');
  assert.equal((await cli(['logout'])).code, 0);
  assert.equal(existsSync(join(dir, 'config.json')), false);
});

test('a refused key exits 1 with a hint', async () => {
  const r = await cli(['whoami'], { REELSPAN_API_KEY: 'bad' });
  assert.equal(r.code, EXIT.error);
  assert.match(r.err, /401 UNAUTHORIZED: Invalid API key[\s\S]*reelspan login/);
});

test('no key is a usage error', async () => {
  const r = await cli(['whoami']);
  assert.equal(r.code, EXIT.usage);
  assert.match(r.err, /No API key/);
});

test('profiles table', async () => {
  const r = await cli(['profiles'], KEY);
  assert.equal(r.code, 0);
  assert.match(r.out, /USERNAME\s+NAME\s+NETWORKS/);
  assert.match(r.out, /brand\s+Brand\s+tiktok$/m);
});

test('post text: fields sent, results printed, partial failure exits 3', async () => {
  const r = await cli(['post', 'text', 'Hello world', '--to', 'x,bluesky', '-p', 'brand', '--first-comment', 'link below', '-o', 'x_reply_settings=following', '--idempotency-key', 'abc'], KEY);
  assert.equal(r.code, EXIT.partial);
  assert.match(r.out, /✓ x {2}https:\/\/x.com\/b\/1/);
  assert.match(r.out, /✗ bluesky {2}Too long \(TEXT_TOO_LONG\)/);
  const sent = seen.findLast((s) => s.url === '/v1/posts/text');
  assert.equal(sent.headers['idempotency-key'], 'abc');
  assert.match(sent.headers['x-reelspan-client'], /^cli\//);
  const body = JSON.parse(sent.body);
  assert.deepEqual(body.platform, ['x', 'bluesky']);
  assert.equal(body.title, 'Hello world');
  assert.equal(body.user, 'brand');
  assert.equal(body.first_comment, 'link below');
  assert.equal(body.x_reply_settings, 'following');
});

test('post video from a file, scheduled', async () => {
  const file = join(dir, 'clip.mp4');
  writeFileSync(file, 'fake-video-bytes');
  const r = await cli(['post', 'video', file, '--to', 'tiktok', '-p', 'brand', '--title', 'Launch', '--schedule', '2026-12-01T09:00:00Z'], KEY);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Scheduled for 2026-12-01T09:00:00Z\. job_id job_9/);
  const sent = seen.findLast((s) => s.url === '/v1/posts/video');
  assert.match(sent.headers['content-type'], /multipart\/form-data/);
  assert.match(sent.body, /filename="clip.mp4"/);
  assert.match(sent.body, /Content-Type: video\/mp4/);
  assert.match(sent.body, /name="scheduled_date"\r\n\r\n2026-12-01T09:00:00Z/);
  assert.match(sent.body, /fake-video-bytes/);
});

test('dry run sends nothing; JSON output parses', async () => {
  const before = seen.length;
  const r = await cli(['--json', 'post', 'text', 'hi', '--to', 'x', '-p', 'brand', '--dry-run'], KEY);
  assert.equal(r.code, 0);
  assert.equal(seen.length, before);
  const j = JSON.parse(r.out);
  assert.equal(j.dry_run, true);
  assert.deepEqual(j.platforms, ['x']);
});

test('missing file and missing profile are usage errors', async () => {
  assert.equal((await cli(['post', 'video', 'nope.mp4', '--to', 'tiktok', '-p', 'b'], KEY)).code, EXIT.usage);
  const r = await cli(['--json', 'post', 'text', 'hi', '--to', 'x'], KEY);
  assert.equal(r.code, EXIT.usage);
  assert.equal(JSON.parse(r.err).error.type, 'usage');
});

test('status prints each network', async () => {
  const r = await cli(['status', 'req_1'], KEY);
  assert.equal(r.code, 0);
  assert.match(r.out, /Status: completed\n✓ tiktok {2}https:\/\/tiktok.com\/v\/1/);
});

test('raw api command', async () => {
  const r = await cli(['api', 'post', 'v1/anything', '-d', '{"a":1}', '-q', 'x=y'], KEY);
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).path, '/v1/anything');
  const sent = seen.at(-1);
  assert.equal(sent.method, 'POST');
  assert.equal(sent.url, '/v1/anything?x=y');
  assert.deepEqual(JSON.parse(sent.body), { a: 1 });
});

test('-o pairs', () => {
  assert.deepEqual(parseExtra(['a=1', 'b[]=x', 'b[]=y', 'c=1=2']), { a: '1', 'b[]': ['x', 'y'], c: '1=2' });
  assert.throws(() => parseExtra(['oops']), /key=value/);
});

test('unknown command exits 2', async () => {
  assert.equal((await cli(['frobnicate'], KEY)).code, EXIT.usage);
});

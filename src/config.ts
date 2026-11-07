// Where `reelspan login` keeps the API key: a JSON file only the user can read.
import { mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type Config = { apiKey?: string; baseUrl?: string; profile?: string };

export function configDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.REELSPAN_CONFIG_DIR) return env.REELSPAN_CONFIG_DIR;
  if (process.platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'reelspan');
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'reelspan');
}

export const configPath = (env?: NodeJS.ProcessEnv) => join(configDir(env), 'config.json');

export function readConfig(env?: NodeJS.ProcessEnv): Config {
  try {
    return JSON.parse(readFileSync(configPath(env), 'utf8')) as Config;
  } catch {
    return {};
  }
}

export function writeConfig(cfg: Config, env?: NodeJS.ProcessEnv) {
  mkdirSync(configDir(env), { recursive: true, mode: 0o700 });
  writeFileSync(configPath(env), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  try {
    chmodSync(configPath(env), 0o600);
  } catch {
    // Windows: the file sits in the user's own profile folder
  }
}

export function clearConfig(env?: NodeJS.ProcessEnv) {
  rmSync(configPath(env), { force: true });
}

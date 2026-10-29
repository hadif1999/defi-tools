import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { CHAINS, DEXES, POOL_SORTS, POOL_VERSIONS, isEvmChain, type AppConfig, type ChainId, type Dex, type PoolSort, type PoolVersion } from './types.js';

export const DEFAULT_API_URL = 'https://interface.gateway.uniswap.org/v1/graphql';
export const DEFAULT_CONFIG_PATH = join(homedir(), '.config', 'defi-tool', 'config.json');
export const DEFAULT_DATABASE_PATH = join(homedir(), '.local', 'share', 'defi-tool', 'state.db');

const configSchema = z.object({
  apiUrl: z.string().url().default(DEFAULT_API_URL),
  apiKey: z.string().min(1).optional(),
  rpcUrls: z.record(z.string().url()).default({}),
  chains: z.array(z.coerce.number().int()).nonempty().refine((chains) => chains.every((chain) => chain in CHAINS), 'chains contains an unsupported chain; run defi-tool chains').default([1, 10, 137, 8453, 42161]), // The original networks; --chain all adds the rest.
  wallets: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'Wallet must be a 0x address with 40 hexadecimal characters')).default([]),
  databasePath: z.string().min(1).default(DEFAULT_DATABASE_PATH),
  saturationThresholdPct: z.number().min(0).max(0.5).default(0.1),
  dataTtlSeconds: z.number().int().positive().default(60),
});

function envConfig(): Partial<AppConfig> {
  const rpcUrls: Partial<Record<ChainId, string>> = {};
  for (const chain of (Object.keys(CHAINS).map(Number) as ChainId[]).filter(isEvmChain)) {
    const value = process.env[`RPC_URL_${CHAINS[chain].slug.toUpperCase()}`] ?? process.env[`RPC_URL_${chain}`];
    if (value) rpcUrls[chain] = value;
  }
  const result: Partial<AppConfig> = { rpcUrls };
  if (process.env.UNISWAP_API_URL) result.apiUrl = process.env.UNISWAP_API_URL;
  if (process.env.UNISWAP_API_KEY) result.apiKey = process.env.UNISWAP_API_KEY;
  if (process.env.DEFI_TOOL_WALLETS) result.wallets = process.env.DEFI_TOOL_WALLETS.split(',').map((x) => x.trim()).filter(Boolean);
  if (process.env.DEFI_TOOL_DB_PATH) result.databasePath = process.env.DEFI_TOOL_DB_PATH;
  return result;
}

export async function loadConfig(path = process.env.DEFI_TOOL_CONFIG ?? DEFAULT_CONFIG_PATH): Promise<AppConfig> {
  let file: Record<string, unknown> = {};
  try {
    file = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const env = envConfig();
  const merged = { ...file, ...env, rpcUrls: { ...(file.rpcUrls as object ?? {}), ...(env.rpcUrls ?? {}) } };
  return configSchema.parse(merged) as AppConfig;
}

export async function saveConfig(config: AppConfig, path = process.env.DEFI_TOOL_CONFIG ?? DEFAULT_CONFIG_PATH, overwrite = false): Promise<void> {
  const validated = configSchema.parse(config);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, flag: overwrite ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Configuration already exists at ${path}. Use init --force to replace it, or edit that file.`);
    throw error;
  }
  await chmod(path, 0o600);
}

export function parseChains(value?: string): ChainId[] | undefined {
  if (value === undefined) return undefined;
  const names = value.toLowerCase().split(',').map((item) => item.trim());
  const entries = Object.entries(CHAINS);
  if (names.some((name) => !name)) throw new Error(`Chain "(empty)" is not supported. Choose ${Object.values(CHAINS).map((chain) => chain.slug).join(', ')}, or all. Run defi-tool chains for aliases.`);
  // "all" covers every network, so other names next to it (all,solana) add nothing.
  if (names.includes('all')) return entries.map(([id]) => Number(id) as ChainId);
  // A name is an ID, a slug, an alias, or the full name; any start of a name of at least 3 letters also works (sol, sola, solana), but not of an ID.
  const spellings = ([id, chain]: (typeof entries)[number]) => [id, chain.slug, ...chain.aliases, chain.name.toLowerCase().replaceAll(' ', '-')];
  const chains = names.map((name) => {
    const exact = entries.find((entry) => spellings(entry).includes(name));
    const prefixed = name.length >= 3 ? entries.filter((entry) => spellings(entry).slice(1).some((spelling) => spelling.startsWith(name.replaceAll(' ', '-')))) : [];
    if (!exact && prefixed.length > 1) throw new Error(`Chain "${name}" could mean ${prefixed.map(([, chain]) => chain.slug).join(' or ')}; type more letters.`);
    const entry = exact ?? prefixed[0];
    if (!entry) throw new Error(`Chain "${name}" is not supported. Choose ${Object.values(CHAINS).map((chain) => chain.slug).join(', ')}, or all (names can be shortened to 3+ letters, e.g. sol). Run defi-tool chains for aliases.`);
    return Number(entry[0]) as ChainId;
  });
  return [...new Set(chains)];
}

export function parseWallets(value: string): string[] {
  if (!value.trim()) return [];
  const wallets = value.split(',').map((wallet) => wallet.trim());
  for (const wallet of wallets) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error('Wallet must be a 0x address with 40 hexadecimal characters. Pass --wallet 0xYourAddress or run defi-tool init.');
  }
  return [...new Set(wallets.map((wallet) => wallet.toLowerCase()))];
}

export function parsePositiveInt(value: string | undefined, optionName: string): number | undefined {
  if (value == null) return undefined;
  if (!/^\d+$/.test(value)) throw new Error(`${optionName} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${optionName} must be a positive integer`);
  return parsed;
}

/** Parse a USD amount such as 50000, 250k, 1.5m, or $2b. */
export function parseUsdAmount(value: string | undefined, optionName: string): number | undefined {
  if (value == null) return undefined;
  const match = /^\$?\s*(\d+(?:\.\d+)?)\s*([kmb])?$/i.exec(value.trim().replaceAll(',', ''));
  if (!match) throw new Error(`${optionName} must be a dollar amount such as 50000, 250k, or 1m`);
  const scale = { '': 1, k: 1e3, m: 1e6, b: 1e9 }[(match[2] ?? '').toLowerCase() as '' | 'k' | 'm' | 'b'];
  return Number(match[1]) * scale;
}

/** Parse a choice in any letter case, e.g. V3, Public. */
export function parseChoice<T extends string>(value: string, choices: readonly T[], optionName: string): T {
  const normalized = value.trim().toLowerCase();
  if (!(choices as readonly string[]).includes(normalized)) throw new Error(`${optionName} "${value}" is not supported. Choose ${choices.join(', ')}.`);
  return normalized as T;
}

/** Parse comma-separated sort keys in any letter case, e.g. TVL,apr. Repeated keys are ignored. */
export function parsePoolSorts(value: string): PoolSort[] {
  const keys = value.split(',').map((key) => key.trim().toLowerCase());
  for (const key of keys) {
    if (!(POOL_SORTS as readonly string[]).includes(key)) throw new Error(`--sort "${key || '(empty)'}" is not a sort key. Use ${POOL_SORTS.join(', ')}, comma-separated, e.g. --sort tvl,apr.`);
  }
  return [...new Set(keys)] as PoolSort[];
}

/** Parse comma-separated pool versions in any letter case, e.g. V3,v2, CLMM (Raydium) or all. Returned in version order. */
export function parsePoolVersions(value: string): PoolVersion[] {
  const names = value.split(',').map((name) => name.trim().toLowerCase());
  if (names.some((name) => !name)) throw new Error(`--protocol "(empty)" is not supported. Use ${POOL_VERSIONS.join(', ')}, comma-separated, or all.`);
  // "all" covers every version, so others next to it (all,v2) add nothing.
  if (names.includes('all')) return [...POOL_VERSIONS];
  for (const name of names) {
    if (!(POOL_VERSIONS as readonly string[]).includes(name)) throw new Error(`--protocol "${name || '(empty)'}" is not supported. Use ${POOL_VERSIONS.join(', ')}, comma-separated, or all.`);
  }
  return POOL_VERSIONS.filter((version) => names.includes(version));
}

/** Parse comma-separated exchanges in any letter case, e.g. Uniswap,curve, pancake (short for pancakeswap) or all. Returned in DEXES order. */
export function parseDexes(value: string): Dex[] {
  const names = value.split(',').map((name) => name.trim().toLowerCase().replace(/^pancake$/, 'pancakeswap'));
  if (names.includes('all')) return [...DEXES];
  for (const name of names) {
    if (!(DEXES as readonly string[]).includes(name)) throw new Error(`--dex "${name || '(empty)'}" is not supported. Use ${DEXES.join(', ')}, comma-separated, or all.`);
  }
  return DEXES.filter((dex) => names.includes(dex));
}

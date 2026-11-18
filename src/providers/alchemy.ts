import type { EvmChainId } from '../types.js';
import { getJson } from './http.js';

/**
 * Alchemy's Transfers API (alchemy_getAssetTransfers) with a free key: every native, ERC-20 and (where Alchemy indexes
 * them) internal transfer into or out of an address, with block times. Public RPCs cannot search history on L2s.
 * https://docs.alchemy.com/reference/alchemy-getassettransfers
 */
export const ALCHEMY_NETWORKS: Partial<Record<EvmChainId, string>> = {
  1: 'eth-mainnet', 10: 'opt-mainnet', 56: 'bnb-mainnet', 137: 'polygon-mainnet', 8453: 'base-mainnet', 42161: 'arb-mainnet',
};
// Internal (contract-to-wallet) ETH transfers are indexed on Ethereum and Polygon only.
const INTERNAL: ReadonlySet<EvmChainId> = new Set([1, 137]);
const PAGE = 1000;
const MAX_PAGES = 5;

/** One asset movement; amount has decimals applied, address is absent for the native coin. */
export interface Transfer { hash: string; timestamp: number; from: string; to: string; symbol: string; address?: string; amount: number }
/** What the transaction cost its sender. */
export interface Receipt { from: string; gasNative: number; failed: boolean }

interface RawTransfer {
  hash?: string; from?: string; to?: string | null; asset?: string | null; value?: number | null; category?: string;
  rawContract?: { value?: string | null; address?: string | null; decimal?: string | null };
  metadata?: { blockTimestamp?: string };
}

export interface AlchemyOptions { apiKey: string; /** Base URL for tests: requests go to `${endpoint}/${network}`. */ endpoint?: string; fetcher?: typeof fetch; retryDelayMs?: number }

export class AlchemyClient {
  constructor(private readonly options: AlchemyOptions) {}

  supports(chainId: EvmChainId): boolean { return chainId in ALCHEMY_NETWORKS; }

  private url(chainId: EvmChainId): string {
    const network = ALCHEMY_NETWORKS[chainId];
    if (!network) throw new Error('Alchemy does not index this network.');
    return this.options.endpoint ? `${this.options.endpoint.replace(/\/$/, '')}/${network}` : `https://${network}.g.alchemy.com/v2/${this.options.apiKey}`;
  }

  private async rpc(chainId: EvmChainId, body: unknown): Promise<unknown> {
    const reply = await getJson(this.options.fetcher ?? fetch, this.url(chainId), 'Alchemy', 30_000, this.options.retryDelayMs, body);
    const error = (Array.isArray(reply) ? reply.find((item) => item?.error) : (reply as { error?: unknown })?.error) as { error?: { message?: string }; message?: string } | undefined;
    const message = error && ('error' in error ? error.error?.message : error.message);
    if (error) throw new Error(`Alchemy: ${message ?? 'request failed'}${/unauthori[sz]ed|api key|must be authenticated/i.test(message ?? '') ? '. Check ALCHEMY_API_KEY.' : ''}`);
    return reply;
  }

  /** Transfers into and out of the address since a time (seconds), newest first. */
  async transfers(address: string, chainId: EvmChainId, since: number): Promise<Transfer[]> {
    const category = ['external', 'erc20', ...(INTERNAL.has(chainId) ? ['internal'] : [])];
    const direction = async (side: 'fromAddress' | 'toAddress'): Promise<Transfer[]> => {
      const found: Transfer[] = [];
      let pageKey: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const reply = await this.rpc(chainId, { jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [{
          fromBlock: '0x0', toBlock: 'latest', [side]: address, category, withMetadata: true, excludeZeroValue: true,
          order: 'desc', maxCount: `0x${PAGE.toString(16)}`, ...(pageKey ? { pageKey } : {}),
        }] }) as { result?: { transfers?: RawTransfer[]; pageKey?: string } };
        const batch = (reply.result?.transfers ?? []).flatMap(toTransfer);
        found.push(...batch.filter((transfer) => transfer.timestamp >= since));
        pageKey = reply.result?.pageKey;
        // Newest first: stop at the first page that reaches back past the window.
        if (!pageKey || batch.some((transfer) => transfer.timestamp < since)) break;
      }
      return found;
    };
    const [sent, received] = await Promise.all([direction('fromAddress'), direction('toAddress')]);
    return [...sent, ...received];
  }

  /** Sender and fee of each transaction (gas used × price, plus the L1 data fee on rollups), in one batch request. */
  async receipts(chainId: EvmChainId, hashes: string[]): Promise<Map<string, Receipt>> {
    const result = new Map<string, Receipt>();
    for (let start = 0; start < hashes.length; start += 100) {
      const chunk = hashes.slice(start, start + 100);
      const reply = await this.rpc(chainId, chunk.map((hash, id) => ({ jsonrpc: '2.0', id, method: 'eth_getTransactionReceipt', params: [hash] }))) as Array<{ id: number; result?: { from?: string; gasUsed?: string; effectiveGasPrice?: string; l1Fee?: string; status?: string } | null }>;
      for (const item of Array.isArray(reply) ? reply : []) {
        const receipt = item.result;
        const hash = chunk[item.id];
        if (!receipt?.from || !receipt.gasUsed || !receipt.effectiveGasPrice || !hash) continue;
        const wei = BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice) + (receipt.l1Fee ? BigInt(receipt.l1Fee) : 0n);
        result.set(hash.toLowerCase(), { from: receipt.from.toLowerCase(), gasNative: Number(wei) / 1e18, failed: receipt.status === '0x0' });
      }
    }
    return result;
  }
}

function toTransfer(raw: RawTransfer): Transfer[] {
  const timestamp = raw.metadata?.blockTimestamp ? Date.parse(raw.metadata.blockTimestamp) / 1000 : NaN;
  if (!raw.hash || !raw.from || !raw.to || !Number.isFinite(timestamp)) return [];
  const contract = raw.category === 'erc20' ? raw.rawContract?.address?.toLowerCase() : undefined;
  // Exact amount from the raw value and decimals when given; Alchemy's value field is a rounded float.
  const decimals = raw.rawContract?.decimal ? Number(BigInt(raw.rawContract.decimal)) : undefined;
  const amount = raw.rawContract?.value && decimals !== undefined ? Number(BigInt(raw.rawContract.value)) / 10 ** decimals : raw.value ?? undefined;
  if (amount === undefined || !(amount > 0)) return [];
  return [{ hash: raw.hash.toLowerCase(), timestamp, from: raw.from.toLowerCase(), to: raw.to.toLowerCase(), symbol: raw.asset || (contract ? `${contract.slice(0, 6)}…` : '?'), address: contract, amount }];
}

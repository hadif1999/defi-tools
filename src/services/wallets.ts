import { parseChains, parseWallets } from '../config.js';
import type { Store } from '../storage.js';
import type { WalletGroup } from '../positions.js';
import { CHAINS, isEvmChain, type AppConfig, type ChainId, type EvmChainId, type SavedWallet } from '../types.js';

// Wallet resolution shared by the CLI and the dashboard: which addresses and networks a --wallet / --wallet-addr value
// means, the default wallet, and the validation rules for saving wallets. Nothing here prints; notes go to `report`.

export type Report = (message: string) => void;

/** Whether a --wallet value asks for every saved wallet: "all", alone or in a list (all,main). */
export const ALL_WALLETS = 'all';
export const meansAll = (value: string | undefined): boolean => value !== undefined && value.split(',').some((item) => item.trim().toLowerCase() === ALL_WALLETS);

/** 0x902e…3f00. */
export function shortAddress(address: string): string { return `${address.slice(0, 6)}…${address.slice(-4)}`; }

export const EVM_CHAINS = (Object.keys(CHAINS).map(Number) as ChainId[]).filter(isEvmChain);

/**
 * The default wallet for a command run without --wallet: the one set with wallet set-default, else the most recently
 * added. Says which through `report` (when given), since results depend on it.
 */
export function defaultWallet(store: Store, report?: Report): SavedWallet | undefined {
  const found = store.defaultWallet();
  if (found && report) {
    report(`Using the default wallet ${found.wallet.name} (${shortAddress(found.wallet.address)})${found.chosen ? '' : ', the latest added'}; pass --wallet to choose another, or set one with defi-tool wallet set-default.`);
  }
  return found?.wallet;
}

export interface ResolveOptions {
  /** Notes such as skipped Solana wallets; always reported. */
  report: Report;
  /** Leave out the "Using the default wallet" note (JSON output, the dashboard). */
  quiet?: boolean;
}

/**
 * The wallet/network pairs to check. Saved EVM wallets and addresses are read on --chain, or on the saved networks (a
 * saved wallet's own network included); a Solana wallet stays on Solana. Without --wallet the default wallet is used
 * (see wallet set-default), or the addresses saved by init when no wallet is saved; --wallet all checks every wallet.
 */
export function walletTargets(value: string | undefined, chains: ChainId[] | undefined, config: AppConfig, store: Store, options: ResolveOptions): Array<{ address: string; chainId: ChainId }> {
  const targets: Array<{ address: string; chainId: ChainId }> = [];
  const add = (address: string, networks: ChainId[]) => {
    for (const chainId of networks) if (!targets.some((target) => target.address === address && target.chainId === chainId)) targets.push({ address, chainId });
  };
  const addSaved = (wallet: SavedWallet) => add(wallet.address, !isEvmChain(wallet.chainId) ? [wallet.chainId] : chains ?? [...new Set([wallet.chainId, ...config.chains.filter(isEvmChain)])]);
  const addInit = () => { for (const address of parseWallets(config.wallets.join(','))) add(address, chains ?? config.chains); };
  if (value === undefined) {
    const saved = defaultWallet(store, options.quiet ? undefined : options.report);
    if (saved) addSaved(saved);
    else addInit();
    return targets;
  }
  if (meansAll(value)) {
    store.wallets().forEach(addSaved);
    addInit();
    return targets;
  }
  for (const entry of value.split(',').map((item) => item.trim()).filter(Boolean)) {
    const saved = store.wallet(entry);
    if (saved) addSaved(saved);
    else if (/^0x[0-9a-fA-F]{40}$/.test(entry)) add(entry.toLowerCase(), chains ?? config.chains);
    else throw new Error(`--wallet "${entry}" is neither a saved wallet name nor a 0x address with 40 hexadecimal characters. Run defi-tool wallet list to see saved names, or use --wallet all.`);
  }
  return targets;
}

/**
 * Addresses and networks for positions list and detail. A saved EVM wallet is read on every EVM network (an address is
 * the same account everywhere, and Revert answers for all of them at once), as are --wallet-addr addresses; --chain
 * narrows both. Without either option the default wallet is read (see wallet set-default), or the addresses saved by
 * init when no wallet is saved; --wallet all reads every saved wallet. Wallets sharing an address are read together.
 */
export function walletGroups(names: string | undefined, addresses: string | undefined, chains: ChainId[] | undefined, config: AppConfig, store: Store, options: ResolveOptions): WalletGroup[] {
  const groups = new Map<string, WalletGroup>();
  const narrow = (networks: ChainId[]) => networks.filter((chain): chain is EvmChainId => isEvmChain(chain) && (!chains || chains.includes(chain)));
  const add = (address: string, networks: EvmChainId[], name?: string) => {
    const group = groups.get(address) ?? { address, chains: [], names: {} };
    for (const chain of networks) {
      if (!group.chains.includes(chain)) group.chains.push(chain);
      if (name) group.names![chain] = name;
    }
    if (group.chains.length) groups.set(address, group);
  };
  const split = (value: string) => value.split(',').map((item) => item.trim()).filter(Boolean);
  const skipped: string[] = [];
  const addSaved = (saved: SavedWallet) => {
    if (!isEvmChain(saved.chainId)) return skipped.push(`${saved.name} (Solana)`);
    add(saved.address, narrow(EVM_CHAINS), saved.name);
  };
  const addInit = () => { for (const address of parseWallets(config.wallets.join(','))) add(address, narrow(config.chains)); };
  if (meansAll(names)) {
    store.wallets().forEach(addSaved);
    addInit();
  } else if (names !== undefined) {
    for (const name of split(names)) {
      const saved = store.wallet(name);
      if (!saved) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets, use --wallet all, or --wallet-addr for an address.`);
      addSaved(saved);
    }
  }
  if (addresses !== undefined) {
    for (const address of split(addresses)) {
      if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`--wallet-addr "${address}" is not a 0x address with 40 hexadecimal characters. Uniswap positions are on EVM networks; Solana addresses are not supported.`);
      add(address.toLowerCase(), narrow(EVM_CHAINS));
    }
  }
  if (names === undefined && addresses === undefined) {
    const saved = defaultWallet(store, options.quiet ? undefined : options.report);
    if (saved && !isEvmChain(saved.chainId)) throw new Error(`The default wallet ${saved.name} is a Solana wallet; Uniswap positions are on EVM networks. Pass --wallet or --wallet-addr, or set an EVM default with defi-tool wallet set-default.`);
    if (saved) addSaved(saved);
    else addInit();
  }
  if (skipped.length) options.report(`Note: skipping ${skipped.join(', ')}; Uniswap positions are read on EVM networks.`);
  return [...groups.values()];
}

/** "main, ledger (0x902e…3f00) on all networks". */
export function groupLabel(group: WalletGroup): string {
  const names = [...new Set(Object.values(group.names ?? {}))];
  const networks = group.chains.length === EVM_CHAINS.length ? 'all networks' : group.chains.map((chain) => CHAINS[chain].name).join(', ');
  return `${names.length ? `${names.join(', ')} (${shortAddress(group.address)})` : shortAddress(group.address)} on ${networks}`;
}

/** A wallet belongs to exactly one network. */
export function parseWalletChain(value: string): ChainId {
  const chains = parseChains(value)!;
  if (chains.length !== 1) throw new Error('--chain takes one network for a wallet, e.g. --chain eth. Save an EVM address once per network to use it on several.');
  return chains[0]!;
}

/** 0x addresses on EVM networks (stored lowercase), base58 addresses on Solana (case kept). */
export function parseWalletAddress(value: string, chainId: ChainId): string {
  const address = value.trim();
  const evm = /^0x[0-9a-fA-F]{40}$/.test(address);
  const solana = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address);
  if (isEvmChain(chainId) && evm) return address.toLowerCase();
  if (!isEvmChain(chainId) && solana) return address;
  const network = CHAINS[chainId].name;
  if (isEvmChain(chainId)) throw new Error(`"${address}" is not a valid ${network} address: use 0x followed by 40 hexadecimal characters.${solana ? ' It looks like a Solana address; use --chain sol.' : ''}`);
  throw new Error(`"${address}" is not a valid Solana address: use the 32-44 character base58 address.${evm ? ' It looks like an EVM address; use an EVM --chain such as eth.' : ''}`);
}

/** Names are short, so they can never be mistaken for an address in --wallet. */
export function parseWalletName(value: string): string {
  const name = value.trim();
  if (name.toLowerCase() === ALL_WALLETS) throw new Error('"all" is reserved: --wallet all means every saved wallet. Choose another name.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,29}$/.test(name)) throw new Error(`Wallet name "${value}" is not valid: use 1-30 letters, digits, ".", "_" or "-", starting with a letter or digit, e.g. my-wallet1.`);
  return name;
}

/** Save a wallet (wallet add). Returns it and whether it became the default because it is the latest added. */
export function addWallet(store: Store, input: { address: string; chain: string; name?: string }): { wallet: SavedWallet; isDefault: boolean } {
  const chainId = parseWalletChain(input.chain);
  const name = input.name === undefined || input.name.trim() === '' ? store.nextWalletName() : parseWalletName(input.name);
  const wallet = store.addWallet({ name, address: parseWalletAddress(input.address, chainId), chainId });
  return { wallet, isDefault: store.defaultWallet()?.wallet.name === wallet.name };
}

/** Rename a wallet or move it to another network (wallet edit). Returns the wallet before and after. */
export function editWallet(store: Store, name: string, changes: { name?: string; chain?: string }): { before: SavedWallet; after: SavedWallet } {
  if (changes.name === undefined && changes.chain === undefined) throw new Error('Nothing to change: pass --name <new-name>, --chain <network>, or both.');
  const before = store.wallet(name);
  if (!before) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets.`);
  const chainId = changes.chain === undefined ? undefined : parseWalletChain(changes.chain);
  if (chainId !== undefined) parseWalletAddress(before.address, chainId);
  const after = store.updateWallet(before.name, { name: changes.name === undefined ? undefined : parseWalletName(changes.name), chainId });
  return { before, after };
}

/** Delete a wallet by name (wallet delete); returns what was removed. */
export function deleteWallet(store: Store, name: string): SavedWallet {
  const saved = store.wallet(name);
  if (!saved || !store.deleteWallet(saved.name)) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets.`);
  return saved;
}

/** The wallet wallet set-default names: by name, by its number in wallet list, or by address (with chain when ambiguous). */
export function setDefaultWallet(store: Store, target: string, chain?: string): SavedWallet {
  const text = target.trim();
  if (text.toLowerCase() === ALL_WALLETS) throw new Error('The default is one wallet. To read every saved wallet, pass --wallet all to the command instead.');
  const wallets = store.wallets();
  let saved = store.wallet(text);
  if (!saved && /^\d+$/.test(text)) {
    saved = wallets[Number(text) - 1];
    if (!saved) throw new Error(`There is no wallet number ${text}; defi-tool wallet list shows ${wallets.length} wallet${wallets.length === 1 ? '' : 's'}.`);
  }
  if (!saved) {
    const chainId = chain === undefined ? undefined : parseWalletChain(chain);
    const matches = wallets.filter((item) => item.address.toLowerCase() === text.toLowerCase() && (chainId === undefined || item.chainId === chainId));
    if (matches.length > 1) throw new Error(`${text} is saved on ${matches.map((item) => `${CHAINS[item.chainId].name} as ${item.name}`).join(' and ')}; add --chain or use the name.`);
    saved = matches[0];
  }
  if (!saved) throw new Error(`No saved wallet "${text}". Use a name, number or address from defi-tool wallet list.`);
  store.setDefaultWallet(saved.name);
  return saved;
}

/**
 * The wallets wallet history reads: one (named, an address, or the default), or every saved EVM wallet for "all".
 * Wallets sharing an address are read together, on all their networks.
 */
export function historyTargets(target: string | undefined, requested: ChainId[] | undefined, store: Store, options: ResolveOptions): { several: boolean; targets: Array<{ names: string[]; address: string; chains: EvmChainId[] }> } {
  const targets: Array<{ names: string[]; address: string; chains: EvmChainId[] }> = [];
  const addTarget = (address: string, chains: ChainId[], name?: string) => {
    const evmChains = chains.filter(isEvmChain);
    const found = targets.find((item) => item.address === address);
    if (found) { found.chains = [...new Set([...found.chains, ...evmChains])]; if (name) found.names.push(name); } else targets.push({ names: name ? [name] : [], address, chains: evmChains });
  };
  const several = target !== undefined && target.trim().toLowerCase() === ALL_WALLETS;
  if (several) {
    const wallets = store.wallets();
    const solana = wallets.filter((item) => !isEvmChain(item.chainId));
    for (const item of wallets.filter((entry) => isEvmChain(entry.chainId))) addTarget(item.address, requested ?? [item.chainId], item.name);
    if (solana.length && !options.quiet) options.report(`Note: skipping ${solana.map((item) => item.name).join(', ')} (Solana); history covers EVM networks.`);
    if (!targets.length) throw new Error('No saved EVM wallets. Save one with defi-tool wallet add 0xYourWallet --chain eth.');
  } else {
    const saved = target === undefined ? defaultWallet(store, options.quiet ? undefined : options.report) : store.wallet(target);
    if (target === undefined && !saved) throw new Error('No saved wallets. Name a 0x address, e.g. defi-tool wallet history 0xYourWallet, or save one with defi-tool wallet add.');
    if (saved && !isEvmChain(saved.chainId)) throw new Error(`"${saved.name}" is a Solana wallet; history covers EVM networks.`);
    const address = saved?.address ?? target!.trim().toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(address)) throw new Error(`"${target}" is neither a saved wallet name nor a 0x address. Run defi-tool wallet list to see saved names, or use all.`);
    addTarget(address, requested ?? (saved ? [saved.chainId] : EVM_CHAINS), saved?.name);
  }
  if (targets.some((item) => !item.chains.length)) throw new Error('History covers EVM networks; choose one with --chain, e.g. --chain base.');
  return { several, targets };
}

/** The address positions create plans for: a saved wallet name, a 0x address, or the default wallet. */
export function planWallet(store: Store, value: string | undefined, options: ResolveOptions): string {
  if (meansAll(value)) throw new Error('positions create plans one position for one wallet; --wallet all is not allowed. Name a saved wallet or a 0x address.');
  const saved = value === undefined ? defaultWallet(store, options.quiet ? undefined : options.report) : store.wallet(value);
  if (value === undefined && !saved) throw new Error('No wallet to plan for: pass --wallet 0xYourWallet, or save one with defi-tool wallet add 0xYourWallet --chain base.');
  if (saved && !isEvmChain(saved.chainId)) throw new Error(`Saved wallet "${saved.name}" is a Solana wallet; positions are on EVM networks. Pass --wallet${value === undefined ? ', or set an EVM default with defi-tool wallet set-default' : ''}.`);
  const wallet = saved?.address ?? value!.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) throw new Error(`--wallet "${value}" is neither a saved wallet name nor a 0x address.`);
  return wallet;
}

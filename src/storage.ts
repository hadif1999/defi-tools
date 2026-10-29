import { DatabaseSync } from 'node:sqlite';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { Alert, ChainId, Pool, Position, PositionAnalysis, SavedWallet } from './types.js';

export interface PoolIdentity { address?: string; createdAt?: string; checkedAt: string }

/** A saved wallet with what the database knows about it: positions found by earlier checks and when it was last checked. */
export interface WalletSummary extends SavedWallet { positions: number; lastCheckedAt?: string }

type WalletRow = { name: string; address: string; chain_id: number; created_at: string; updated_at: string };
const toWallet = (row: WalletRow): SavedWallet => ({ name: row.name, address: row.address, chainId: row.chain_id as ChainId, createdAt: row.created_at, updatedAt: row.updated_at });

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS pools (
        id TEXT PRIMARY KEY, chain_id INTEGER NOT NULL, protocol TEXT NOT NULL,
        payload TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pool_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, pool_id TEXT NOT NULL,
        payload TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS positions (
        id TEXT PRIMARY KEY, wallet TEXT NOT NULL, chain_id INTEGER NOT NULL,
        protocol TEXT NOT NULL, payload TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS position_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT, position_id TEXT NOT NULL,
        payload TEXT NOT NULL, observed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS alerts (
        fingerprint TEXT PRIMARY KEY, type TEXT NOT NULL, wallet TEXT NOT NULL,
        position_id TEXT NOT NULL, message TEXT NOT NULL, created_at TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS pool_identities (
        key TEXT PRIMARY KEY, address TEXT, created_at TEXT, checked_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS wallets (
        name TEXT PRIMARY KEY COLLATE NOCASE, address TEXT NOT NULL, chain_id INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, checked_at TEXT, UNIQUE(address, chain_id)
      );
      CREATE TABLE IF NOT EXISTS scan_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, command TEXT NOT NULL,
        started_at TEXT NOT NULL, completed_at TEXT, warnings TEXT NOT NULL DEFAULT '[]'
      );
    `);
  }

  savePools(pools: Pool[]): void {
    const insert = this.db.prepare(`INSERT INTO pools(id, chain_id, protocol, payload, observed_at)
      VALUES(@id, @chainId, @protocol, @payload, @observedAt)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, observed_at=excluded.observed_at`);
    const snapshot = this.db.prepare('INSERT INTO pool_snapshots(pool_id, payload, observed_at) VALUES(?, ?, ?)');
    const tx = (items: Pool[]) => {
      for (const pool of items) {
        const key = `${pool.chainId}:${pool.protocol}:${pool.id.toLowerCase()}`;
        insert.run({ id: key, chainId: pool.chainId, protocol: pool.protocol, payload: JSON.stringify(pool), observedAt: pool.observedAt });
        snapshot.run(key, JSON.stringify(pool), pool.observedAt);
      }
    };
    tx(pools);
  }

  savePositions(positions: Position[], observedAt = new Date().toISOString()): void {
    const insert = this.db.prepare(`INSERT INTO positions(id, wallet, chain_id, protocol, payload, observed_at)
      VALUES(@id, @wallet, @chainId, @protocol, @payload, @observedAt)
      ON CONFLICT(id) DO UPDATE SET payload=excluded.payload, observed_at=excluded.observed_at`);
    const snapshot = this.db.prepare('INSERT INTO position_snapshots(position_id, payload, observed_at) VALUES(?, ?, ?)');
    const tx = (items: Position[]) => {
      for (const position of items) {
        const key = `${position.chainId}:${position.protocol}:${position.id}`;
        insert.run({ id: key, wallet: position.wallet, chainId: position.chainId, protocol: position.protocol, payload: JSON.stringify(position), observedAt });
        snapshot.run(key, JSON.stringify(position), observedAt);
      }
    };
    tx(positions);
  }

  hasAlert(fingerprint: string): boolean {
    return Boolean(this.db.prepare('SELECT 1 FROM alerts WHERE fingerprint=?').get(fingerprint));
  }

  saveAlert(alert: Alert): void {
    this.db.prepare(`INSERT OR IGNORE INTO alerts(fingerprint, type, wallet, position_id, message, created_at, acknowledged)
      VALUES(?, ?, ?, ?, ?, ?, ?)`).run(alert.fingerprint, alert.type, alert.wallet, alert.positionId, alert.message, alert.createdAt, alert.acknowledged ? 1 : 0);
  }

  /** Remembered pool addresses and creation times, keyed by chain:version:pool. */
  poolIdentities(keys: string[]): Map<string, PoolIdentity> {
    const select = this.db.prepare('SELECT address, created_at, checked_at FROM pool_identities WHERE key=?');
    const result = new Map<string, PoolIdentity>();
    for (const key of new Set(keys)) {
      const row = select.get(key) as { address: string | null; created_at: string | null; checked_at: string } | undefined;
      if (row) result.set(key, { address: row.address ?? undefined, createdAt: row.created_at ?? undefined, checkedAt: row.checked_at });
    }
    return result;
  }

  /** Save what is known about a pool. An empty address records a failed lookup; a known creation time is never erased. */
  savePoolIdentity(key: string, address: string | undefined, createdAt: string | undefined, checkedAt = new Date().toISOString()): void {
    this.db.prepare(`INSERT INTO pool_identities(key, address, created_at, checked_at) VALUES(?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET address=COALESCE(excluded.address, pool_identities.address),
        created_at=COALESCE(excluded.created_at, pool_identities.created_at), checked_at=excluded.checked_at`)
      .run(key, address ?? null, createdAt ?? null, checkedAt);
  }

  /** Save a wallet. Names are unique in any letter case; an address can be saved once per network. */
  addWallet(wallet: Pick<SavedWallet, 'name' | 'address' | 'chainId'>, now = new Date().toISOString()): SavedWallet {
    this.assertWalletFree(wallet);
    this.db.prepare('INSERT INTO wallets(name, address, chain_id, created_at, updated_at) VALUES(?, ?, ?, ?, ?)').run(wallet.name, wallet.address, wallet.chainId, now, now);
    return this.wallet(wallet.name)!;
  }

  /** A saved wallet by name, in any letter case. */
  wallet(name: string): SavedWallet | undefined {
    const row = this.db.prepare('SELECT * FROM wallets WHERE name=?').get(name) as WalletRow | undefined;
    return row && toWallet(row);
  }

  /** Saved wallets in the order they were added, with their position counts. */
  wallets(): WalletSummary[] {
    const rows = this.db.prepare(`SELECT w.*, COUNT(p.id) AS positions, w.checked_at AS last_checked_at FROM wallets w
      LEFT JOIN positions p ON p.wallet = w.address AND p.chain_id = w.chain_id
      GROUP BY w.name ORDER BY w.created_at, w.rowid`).all() as Array<WalletRow & { positions: number; last_checked_at: string | null }>;
    return rows.map((row) => ({ ...toWallet(row), positions: row.positions, lastCheckedAt: row.last_checked_at ?? undefined }));
  }

  /** The first free default name: wallet0, wallet1, ... */
  nextWalletName(): string {
    for (let index = 0; ; index += 1) if (!this.wallet(`wallet${index}`)) return `wallet${index}`;
  }

  /** Rename a wallet or move it to another network; returns the updated wallet. */
  updateWallet(name: string, changes: Partial<Pick<SavedWallet, 'name' | 'chainId'>>, now = new Date().toISOString()): SavedWallet {
    const current = this.wallet(name);
    if (!current) throw new Error(`No saved wallet named "${name}". Run defi-tool wallet list to see your wallets.`);
    const next = { ...current, name: changes.name ?? current.name, chainId: changes.chainId ?? current.chainId };
    this.assertWalletFree(next, current.name);
    this.db.prepare('UPDATE wallets SET name=?, chain_id=?, updated_at=? WHERE name=?').run(next.name, next.chainId, now, current.name);
    return this.wallet(next.name)!;
  }

  /** Record that positions were read for these saved wallets (address and network). */
  markWalletsChecked(targets: Array<{ address: string; chainId: ChainId }>, now = new Date().toISOString()): void {
    const update = this.db.prepare('UPDATE wallets SET checked_at=? WHERE address=? AND chain_id=?');
    for (const target of targets) update.run(now, target.address, target.chainId);
  }

  /** Remove a saved wallet; its position history stays. Returns false when no wallet has that name. */
  deleteWallet(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM wallets WHERE name=?').run(name).changes) > 0;
  }

  private assertWalletFree(wallet: Pick<SavedWallet, 'name' | 'address' | 'chainId'>, except?: string): void {
    const named = this.wallet(wallet.name);
    if (named && named.name !== except) throw new Error(`A wallet named "${named.name}" already exists. Choose another --name.`);
    const same = this.db.prepare('SELECT name FROM wallets WHERE address=? AND chain_id=?').get(wallet.address, wallet.chainId) as { name: string } | undefined;
    if (same && same.name !== except) throw new Error(`This address is already saved for that network as "${same.name}".`);
  }

  close(): void { this.db.close(); }
}

export function alertFingerprint(analysis: PositionAnalysis, type: Alert['type']): string {
  return `${analysis.chainId}:${analysis.protocol}:${analysis.wallet.toLowerCase()}:${analysis.id}:${type}:${analysis.status}`;
}

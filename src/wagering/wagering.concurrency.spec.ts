import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'crypto';
import { MikroORM } from '@mikro-orm/postgresql';
import config from '../mikro-orm.config';
import { Money } from '../domain/money';
import { WalletsService } from '../wallets/wallets.service';
import { WageringService, SubmitBody } from './wagering.service';

let orm: MikroORM;
let wallets: WalletsService;
let wagering: WageringService;

// Sobe a conexão com o banco real e garante que as tabelas existem
beforeAll(async () => {
  orm = await MikroORM.init({ ...config, allowGlobalContext: true });
  await orm.getMigrator().up();
  wallets = new WalletsService(orm.em);
  wagering = new WageringService(orm.em);
});

afterAll(async () => {
  await orm.close();
});

// Cria uma carteira nova (jogador novo, para um teste não atrapalhar o outro)
async function newWallet(initial: string) {
  const playerId = randomUUID();
  const w = await wallets.create(playerId, { amount: initial, currency: 'BRL' });
  return { walletId: w.id, playerId };
}

// Monta o corpo de uma aposta
function bet(walletId: string, playerId: string, externalId: string, amount: string): SubmitBody {
  return {
    providerId: 'provider-a',
    externalTransactionId: externalId,
    playerId,
    walletId,
    roundId: 'round-1',
    gameId: 'game-1',
    kind: 'BET',
    money: { amount, currency: 'BRL' },
  };
}

// Lê do banco o saldo guardado, o saldo reconstruído pelo ledger e quantos débitos existem
async function inspect(walletId: string) {
  const conn = orm.em.getConnection();
  const [w] = await conn.execute(`SELECT balance FROM wallets WHERE id = ?`, [walletId]);
  const [l] = await conn.execute(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0) AS total,
            COUNT(*) FILTER (WHERE direction = 'DEBIT') AS debits
       FROM wallet_ledger_entries WHERE wallet_id = ?`,
    [walletId],
  );
  return {
    stored: Money.from(String(w.balance), 'BRL').toString(),
    fromLedger: Money.from(String(l.total), 'BRL').toString(),
    debits: Number(l.debits),
  };
}

describe('Concorrência e idempotência (PostgreSQL real)', () => {
  test('duas apostas de 80 disputando saldo de 100: só uma passa', async () => {
    const { walletId, playerId } = await newWallet('100.00');

    const results = await Promise.all([
      wagering.submit(`k-${randomUUID()}`, bet(walletId, playerId, `tx-${randomUUID()}`, '80.00')),
      wagering.submit(`k-${randomUUID()}`, bet(walletId, playerId, `tx-${randomUUID()}`, '80.00')),
    ]);

    const processed = results.filter((r) => r.status === 'PROCESSED');
    const rejected = results.filter((r) => r.status === 'REJECTED');
    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(rejected[0].failureCode).toBe('INSUFFICIENT_FUNDS');

    const s = await inspect(walletId);
    expect(s.stored).toBe('20.00');
    expect(s.debits).toBe(1);
    expect(s.fromLedger).toBe(s.stored); // saldo guardado == saldo do ledger
  }, 20000);

  test('a mesma aposta enviada 50 vezes em paralelo gera um único débito', async () => {
    const { walletId, playerId } = await newWallet('1000.00');
    const key = `k-${randomUUID()}`;
    const body = bet(walletId, playerId, `tx-${randomUUID()}`, '25.00');

    const results = await Promise.all(
      Array.from({ length: 50 }, () => wagering.submit(key, body)),
    );

    expect(results.filter((r) => !r.idempotentReplay).length).toBe(1);
    expect(results.filter((r) => r.idempotentReplay).length).toBe(49);

    const s = await inspect(walletId);
    expect(s.stored).toBe('975.00');
    expect(s.debits).toBe(1);
    expect(s.fromLedger).toBe(s.stored);
  }, 20000);

  test('mesma Idempotency-Key com pedido diferente é conflito, não repetição', async () => {
    const { walletId, playerId } = await newWallet('100.00');
    const key = `k-${randomUUID()}`;
    const externalId = `tx-${randomUUID()}`;

    await wagering.submit(key, bet(walletId, playerId, externalId, '10.00'));

    await expect(
      wagering.submit(key, bet(walletId, playerId, externalId, '99.00')),
    ).rejects.toThrow();

    const s = await inspect(walletId);
    expect(s.stored).toBe('90.00');
    expect(s.fromLedger).toBe(s.stored);
  }, 20000);

  test('carteiras diferentes processam em paralelo sem se atrapalhar', async () => {
    const a = await newWallet('100.00');
    const b = await newWallet('100.00');

    await Promise.all([
      wagering.submit(`k-${randomUUID()}`, bet(a.walletId, a.playerId, `tx-${randomUUID()}`, '80.00')),
      wagering.submit(`k-${randomUUID()}`, bet(b.walletId, b.playerId, `tx-${randomUUID()}`, '80.00')),
    ]);

    expect((await inspect(a.walletId)).stored).toBe('20.00');
    expect((await inspect(b.walletId)).stored).toBe('20.00');
  }, 20000);
});
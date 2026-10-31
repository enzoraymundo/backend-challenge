import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { randomUUID } from 'crypto';
import { DomainError, Money } from '../domain/money';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WalletsService {
  constructor(private readonly em: EntityManager) {}

  async create(playerId: string, initial: { amount: string; currency: string }) {
    if (!UUID_REGEX.test(playerId ?? '')) {
      throw new BadRequestException('playerId deve ser um UUID');
    }

    let money: Money;
    try {
      money = Money.from(initial?.amount, initial?.currency);
    } catch (e) {
      if (e instanceof DomainError) throw new BadRequestException(e.message);
      throw e;
    }

    const walletId = randomUUID();

    try {
      await this.em.transactional(async (tx) => {
        await tx.execute(
          `INSERT INTO wallets (id, player_id, currency, balance) VALUES (?, ?, ?, ?)`,
          [walletId, playerId, money.currency, money.toString()],
        );

        if (!money.isZero()) {
          const transactionId = randomUUID();

          await tx.execute(
            `INSERT INTO wager_transactions
               (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
                wallet_id, player_id, round_id, game_id, kind, amount, currency,
                status, processed_at)
             VALUES (?, 'internal', ?, ?, 'opening', ?, ?, 'opening', 'opening',
                     'OPENING', ?, ?, 'PROCESSED', now())`,
            [
              transactionId,
              walletId,
              `internal:opening:${walletId}`,
              walletId,
              playerId,
              money.toString(),
              money.currency,
            ],
          );

          await tx.execute(
            `INSERT INTO wallet_ledger_entries
               (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
             VALUES (?, ?, ?, 'CREDIT', ?, 0, ?)`,
            [randomUUID(), walletId, transactionId, money.toString(), money.toString()],
          );
        }
      });
    } catch (e) {
      if (e instanceof UniqueConstraintViolationException) {
        throw new ConflictException('Já existe uma wallet para este jogador nesta moeda');
      }
      throw e;
    }

    return { id: walletId, playerId, balance: money.toJSON(), version: 1 };
  }
}
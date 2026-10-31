import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UniqueConstraintViolationException } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import { createHash, randomUUID } from 'crypto';
import { DomainError, Money } from '../domain/money';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type WagerKind = 'BET' | 'WIN' | 'LOSS';

// O que o provedor envia no corpo da requisição
export interface SubmitBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
}

// O mesmo corpo, já validado, com Money de verdade
interface ValidInput extends Omit<SubmitBody, 'kind' | 'money'> {
  kind: WagerKind;
  money: Money;
}

export interface SubmitResult {
  transactionId: string;
  status: 'PROCESSED' | 'REJECTED';
  failureCode?: string;
  balance: { amount: string; currency: string };
  idempotentReplay: boolean;
}

@Injectable()
export class WageringService {
  constructor(private readonly em: EntityManager) {}

  // Ponto de entrada: valida, calcula o hash e processa tudo em UMA transação SQL
  async submit(idempotencyKey: string | undefined, body: SubmitBody): Promise<SubmitResult> {
    if (!idempotencyKey) {
      throw new BadRequestException('O header Idempotency-Key é obrigatório');
    }
    const input = this.validate(body);
    const payloadHash = this.hash(input);

    try {
      return await this.em.transactional((tx) =>
        this.processInTransaction(tx, idempotencyKey, input, payloadHash),
      );
    } catch (e) {
      // Duas requisições diferentes disputando a mesma chave única do banco
      if (e instanceof UniqueConstraintViolationException) {
        throw new ConflictException('Conflito de idempotência: transação já registrada');
      }
      throw e;
    }
  }

  // Confere se o corpo está completo e correto; se não, devolve erro 400
  private validate(body: SubmitBody): ValidInput {
    const required = [
      'providerId', 'externalTransactionId', 'playerId',
      'walletId', 'roundId', 'gameId', 'kind',
    ] as const;
    for (const field of required) {
      if (typeof body?.[field] !== 'string' || body[field].trim() === '') {
        throw new BadRequestException(`Campo obrigatório ausente ou inválido: ${field}`);
      }
    }
    if (!UUID_REGEX.test(body.playerId) || !UUID_REGEX.test(body.walletId)) {
      throw new BadRequestException('playerId e walletId devem ser UUIDs');
    }
    if (!['BET', 'WIN', 'LOSS'].includes(body.kind)) {
      throw new BadRequestException(`kind não suportado: ${body.kind}`);
    }

    let money: Money;
    try {
      money = Money.from(body.money?.amount, body.money?.currency);
    } catch (e) {
      if (e instanceof DomainError) throw new BadRequestException(e.message);
      throw e;
    }
    if (body.kind !== 'LOSS' && money.isZero()) {
      throw new BadRequestException('O valor deve ser maior que zero');
    }

    return { ...body, kind: body.kind as WagerKind, money };
  }

  // "Impressão digital" do pedido. Mesmo pedido = mesmo hash.
  // As chaves ficam em ordem alfabética para o JSON ser sempre igual (JSON canônico).
  private hash(i: ValidInput): string {
    const canonical = JSON.stringify({
      externalTransactionId: i.externalTransactionId,
      gameId: i.gameId,
      kind: i.kind,
      money: { amount: i.money.toString(), currency: i.money.currency },
      playerId: i.playerId,
      providerId: i.providerId,
      roundId: i.roundId,
      walletId: i.walletId,
    });
    return createHash('sha256').update(canonical).digest('hex');
  }

  // Todo o trabalho de verdade. Roda dentro da transação: ou tudo acontece, ou nada.
  private async processInTransaction(
    tx: EntityManager,
    key: string,
    i: ValidInput,
    payloadHash: string,
  ): Promise<SubmitResult> {
    // 1. TRAVA a linha da carteira. Quem chegar depois espera aqui até esta transação terminar.
    const wallets = await tx.execute(
      `SELECT id, player_id, currency, balance FROM wallets WHERE id = ? FOR UPDATE`,
      [i.walletId],
    );
    if (wallets.length === 0) throw new NotFoundException('Wallet não encontrada');
    const wallet = wallets[0];

    // 2. Esta chave já foi usada? Se sim, é repetição (ou conflito, se o pedido mudou)
    const existing = await tx.execute(
      `SELECT t.id, t.status, t.failure_code, t.payload_hash, t.balance_observed,
              w.currency AS wallet_currency
         FROM wager_transactions t
         JOIN wallets w ON w.id = t.wallet_id
        WHERE t.idempotency_key = ?`,
      [key],
    );
    if (existing.length > 0) {
      const t = existing[0];
      if (t.payload_hash !== payloadHash) {
        throw new ConflictException('Esta Idempotency-Key já foi usada com um pedido diferente');
      }
      return {
        transactionId: t.id,
        status: t.status,
        failureCode: t.failure_code ?? undefined,
        balance: Money.from(t.balance_observed, t.wallet_currency).toJSON(),
        idempotentReplay: true,
      };
    }

    // 3. Decide o que acontece com este pedido
    const balance = Money.from(wallet.balance, wallet.currency);
    let status: 'PROCESSED' | 'REJECTED' = 'PROCESSED';
    let failureCode: string | undefined;
    let newBalance = balance;
    let direction: 'DEBIT' | 'CREDIT' | undefined;

    if (i.money.currency !== wallet.currency) {
      status = 'REJECTED';
      failureCode = 'CURRENCY_MISMATCH';
    } else if (i.playerId.toLowerCase() !== wallet.player_id) {
      status = 'REJECTED';
      failureCode = 'PLAYER_MISMATCH';
    } else if (i.kind === 'BET') {
      if (balance.isLessThan(i.money)) {
        status = 'REJECTED';
        failureCode = 'INSUFFICIENT_FUNDS';
      } else {
        direction = 'DEBIT';
        newBalance = balance.subtract(i.money);
      }
    } else if (i.kind === 'WIN') {
      direction = 'CREDIT';
      newBalance = balance.add(i.money);
    }
    // LOSS: fica PROCESSED, mas não mexe no saldo e não gera ledger

    // 4. Grava a transação (sempre, mesmo rejeitada, para ficar auditável)
    const transactionId = randomUUID();
    await tx.execute(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency,
          status, failure_code, balance_observed, processed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now())`,
      [
        transactionId, i.providerId, i.externalTransactionId, key, payloadHash,
        i.walletId, i.playerId, i.roundId, i.gameId, i.kind,
        i.money.toString(), i.money.currency,
        status, failureCode ?? null, newBalance.toString(),
      ],
    );

    // 5. Se o saldo mudou: atualiza a carteira e escreve no ledger
    if (direction) {
      await tx.execute(
        `UPDATE wallets SET balance = ?, version = version + 1, updated_at = now() WHERE id = ?`,
        [newBalance.toString(), i.walletId],
      );
      await tx.execute(
        `INSERT INTO wallet_ledger_entries
           (id, wallet_id, transaction_id, direction, amount, balance_before, balance_after)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          randomUUID(), i.walletId, transactionId, direction,
          i.money.toString(), balance.toString(), newBalance.toString(),
        ],
      );
    }

    return {
      transactionId,
      status,
      failureCode,
      balance: newBalance.toJSON(),
      idempotentReplay: false,
    };
  }
}
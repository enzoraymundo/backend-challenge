# Distributed Wagering Processor

Serviço financeiro que processa transações de apostas (BET, WIN, LOSS) com
**idempotência persistente**, **saldo materializado + ledger imutável** e
**controle de concorrência por wallet**, sobre PostgreSQL.

> Este projeto é uma entrega parcial do desafio técnico. O núcleo financeiro
> (dinheiro, ledger, idempotência, concorrência) está implementado e testado
> contra PostgreSQL real. O que **não** foi implementado está listado na seção
> [Escopo](#escopo) e detalhado em [ARCHITECTURE.md](./ARCHITECTURE.md).

## Stack

Bun, TypeScript, NestJS, PostgreSQL 16, MikroORM 6 (conexão, transações e
migrations), Docker Compose, `decimal.js` para dinheiro.

## Como rodar

Pré-requisitos: [Bun](https://bun.sh) e Docker.

```bash
bun install
docker compose up -d      # sobe o PostgreSQL em localhost:5432
bun run migrate           # aplica as migrations
bun run start:dev         # API em http://localhost:3000
```

Variáveis opcionais (valores padrão entre parênteses): `DB_HOST` (localhost),
`DB_PORT` (5432), `DB_USER` (wagering), `DB_PASSWORD` (wagering),
`DB_NAME` (wagering), `PORT` (3000).

## Testes

O PostgreSQL precisa estar no ar (`docker compose up -d`). Os testes de
integração e concorrência usam o **banco real**, sem mocks.

```bash
bun test src
```

| Arquivo | O que cobre |
|---|---|
| `src/domain/money.spec.ts` | Precisão decimal, escala, entradas inválidas, conflito de moeda |
| `src/wagering/wagering.concurrency.spec.ts` | Duas apostas de 80 disputando saldo de 100; mesma aposta 50x em paralelo; mesma chave com payload diferente; wallets distintas em paralelo |

Todos os testes de concorrência terminam verificando a invariante
**saldo da wallet == saldo reconstruído pelo ledger**.

## API

### Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{"playerId":"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1","initialBalance":{"amount":"1000.00","currency":"BRL"}}'
```

Cria a wallet, uma transação interna `OPENING` e o lançamento `CREDIT`
correspondente no ledger, **na mesma transação SQL**. Wallet duplicada para o
mesmo `playerId` + moeda retorna `409`.

### Submeter transação

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-1" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "tx-1",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<ID DA WALLET>",
    "roundId": "r1",
    "gameId": "g1",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

`kind` aceito: `BET` (debita), `WIN` (credita), `LOSS` (registra, sem mexer no saldo).

### Status HTTP

| Status | Significado | O provedor deve... |
|---|---|---|
| `201` | Processada agora | considerar concluída |
| `200` | Repetição idempotente (`idempotentReplay: true`), devolve o resultado original | considerar concluída |
| `400` | Payload inválido ou `Idempotency-Key` ausente | corrigir e reenviar |
| `404` | Wallet não encontrada | corrigir |
| `409` | Conflito: mesma chave com payload diferente, ou wallet duplicada | não reenviar igual |
| `422` | Rejeitada por regra de negócio (ver `failureCode`) | tratar o motivo |

### `failureCode`

| Código | Quando |
|---|---|
| `INSUFFICIENT_FUNDS` | BET com valor maior que o saldo |
| `CURRENCY_MISMATCH` | Moeda da operação diferente da moeda da wallet |
| `PLAYER_MISMATCH` | `playerId` diferente do dono da wallet |

Transações rejeitadas são gravadas (auditáveis), mas não alteram saldo nem
geram lançamento no ledger.

## Escopo

**Implementado**

- `Money` imutável com `decimal.js`, escala fixa de 2 casas e validação de entrada
- Schema com garantias no banco (ver ARCHITECTURE.md)
- Wallet com saldo inicial (`OPENING`) e ledger
- BET, WIN e LOSS com idempotência persistente e detecção de payload conflitante
- Trava pessimista por wallet (`SELECT ... FOR UPDATE`)
- Migrations versionadas e reversíveis (`up` e `down`)
- Testes de unidade e de concorrência contra PostgreSQL real

**Não implementado** (detalhes e como seria feito em ARCHITECTURE.md)

- REFUND e ROLLBACK, e o fluxo `PENDING_REFERENCE` com worker de reprocessamento
- Consumidor SQS, inbox, retry e DLQ
- Publisher da outbox e eventos de integração
- Endpoint de reconciliação e endpoints de consulta (GET)
- Health checks, logs estruturados e métricas
- Autenticação
- Teste com 3 ou mais instâncias, teste de carga

As tabelas `inbox_messages` e `outbox_messages` já existem no schema, mas ainda
não são usadas pelo código.

## Estrutura

```
src/
  domain/        Money (regras de dinheiro, sem dependência de framework)
  wallets/       Criação de wallet
  wagering/      Processamento de apostas + testes de concorrência
  migrations/    Schema versionado (001 init, 002 balance_observed)
```

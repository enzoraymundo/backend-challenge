# ARCHITECTURE

Este documento registra as decisões técnicas, os trade-offs e as limitações da
entrega. O desenvolvimento foi feito com tempo reduzido, então a prioridade foi
a **correção financeira, a idempotência e a concorrência**, que são as áreas
que mais pesam no desafio.

## 1. Visão geral

```
HTTP ──► Controller ──► Service ──► [ transação SQL ]
                                      1. trava a wallet (FOR UPDATE)
                                      2. consulta a idempotency key
                                      3. aplica a regra de negócio
                                      4. grava a transação
                                      5. atualiza saldo + grava ledger
```

Tudo o que muda dinheiro acontece em **uma única transação SQL**: ou tudo é
confirmado, ou nada é.

## 2. Decisões

### 2.1 Dinheiro

- Nunca `number`. O valor trafega como **string decimal** (`"25.00"`) e as
  contas usam `decimal.js`.
- `Money` é imutável, o construtor é `private` e a criação passa por
  `Money.from` e `Money.zero`. Assim todo `Money` existente já foi validado.
- Entradas rejeitadas: texto não numérico, valores negativos, mais de 2 casas
  decimais, moeda fora do formato de 3 letras maiúsculas.
- Somar ou comparar moedas diferentes lança `DomainError`.
- No banco: `numeric(20,2)`, exato, sem arredondamento de ponto flutuante.

### 2.2 Garantias no schema, não só no código

| Garantia | Como é aplicada |
|---|---|
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` |
| Uma wallet por jogador e moeda | `UNIQUE (player_id, currency)` |
| Idempotência | `UNIQUE (idempotency_key)` |
| Transação do provedor única | `UNIQUE (provider_id, external_transaction_id)` |
| Valores válidos | `CHECK` de `kind`, `status`, `direction` e valores |
| REFUND/ROLLBACK exigem referência | `CHECK` em `wager_transactions` |
| Ledger fecha a conta | `CHECK` de `balance_after = balance_before ± amount` |
| Um lançamento por wallet e transação | `UNIQUE (wallet_id, transaction_id)` |
| Ledger imutável | trigger que bloqueia `UPDATE` e `DELETE` |

A ideia: se um bug no código tentar gravar algo inválido, o banco recusa.

### 2.3 Concorrência: trava pessimista por wallet

A unidade de concorrência é a wallet. O fluxo começa com:

```sql
SELECT ... FROM wallets WHERE id = ? FOR UPDATE
```

Quem chega primeiro segura a linha daquela wallet até o fim da transação; os
outros esperam. Quando passam a vez, leem o saldo **já atualizado**. Isso evita
o padrão `read → calculate → update` sem controle (lost update).

**Por que pessimista e não otimista:** wallets com muita disputa (uma "hot
wallet") fariam o modelo otimista falhar e repetir muitas vezes. A trava de
linha serializa só a mesma wallet; wallets diferentes processam em paralelo,
sem lock global. Funciona com várias instâncias da aplicação, porque a trava
vive no PostgreSQL e não na memória do processo.

**Trade-off:** requisições da mesma wallet ficam em fila. Aceitável aqui,
porque a transação é curta.

### 2.4 Idempotência persistente

- O header `Idempotency-Key` é obrigatório e é a fonte da verdade.
- `payloadHash` = SHA-256 de um **JSON canônico** (chaves em ordem alfabética)
  só com os campos de negócio. O header e metadados de transporte não entram.
- Chave já existente com **mesmo hash** → repetição: devolve o resultado
  original, incluindo o saldo da época (`balance_observed`), com
  `idempotentReplay: true`.
- Chave já existente com **hash diferente** → `409`, não é repetição.
- A consulta da chave acontece **depois** de travar a wallet. Por isso, 50
  requisições iguais em paralelo se enfileiram e só a primeira executa; as
  outras 49 encontram a chave e devolvem a repetição.
- Não há cache em memória: tudo é persistido no PostgreSQL.
- Rede de segurança: se duas requisições corressem mesmo assim, as constraints
  `UNIQUE` do banco impedem a duplicação, e o erro vira `409`.

### 2.5 Ledger e saldo materializado

- `wallets.balance` é um resumo pronto para leitura rápida.
- `wallet_ledger_entries` é a prova: uma linha por movimentação, com
  `balance_before` e `balance_after`, imutável.
- Saldo e ledger são gravados **na mesma transação**, e a invariante
  `saldo == soma do ledger` é verificada ao final dos testes.
- Operações sem efeito no saldo (`LOSS`, qualquer `REJECTED`) não geram
  lançamento.

### 2.6 Rejeições são registradas

Uma aposta rejeitada (ex.: saldo insuficiente) é gravada como `REJECTED` com
`failure_code`. Isso mantém a trilha de auditoria e permite que a repetição
devolva a mesma resposta.

### 2.7 ORM e migrations

Foi escolhido o **MikroORM 6** (a versão 7 ainda estava em transição). Nesta
entrega ele é usado para **conexão, `EntityManager.transactional()` e
migrations versionadas** (com `up` e `down`). As consultas críticas são SQL
explícito dentro da transação, porque dão controle direto sobre `FOR UPDATE` e
sobre a ordem das operações.

**Trade-off:** não foram mapeadas entidades nem usados Unit of Work e Identity
Map; em troca, o código fica mais explícito e menor. Num projeto maior, as
entidades fariam sentido.

### 2.8 Status HTTP

`201` processada, `200` repetição, `400` payload inválido, `404` wallet
inexistente, `409` conflito, `422` rejeição de negócio. Cada situação tem um
código distinto para o provedor decidir se reenvia, corrige ou desiste.

### 2.9 Códigos de falha

`INSUFFICIENT_FUNDS`, `CURRENCY_MISMATCH` e `PLAYER_MISMATCH`.

## 3. Autenticação

**Não implementada.** O desafio permite essa opção desde que documentada. O
desenho que eu adotaria: integrar um Identity Provider externo (Keycloak ou
Zitadel via OIDC) e validar o JWT em um `AuthGuard` global do NestJS, com os
endpoints de health abertos. Não escrever tabela de usuários nem hash de senha.
O ponto de extensão (o guard) ainda **não foi criado** no código.

## 4. Limitações conhecidas

- **REFUND e ROLLBACK não existem.** O schema já tem os campos e o `CHECK` de
  referência, mas a regra não foi implementada.
- **Sem `PENDING_REFERENCE`.** Sem reversões, não há dependência fora de ordem
  para tratar ainda.
- **Sem SQS.** Não há consumidor, inbox em uso, retry nem DLQ.
- **Sem eventos.** A tabela `outbox_messages` existe, mas nada grava nela nem
  publica. Hoje nenhum evento é emitido, então não há risco de publicar antes
  do commit.
- **Sem reconciliação nem consultas.** A invariante saldo = ledger é conferida
  nos testes, mas não existe endpoint.
- **Sem observabilidade.** Sem health checks, logs estruturados ou métricas.
- **Modelo de domínio enxuto.** Só `Money` está encapsulado em classe. A
  lógica de `Wallet`, `WagerTransaction` e `WalletLedgerEntry` está no service,
  como SQL e regras diretas. Mover isso para agregados com `create`/`rehydrate`
  seria o próximo passo de modelagem.
- **Teste multi-instância.** A trava funciona por estar no banco, mas não há
  teste com 3 ou mais processos; os testes de concorrência usam várias
  requisições em paralelo dentro de um processo.
- **Sem teste de carga.**

## 5. Próximos passos, em ordem de prioridade

1. Endpoint de reconciliação (consulta curta que compara saldo e ledger).
2. REFUND e ROLLBACK, com as regras de referência (mesmo provedor, jogador,
   wallet, moeda, rodada e valor).
3. `PENDING_REFERENCE` com worker agendado e backoff exponencial.
4. Outbox: gravar eventos na mesma transação e criar o publisher com
   `FOR UPDATE SKIP LOCKED`, que permite vários publishers sem duplicar.
5. Consumidor SQS com inbox por `(consumerName, messageId)`, ack só após o
   commit, retry com backoff e DLQ.
6. Health checks, logs estruturados com `correlationId` e métricas.
7. Teste com 3 ou mais instâncias reais da aplicação.
8. Agregados de domínio com `create` e `rehydrate`.

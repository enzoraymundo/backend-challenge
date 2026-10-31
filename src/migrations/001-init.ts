import { Migration } from '@mikro-orm/migrations'

export class Migration001Init extends Migration {
  async up(): Promise<void> {
    this.addSql(`
      CREATE TABLE wallets (
        id          uuid PRIMARY KEY,
        player_id   uuid NOT NULL,
        currency    char(3) NOT NULL,
        balance     numeric(20,2) NOT NULL CHECK (balance >= 0),
        version     integer NOT NULL DEFAULT 1,
        created_at  timestamptz NOT NULL DEFAULT now(),
        updated_at  timestamptz NOT NULL DEFAULT now(),
        UNIQUE (player_id, currency)
      );
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id                                uuid PRIMARY KEY,
        provider_id                       text NOT NULL,
        external_transaction_id           text NOT NULL,
        idempotency_key                   text NOT NULL UNIQUE,
        payload_hash                      text NOT NULL,
        wallet_id                         uuid NOT NULL REFERENCES wallets(id),
        player_id                         uuid NOT NULL,
        round_id                          text NOT NULL,
        game_id                           text NOT NULL,
        kind                              text NOT NULL
          CHECK (kind IN ('OPENING','BET','WIN','LOSS','REFUND','ROLLBACK')),
        amount                            numeric(20,2) NOT NULL CHECK (amount >= 0),
        currency                          char(3) NOT NULL,
        reference_external_transaction_id text,
        reference_transaction_id          uuid REFERENCES wager_transactions(id),
        status                            text NOT NULL
          CHECK (status IN ('PENDING','PENDING_REFERENCE','PROCESSED','REJECTED','FAILED')),
        failure_code                      text,
        created_at                        timestamptz NOT NULL DEFAULT now(),
        processed_at                      timestamptz,
        UNIQUE (provider_id, external_transaction_id),
        CHECK (kind NOT IN ('REFUND','ROLLBACK') OR reference_external_transaction_id IS NOT NULL)
      );
    `);

    this.addSql(`
      CREATE TABLE wallet_ledger_entries (
        id             uuid PRIMARY KEY,
        wallet_id      uuid NOT NULL REFERENCES wallets(id),
        transaction_id uuid NOT NULL REFERENCES wager_transactions(id),
        direction      text NOT NULL CHECK (direction IN ('DEBIT','CREDIT')),
        amount         numeric(20,2) NOT NULL CHECK (amount > 0),
        balance_before numeric(20,2) NOT NULL CHECK (balance_before >= 0),
        balance_after  numeric(20,2) NOT NULL CHECK (balance_after >= 0),
        created_at     timestamptz NOT NULL DEFAULT now(),
        UNIQUE (wallet_id, transaction_id),
        CHECK (
          (direction = 'CREDIT' AND balance_after = balance_before + amount) OR
          (direction = 'DEBIT'  AND balance_after = balance_before - amount)
        )
      );
    `);

    this.addSql(`
      CREATE FUNCTION forbid_ledger_changes() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'O ledger é imutável: UPDATE e DELETE são proibidos';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_immutable
      BEFORE UPDATE OR DELETE ON wallet_ledger_entries
      FOR EACH ROW EXECUTE FUNCTION forbid_ledger_changes();
    `);

    this.addSql(`
      CREATE TABLE inbox_messages (
        consumer_name text NOT NULL,
        message_id    text NOT NULL,
        payload_hash  text NOT NULL,
        received_at   timestamptz NOT NULL DEFAULT now(),
        processed_at  timestamptz,
        PRIMARY KEY (consumer_name, message_id)
      );
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id              uuid PRIMARY KEY,
        aggregate_id    uuid NOT NULL,
        event_type      text NOT NULL,
        payload         jsonb NOT NULL,
        occurred_at     timestamptz NOT NULL DEFAULT now(),
        attempts        integer NOT NULL DEFAULT 0,
        next_attempt_at timestamptz,
        published_at    timestamptz
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_pending_idx ON outbox_messages (occurred_at)
      WHERE published_at IS NULL;
    `);
  }

  async down(): Promise<void> {
    this.addSql('DROP TABLE IF EXISTS outbox_messages;')
    this.addSql('DROP TABLE IF EXISTS inbox_messages;')
    this.addSql('DROP TABLE IF EXISTS wallet_ledger_entries;')
    this.addSql('DROP FUNCTION IF EXISTS forbid_ledger_changes();')
    this.addSql('DROP TABLE IF EXISTS wager_transactions;')
    this.addSql('DROP TABLE IF EXISTS wallets;')
  }
}
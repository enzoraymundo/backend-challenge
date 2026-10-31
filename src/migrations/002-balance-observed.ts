import { Migration } from '@mikro-orm/migrations';

export class Migration002BalanceObserved extends Migration {
  async up(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions ADD COLUMN balance_observed numeric(20,2);`);
  }

  async down(): Promise<void> {
    this.addSql(`ALTER TABLE wager_transactions DROP COLUMN balance_observed;`);
  }
}
import { defineConfig, PostgreSqlDriver } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration001Init } from './migrations/001-init';
import { Migration002BalanceObserved } from './migrations/002-balance-observed';

export default defineConfig({
  driver: PostgreSqlDriver,
  host: process.env.DB_HOST ?? 'localhost',
  port: Number(process.env.DB_PORT ?? 5432),
  user: process.env.DB_USER ?? 'wagering',
  password: process.env.DB_PASSWORD ?? 'wagering',
  dbName: process.env.DB_NAME ?? 'wagering',
  entities: [],
  discovery: { warnWhenNoEntities: false },
  extensions: [Migrator],
  migrations: {
    migrationsList: [{ name: 'Migration001Init', class: Migration001Init },
                     { name: 'Migration002BalanceObserved', class: Migration002BalanceObserved },
    ],
    transactional: true,
  },
});


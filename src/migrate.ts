import { MikroORM } from '@mikro-orm/postgresql';
import config from './mikro-orm.config';

async function main() {
  const orm = await MikroORM.init(config);
  await orm.getMigrator().up();
  await orm.close();
  console.log('Migrations aplicadas');
}

main();
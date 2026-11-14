import { migrate, type Db } from '../../src/db/db.js';

export async function resetDb(db: Db): Promise<void> {
  await db.query('DROP TABLE IF EXISTS messages, conversations, listings, orders, items, settings CASCADE');
  await migrate(db);
}

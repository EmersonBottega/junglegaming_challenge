import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";

async function runMigrations(): Promise<void> {
  const orm = new MikroORM(createMikroOrmConfig());

  try {
    await orm.connect();
    const migrations = await orm.migrator.up();
    console.log(`Migrations executadas: ${migrations.length}.`);
  } finally {
    await orm.close(true);
  }
}

void runMigrations().catch((error: unknown) => {
  console.error("Não foi possível executar as migrations do PostgreSQL.", error);
  process.exitCode = 1;
});

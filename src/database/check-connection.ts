import { MikroORM } from "@mikro-orm/postgresql";
import { createMikroOrmConfig } from "./mikro-orm.config";

async function checkConnection(): Promise<void> {
  const orm = new MikroORM(createMikroOrmConfig());

  try {
    await orm.connect();
    await orm.em.getConnection().execute("select 1");
    console.log("Conexão com PostgreSQL via MikroORM confirmada.");
  } finally {
    await orm.close(true);
  }
}

void checkConnection().catch((error: unknown) => {
  console.error("Não foi possível conectar ao PostgreSQL via MikroORM.", error);
  process.exitCode = 1;
});

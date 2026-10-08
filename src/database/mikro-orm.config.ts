import { defineConfig } from "@mikro-orm/postgresql";
import { Migrator } from "@mikro-orm/migrations";

function requiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`A variável de ambiente ${name} não foi definida`);
  }

  return value;
}

function databasePort(): number {
  const value = requiredEnvironmentVariable("DB_PORT");
  const port = Number(value);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DB_PORT deve ser um inteiro entre 1 e 65535");
  }

  return port;
}

export function createMikroOrmConfig() {
  return defineConfig({
    host: requiredEnvironmentVariable("DB_HOST"),
    port: databasePort(),
    dbName: requiredEnvironmentVariable("DB_NAME"),
    user: requiredEnvironmentVariable("DB_USER"),
    password: requiredEnvironmentVariable("DB_PASSWORD"),
    entities: [],
    extensions: [Migrator],
    migrations: {
      path: "dist/database/migrations",
      pathTs: "src/database/migrations",
    },
    discovery: {
      warnWhenNoEntities: false,
    },
  });
}

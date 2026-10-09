import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  const port = Number(process.env.PORT ?? 3000);

  app.enableShutdownHooks();
  await app.listen(port);
}

void bootstrap().catch((error: unknown) => {
  console.error("Application startup failed", error);
  process.exitCode = 1;
});

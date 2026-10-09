import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from "@nestjs/common";
import type { MikroORM } from "@mikro-orm/postgresql";
import { ORM_TOKEN } from "../infrastructure/tokens";
import { SqsQueues } from "../messaging/sqs-queues";

@Controller("health")
export class HealthController {
  constructor(
    @Inject(ORM_TOKEN) private readonly orm: MikroORM,
    private readonly queues: SqsQueues,
  ) {}

  @Get("live")
  getLiveness(): { status: "ok" } {
    return { status: "ok" };
  }

  @Get("ready")
  async getReadiness() {
    const checks = await Promise.all([
      this.orm.em.execute("SELECT 1")
        .then(() => ({ postgres: "ok" as const }))
        .catch(() => ({ postgres: "error" as const })),
      this.queues.checkReady()
        .then(() => ({ sqs: "ok" as const }))
        .catch(() => ({ sqs: "error" as const })),
    ]);
    const result = Object.assign({}, ...checks);
    if (checks.some((check) => Object.values(check).includes("error"))) {
      throw new ServiceUnavailableException({ status: "not_ready", ...result });
    }
    return { status: "ready", ...result };
  }
}

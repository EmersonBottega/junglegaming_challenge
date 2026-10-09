import { Controller, Get, Header } from "@nestjs/common";
import { ApplicationMetrics } from "./metrics";

@Controller("metrics")
export class MetricsController {
  constructor(private readonly metrics: ApplicationMetrics) {}

  @Get()
  @Header("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
  getMetrics(): string {
    return this.metrics.toPrometheus();
  }
}

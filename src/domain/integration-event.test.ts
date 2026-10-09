import { describe, expect, test } from "bun:test";
import {
  IntegrationEvent,
  type IntegrationEventProps,
  WalletBalanceChanged,
} from "./integration-event";
import { LedgerDirection } from "./wallet-ledger-entry";

class TestIntegrationEvent extends IntegrationEvent<{ value: string }> {
  readonly eventType = "TestEvent";
  readonly version = 1;

  constructor(props: IntegrationEventProps<{ value: string }>) {
    super(props);
  }
}

const eventProps: IntegrationEventProps<{ value: string }> = {
  eventId: "event-1",
  aggregateId: "wallet-1",
  correlationId: "correlation-1",
  causationId: "transaction-1",
  occurredAt: new Date("2026-10-09T10:00:00.000Z"),
  data: { value: "stable" },
};

describe("IntegrationEvent", () => {
  test("serializes the event envelope with a stable ISO date", () => {
    const event = new TestIntegrationEvent(eventProps);

    expect(event.toJSON()).toEqual({
      eventId: "event-1",
      eventType: "TestEvent",
      aggregateId: "wallet-1",
      correlationId: "correlation-1",
      causationId: "transaction-1",
      occurredAt: "2026-10-09T10:00:00.000Z",
      version: 1,
      data: { value: "stable" },
    });
  });

  test("copies and freezes event dates and payload data", () => {
    const occurredAt = new Date(eventProps.occurredAt);
    const data = { value: "stable" };
    const event = new TestIntegrationEvent({ ...eventProps, occurredAt, data });
    occurredAt.setUTCFullYear(2000);
    data.value = "mutated";

    expect(event.toJSON().occurredAt).toBe("2026-10-09T10:00:00.000Z");
    expect(event.data.value).toBe("stable");
  });

  test("uses the concrete event type and MoneyProps-shaped payload", () => {
    const event = new WalletBalanceChanged({
      eventId: "event-2",
      aggregateId: "wallet-1",
      correlationId: "correlation-1",
      occurredAt: eventProps.occurredAt,
      data: {
        walletId: "wallet-1",
        transactionId: "transaction-1",
        direction: LedgerDirection.Credit,
        money: { amount: "10.00", currency: "BRL" },
        balanceBefore: { amount: "0.00", currency: "BRL" },
        balanceAfter: { amount: "10.00", currency: "BRL" },
        walletVersion: 2,
      },
    });

    expect(event.eventType).toBe("WalletBalanceChanged");
    expect(event.version).toBe(1);
    expect(event.toJSON().data.money).toEqual({ amount: "10.00", currency: "BRL" });
  });

  test("rejects missing event identity and invalid date", () => {
    expect(() => new TestIntegrationEvent({ ...eventProps, eventId: " " })).toThrow();
    expect(() => new TestIntegrationEvent({
      ...eventProps,
      occurredAt: new Date(Number.NaN),
    })).toThrow();
  });
});

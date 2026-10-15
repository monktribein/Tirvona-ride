import { calculateFare } from "./fare-calculator";
import type { PricingRates } from "./fare-calculator";
import type { TripMeasurement } from "./trip-meter";
import {
  FARE_SETTING_DEFAULTS,
  WAITING_DEFAULTS,
  bufferedDurationSeconds,
  resolveUpfrontFare,
  waitingCharge,
} from "./upfront-fare";
import type { WaitingTerms } from "./upfront-fare";

const RATES: PricingRates = {
  currency: "INR",
  baseFare: 30,
  perKmRate: 10,
  perMinuteRate: 1.5,
  minimumFare: 40,
};
const TERMS: WaitingTerms = {
  freeMinutes: 3,
  perMinuteRate: 2,
  maxChargeMinutes: 15,
};
const T0 = new Date("2026-10-15T10:00:00.000Z");
const after = (seconds: number): Date => new Date(T0.getTime() + seconds * 1000);

const trail = (distanceMeters: number, reliable = true): TripMeasurement => ({
  distanceMeters,
  points: 20,
  maxGapSeconds: 15,
  reliable,
  ...(reliable ? {} : { reason: "GAP_TOO_LONG" as const }),
});

describe("bufferedDurationSeconds", () => {
  it("adds the percentage and rounds to whole seconds", () => {
    expect(bufferedDurationSeconds(600, 10)).toBe(660);
    expect(bufferedDurationSeconds(601, 10)).toBe(661);
    expect(bufferedDurationSeconds(600, 0)).toBe(600);
  });

  it("ships a 10% buffer and 300 s validity as defaults, and free waiting", () => {
    expect(FARE_SETTING_DEFAULTS).toEqual({
      quoteValiditySeconds: 300,
      etaBufferPercent: 10,
    });
    expect(WAITING_DEFAULTS).toEqual({
      freeMinutes: 3,
      perMinuteRate: 0,
      maxChargeMinutes: 15,
    });
  });
});

describe("waitingCharge", () => {
  it("is free exactly at the free minutes", () => {
    const result = waitingCharge(TERMS, T0, after(180));
    expect(result).toMatchObject({
      waitedSeconds: 180,
      chargeableMinutes: 0,
      charge: 0,
      capped: false,
    });
  });

  it("rounds a started minute up (1 s past the free time = 1 minute)", () => {
    expect(waitingCharge(TERMS, T0, after(181))).toMatchObject({
      chargeableMinutes: 1,
      charge: 2,
    });
    expect(waitingCharge(TERMS, T0, after(240))).toMatchObject({
      chargeableMinutes: 1,
      charge: 2,
    });
    expect(waitingCharge(TERMS, T0, after(241))).toMatchObject({
      chargeableMinutes: 2,
      charge: 4,
    });
  });

  it("caps the chargeable minutes", () => {
    const result = waitingCharge(TERMS, T0, after(3_600));
    expect(result).toMatchObject({
      chargeableMinutes: 15,
      charge: 30,
      capped: true,
    });
  });

  it("charges nothing at a zero rate however long the wait", () => {
    const free: WaitingTerms = { ...TERMS, perMinuteRate: 0 };
    expect(waitingCharge(free, T0, after(3_600)).charge).toBe(0);
  });

  it("charges whole rupees", () => {
    const fractional: WaitingTerms = { ...TERMS, perMinuteRate: 1.5 };
    expect(waitingCharge(fractional, T0, after(180 + 60)).charge).toBe(2);
    expect(waitingCharge(fractional, T0, after(180 + 120)).charge).toBe(3);
  });

  it("charges nothing when a time is missing or the clock runs backwards", () => {
    expect(waitingCharge(TERMS, undefined, after(900)).charge).toBe(0);
    expect(waitingCharge(TERMS, T0, undefined).charge).toBe(0);
    expect(waitingCharge(TERMS, after(900), T0)).toMatchObject({
      waitedSeconds: 0,
      charge: 0,
    });
  });

  it("a zero free window charges from the first second", () => {
    const none: WaitingTerms = { ...TERMS, freeMinutes: 0 };
    expect(waitingCharge(none, T0, after(1))).toMatchObject({
      chargeableMinutes: 1,
      charge: 2,
    });
  });
});

describe("resolveUpfrontFare", () => {
  const input = {
    quotedFare: 100,
    rates: RATES,
    bookedDistanceMeters: 5_000,
    arrivedAt: T0,
    startedAt: after(120),
    completedAt: after(120 + 1_200),
    waiting: TERMS,
  };

  it("bills exactly the quote, however long or far the trip actually ran", () => {
    const slow = resolveUpfrontFare({
      ...input,
      completedAt: after(120 + 3 * 3_600),
      measurement: trail(40_000),
    });
    expect(slow.base).toBe(100);
    expect(slow.total).toBe(100);
    // The meter would have charged far more: the platform absorbs it.
    expect(slow.actual.total).toBeGreaterThan(100);
  });

  it("bills exactly the quote when the rider gets off well before the destination", () => {
    // 2 km of a 5 km trip on a reliable trail: still the full quote.
    const early = resolveUpfrontFare({
      ...input,
      measurement: trail(2_000),
    });
    expect(early.base).toBe(100);
    expect(early.total).toBe(100);
    // Only the report sees what the shorter trip would have cost.
    expect(early.actual.total).toBe(calculateFare(RATES, 2_000, 1_200).total);
    expect(early.actual.total).toBeLessThan(100);
  });

  it("is not affected by a missing or glitchy trail", () => {
    const glitchy = resolveUpfrontFare({
      ...input,
      measurement: trail(10, false),
    });
    expect(glitchy.total).toBe(100);
    expect(glitchy.distanceSource).toBe("BOOKED");
    expect(resolveUpfrontFare({ ...input }).total).toBe(100);
  });

  it("adds the waiting charge as a separate amount", () => {
    const waited = resolveUpfrontFare({
      ...input,
      arrivedAt: T0,
      startedAt: after(8 * 60),
      completedAt: after(8 * 60 + 600),
    });
    // 8 min waited, 3 free → 5 chargeable × ₹2
    expect(waited.waiting).toMatchObject({ chargeableMinutes: 5, charge: 10 });
    expect(waited.base).toBe(100);
    expect(waited.total).toBe(110);
  });

  it("adds nothing for waiting at the default (free) terms", () => {
    const result = resolveUpfrontFare({
      ...input,
      arrivedAt: T0,
      startedAt: after(3_600),
      completedAt: after(3_600 + 600),
      waiting: WAITING_DEFAULTS,
    });
    expect(result.waiting.charge).toBe(0);
    expect(result.total).toBe(100);
  });
});

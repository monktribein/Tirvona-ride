import { calculateFare } from "./fare-calculator";
import type { FareBreakdown, PricingRates } from "./fare-calculator";
import type { TripMeasurement } from "./trip-meter";

/**
 * How a ride type charges. UPFRONT: the fare quoted at booking is the fare
 * (plus a waiting charge, and a lower fare when the trip ends early). METERED:
 * the fare is recalculated from the actual trip at completion (capped).
 */
export enum PricingMode {
  UPFRONT = "UPFRONT",
  METERED = "METERED",
}

export const DEFAULT_PRICING_MODE = PricingMode.METERED;

/** Per-ride-type waiting terms (the ride snapshots them at booking). */
export interface WaitingTerms {
  /** Free wait at the pickup, minutes. */
  freeMinutes: number;
  /** Rupees per chargeable minute. 0 = waiting is never charged. */
  perMinuteRate: number;
  /** Most minutes that can be charged, so a long wait never becomes a shock bill. */
  maxChargeMinutes: number;
}

export const WAITING_DEFAULTS: WaitingTerms = {
  freeMinutes: 3,
  perMinuteRate: 0,
  maxChargeMinutes: 15,
};

/** Sanity rails for what an admin may enter. */
export const WAITING_LIMITS = {
  freeMinutes: { min: 0, max: 30 },
  perMinuteRate: { min: 0, max: 100 },
  maxChargeMinutes: { min: 0, max: 120 },
} as const;

/** Platform-wide upfront-fare settings (PlatformSettings). */
export interface FareSettings {
  /** How long a quote can be confirmed before the app must ask again. */
  quoteValiditySeconds: number;
  /** Extra time added to the route ETA when quoting, so slower trips do not lose money. */
  etaBufferPercent: number;
  /** A trip shorter than this share of the booked distance counts as an early drop. */
  earlyDropThresholdPercent: number;
}

export const FARE_SETTING_DEFAULTS: FareSettings = {
  quoteValiditySeconds: 300,
  etaBufferPercent: 10,
  earlyDropThresholdPercent: 70,
};

export const FARE_SETTING_LIMITS = {
  quoteValiditySeconds: { min: 30, max: 3_600 },
  etaBufferPercent: { min: 0, max: 50 },
  earlyDropThresholdPercent: { min: 10, max: 95 },
} as const;

/** Route duration with the ETA buffer added; what the upfront quote is priced on. */
export function bufferedDurationSeconds(
  durationSeconds: number,
  bufferPercent: number,
): number {
  return Math.round(durationSeconds * (1 + bufferPercent / 100));
}

export interface WaitingResult {
  /** Whole time the driver waited at the pickup, seconds. */
  waitedSeconds: number;
  freeMinutes: number;
  /** Minutes billed: past the free time, rounded up, capped. */
  chargeableMinutes: number;
  perMinuteRate: number;
  maxChargeMinutes: number;
  /** Rupees, whole rupees, never negative. */
  charge: number;
  /** The cap limited the bill. */
  capped: boolean;
}

/**
 * Waiting at the pickup: from the driver's arrival to `until` (the trip start,
 * or "now" for a live meter). The free minutes come off first, the rest is
 * rounded UP to whole minutes, capped, and priced. Missing times charge nothing.
 */
export function waitingCharge(
  terms: WaitingTerms,
  arrivedAt: Date | undefined,
  until: Date | undefined,
): WaitingResult {
  const waitedSeconds =
    arrivedAt && until
      ? Math.max(0, Math.round((until.getTime() - arrivedAt.getTime()) / 1000))
      : 0;
  const chargeableSeconds = Math.max(0, waitedSeconds - terms.freeMinutes * 60);
  const uncapped = Math.ceil(chargeableSeconds / 60);
  const chargeableMinutes = Math.min(uncapped, terms.maxChargeMinutes);
  return {
    waitedSeconds,
    freeMinutes: terms.freeMinutes,
    chargeableMinutes,
    perMinuteRate: terms.perMinuteRate,
    maxChargeMinutes: terms.maxChargeMinutes,
    charge: Math.round(chargeableMinutes * terms.perMinuteRate),
    capped: uncapped > terms.maxChargeMinutes,
  };
}

export interface EarlyDropInput {
  bookedDistanceMeters: number;
  thresholdPercent: number;
  measurement?: TripMeasurement;
  /** ride.endCheck.farFromDestination: the trip ended well short of the drop-off. */
  farFromDestination?: boolean;
}

/**
 * The rider got out well before the booked drop-off. Only a reliable trail
 * and a "far from destination" end both count: a GPS glitch or a patchy trail
 * must never lower a fare.
 */
export function isEarlyDrop(input: EarlyDropInput): boolean {
  if (!input.farFromDestination) return false;
  if (!input.measurement?.reliable) return false;
  if (input.bookedDistanceMeters <= 0) return false;
  return (
    input.measurement.distanceMeters <
    (input.bookedDistanceMeters * input.thresholdPercent) / 100
  );
}

export interface UpfrontFareInput {
  /** The locked fare: ride.fare.quotedFare. */
  quotedFare: number;
  /** The tariff frozen on the ride (the peak-raised per-km rate included). */
  rates: PricingRates;
  bookedDistanceMeters: number;
  arrivedAt?: Date;
  startedAt?: Date;
  completedAt: Date;
  measurement?: TripMeasurement;
  farFromDestination?: boolean;
  earlyDropThresholdPercent: number;
  waiting: WaitingTerms;
}

export interface UpfrontFareResult {
  /** The fare before waiting: the quote, or less after an early drop. */
  base: number;
  /** The trip ended short and was billed on the distance travelled (below the quote). */
  earlyDrop: boolean;
  /** What the actual trip costs at the metered tariff (reporting; also the early-drop price). */
  actual: FareBreakdown;
  actualDistanceMeters: number;
  actualDurationSeconds: number;
  distanceSource: "ACTUAL" | "BOOKED";
  waiting: WaitingResult;
  /** The components the bill shows: the quote's, or the actual trip's after an early drop. */
  breakdown?: FareBreakdown;
  /** base + waiting */
  total: number;
}

/**
 * Upfront ride completed → what the customer owes before any discount:
 * the locked quote (no recalculation from time or distance), or the smaller
 * metered fare of the trip actually made after an early drop, plus the
 * waiting charge as its own line.
 */
export function resolveUpfrontFare(input: UpfrontFareInput): UpfrontFareResult {
  const actualDurationSeconds = input.startedAt
    ? Math.max(
        0,
        Math.round(
          (input.completedAt.getTime() - input.startedAt.getTime()) / 1000,
        ),
      )
    : 0;
  const distanceSource = input.measurement?.reliable ? "ACTUAL" : "BOOKED";
  const actualDistanceMeters =
    distanceSource === "ACTUAL"
      ? input.measurement!.distanceMeters
      : input.bookedDistanceMeters;
  const actual = calculateFare(
    input.rates,
    actualDistanceMeters,
    actualDurationSeconds,
  );
  // An early drop is only recorded when it actually lowered the fare: it never
  // charges more than the quote, even if the meter (a long wait) would.
  const earlyDrop =
    isEarlyDrop({
      bookedDistanceMeters: input.bookedDistanceMeters,
      thresholdPercent: input.earlyDropThresholdPercent,
      measurement: input.measurement,
      farFromDestination: input.farFromDestination,
    }) && actual.total < input.quotedFare;
  const base = earlyDrop ? actual.total : input.quotedFare;
  const waiting = waitingCharge(input.waiting, input.arrivedAt, input.startedAt);
  return {
    base,
    earlyDrop,
    actual,
    actualDistanceMeters,
    actualDurationSeconds,
    distanceSource,
    waiting,
    breakdown: earlyDrop ? actual : undefined,
    total: base + waiting.charge,
  };
}

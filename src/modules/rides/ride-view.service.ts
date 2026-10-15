import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model, Types } from "mongoose";
import { toPaise, toRupees } from "../../common/utils/money";
import { splitFare } from "../earnings/commission";
import { CommissionService } from "../earnings/commission.service";
import { DriverProfile } from "../drivers/schemas/driver-profile.schema";
import type { DriverProfileDocument } from "../drivers/schemas/driver-profile.schema";
import { fromGeoJsonPoint } from "../locations/geo";
import { DriverLocationService } from "../locations/driver-location.service";
import { LocationsService } from "../locations/locations.service";
import { User } from "../users/schemas/user.schema";
import type { UserDocument } from "../users/schemas/user.schema";
import { circuitView } from "../circuit-rides/circuit-view";
import type { CircuitView } from "../circuit-rides/circuit-view";
import { RideKind } from "../circuit-rides/circuit-ride.types";
import { DEFAULT_PRICING_MODE, PricingMode, waitingCharge } from "../pricing/upfront-fare";
import { overrideAvailableAt } from "./ride-completion";
import type { RideCompletionMode } from "./ride-completion";
import { effectivePaymentStatus } from "./ride-payment-status";
import type { RidePaymentStatus } from "./ride-payment-status";
import { DRIVER_ENGAGED_STATUSES, RideStatus } from "./ride-state-machine";
import type { RideActorType } from "./ride-state-machine";
import type {
  RideDocument,
  RideFareAdjustment,
  RideFinalFare,
  RideLocation,
  RideVehicle,
} from "./schemas/ride.schema";

export interface RideFareView {
  currency: string;
  baseFare: number;
  /** What the ride is charged per km (the peak rate when `peak` is set). */
  perKmRate: number;
  /** The permanent per-km rate, for showing "₹18 → ₹27/km". */
  basePerKmRate: number;
  /** The peak slot that applied when the ride was booked. Frozen on the ride. */
  peak?: RidePeakView;
  perMinuteRate: number;
  minimumFare: number;
  distanceCharge: number;
  timeCharge: number;
  subtotal: number;
  minimumFareApplied: boolean;
  estimatedFare: number;
  finalFare?: number;
  /** Promo discount (estimate until completion), rupees. */
  discount?: number;
  /** What the customer pays after the discount; absent when no promo. */
  payableFare?: number;
  /** The frozen final bill: actual trip measured and each component (absent until completion). */
  final?: RideFinalFareView;
  /** UPFRONT: `estimatedFare` is the locked quote and is what the ride costs (plus waiting, when the ride type charges for it). */
  pricingMode: PricingMode;
  /** UPFRONT: the locked amount; equals `estimatedFare`. */
  quotedFare?: number;
  quotedAt?: Date;
  /** Manual fare changes made after completion, oldest first. */
  adjustments?: RideFareAdjustmentView[];
}

export interface RideFareAdjustmentView {
  type: string;
  /** Signed rupees: negative lowers the fare. */
  amount: number;
  reason: string;
  at: Date;
}

/**
 * Waiting at the pickup on an upfront ride: the terms, how long the driver
 * has waited and what that costs so far. While `running` the meter is live —
 * apps count on from `waitedSeconds` against `serverTime`.
 */
export interface RideWaitingView {
  freeMinutes: number;
  perMinuteRate: number;
  maxChargeMinutes: number;
  waitedSeconds: number;
  chargeableMinutes: number;
  /** Rupees charged so far (the final charge once the trip has started). */
  currentCharge: number;
  /** Past this instant waiting is charged; absent before the driver arrives. */
  freeUntil?: Date;
  /** The driver is at the pickup and the trip has not started: the meter is running. */
  running: boolean;
  /** The cap on chargeable minutes has been reached. */
  capped: boolean;
  serverTime: Date;
}

const adjustmentView = (
  adjustment: RideFareAdjustment,
): RideFareAdjustmentView => ({
  type: adjustment.type,
  amount: adjustment.amount,
  reason: adjustment.reason,
  at: adjustment.at,
});

/** Null for metered rides and rides booked before waiting terms were frozen on them. */
export function waitingView(
  ride: RideDocument,
  now: Date = new Date(),
): RideWaitingView | undefined {
  const terms = ride.fare.waiting;
  if (ride.fare.pricingMode !== PricingMode.UPFRONT || !terms) return undefined;
  const running = ride.status === RideStatus.DRIVER_ARRIVED;
  const until = ride.startedAt ?? (running ? now : undefined);
  const result = waitingCharge(terms, ride.arrivedAt, until);
  return {
    freeMinutes: terms.freeMinutes,
    perMinuteRate: terms.perMinuteRate,
    maxChargeMinutes: terms.maxChargeMinutes,
    waitedSeconds: result.waitedSeconds,
    chargeableMinutes: result.chargeableMinutes,
    currentCharge: ride.fare.final?.waitingCharge ?? result.charge,
    freeUntil: ride.arrivedAt
      ? new Date(ride.arrivedAt.getTime() + terms.freeMinutes * 60_000)
      : undefined,
    running,
    capped: result.capped,
    serverTime: now,
  };
}

export interface RidePeakView {
  name: string;
  hikePercent: number;
  startTime: string;
  endTime: string;
  surcharge: number;
}

export interface RideFinalFareView {
  distanceMeters: number;
  durationSeconds: number;
  distanceSource: string;
  durationSource: string;
  baseFare: number;
  distanceCharge: number;
  timeCharge: number;
  subtotal: number;
  minimumFareApplied: boolean;
  capApplied: boolean;
  total: number;
  discount: number;
  payable: number;
  pricingVersion: number;
  /** Upfront rides: the locked quote the bill started from. */
  quotedFare?: number;
  /** Upfront rides: waiting charge added to the fare, rupees. */
  waitingCharge?: number;
  waitingSeconds?: number;
  waitingChargeableMinutes?: number;
  /** Upfront rides: ended short of the drop-off and priced on the distance travelled. */
  earlyDrop?: boolean;
  /** Signed total of manual adjustments applied after completion. */
  adjustmentsTotal?: number;
}

export function finalFareView(
  final?: RideFinalFare,
): RideFinalFareView | undefined {
  if (!final) return undefined;
  return {
    distanceMeters: final.distanceMeters,
    durationSeconds: final.durationSeconds,
    distanceSource: final.distanceSource,
    durationSource: final.durationSource,
    baseFare: final.baseFare,
    distanceCharge: final.distanceCharge,
    timeCharge: final.timeCharge,
    subtotal: final.subtotal,
    minimumFareApplied: final.minimumFareApplied,
    capApplied: final.capApplied,
    total: final.total,
    discount: final.discount,
    payable: final.payable,
    pricingVersion: final.pricingVersion,
    quotedFare: final.quotedFare,
    waitingCharge: final.waitingCharge,
    waitingSeconds: final.waitingSeconds,
    waitingChargeableMinutes: final.waitingChargeableMinutes,
    earlyDrop: final.earlyDrop,
    adjustmentsTotal: final.adjustmentsTotal,
  };
}

export interface RidePaymentView {
  paymentId: string;
  gatewayPaymentId?: string;
  method?: string;
  amount?: number;
  paidAt?: Date;
  failureReason?: string;
  refundedAmount?: number;
}

export interface RideView {
  id: string;
  rideCode: string;
  status: RideStatus;
  /** Monotonic per ride; clients keep the snapshot with the highest value. */
  stateVersion: number;
  /** NORMAL or CIRCUIT. */
  kind: RideKind;
  /** Circuit rides only: package, stops with progress, usage and the running bill. */
  circuit?: CircuitView;
  rideType: string;
  vehicleType: string;
  pickup: RideLocation;
  destination: RideLocation;
  distanceMeters: number;
  durationSeconds: number;
  routeProvider: string;
  /** Pickup → destination road path (Google encoded polyline); absent for straight-line routes. */
  routePolyline?: string;
  fare: RideFareView;
  /** Upfront rides: the waiting terms and meter (absent on metered rides). */
  waiting?: RideWaitingView;
  requestedAt: Date;
  assignedAt?: Date;
  acceptedAt?: Date;
  arrivedAt?: Date;
  startedAt?: Date;
  /** The driver asked to end the trip; the fare is priced to this moment. */
  endRequestedAt?: Date;
  completedAt?: Date;
  /** How the trip ended (OTP, driver override, admin, SOS). */
  completionMode?: RideCompletionMode;
  cancelledAt?: Date;
  expiredAt?: Date;
  /** Only while SEARCHING — lets the app show how long it will keep trying. */
  searchExpiresAt?: Date;
  cancellation?: {
    cancelledBy: RideActorType;
    reason?: string;
    reasonCode?: string;
    feeAmount?: number;
    /** NOT_APPLICABLE | DUE | WAIVED | COLLECTED */
    feeStatus?: string;
  };
  promo?: { code: string; title: string; discount: number };
  zone?: { id: string; name: string };
  /** Money state (Phase 4). COMPLETED + PENDING/FAILED means "pay now". */
  paymentStatus: RidePaymentStatus;
  payment?: RidePaymentView;
}

export interface RideDriverInfo {
  name: string;
  phone: string;
  ratingAverage: number;
  ratingCount: number;
  totalRides: number;
  vehicle?: Omit<RideVehicle, "vehicleId">;
  /**
   * Last known position once the driver is committed (accepted → started),
   * so the customer map can place the driver before the next live update.
   */
  location?: {
    latitude: number;
    longitude: number;
    heading?: number;
    updatedAt: Date;
  };
}

/** START: shown once the driver arrived. END: shown once the driver asked to end the trip. */
export type RideOtpPurpose = "START" | "END";

export interface CustomerRideView extends RideView {
  driver?: RideDriverInfo;
  /**
   * The code the customer reads to the driver: the start code in
   * DRIVER_ARRIVED, the end-of-trip code in RIDE_STARTED once the driver
   * asked to end it. Only ever in the ride's own customer's view.
   */
  otp?: { code: string; expiresAt?: Date; purpose: RideOtpPurpose };
}

/** The driver's side of the end-of-trip code (never the code itself). */
export interface DriverEndOtpView {
  requestedAt: Date;
  expiresAt?: Date;
  /** From this moment "rider not responding" can complete the trip. */
  overrideAvailableAt: Date;
}

/** What the driver takes home from this ride: the fare less Tirvona's commission (promo discounts are Tirvona-funded). */
export interface DriverEarningView {
  /** The trip fare the driver earns on: the locked/estimated fare, or the final fare once known. */
  gross: number;
  commissionPercent: number;
  commission: number;
  net: number;
  /** The final fare is known (the ride is completed); otherwise this is the fare quoted at booking. */
  final: boolean;
}

export interface DriverRideView extends RideView {
  /** What the driver earns on this ride (absent when no commission rate is configured). */
  earning?: DriverEarningView;
  customer: { name: string; phone?: string };
  /** Present while the driver has asked to end the trip and it is not yet completed. */
  endOtp?: DriverEndOtpView;
  /** Respond before this or the request moves to another driver. */
  assignmentExpiresAt?: Date;
  /** Approximate straight-line distance from the driver to the pickup. */
  pickupDistanceMeters?: number;
}

const fullName = (
  user?: Pick<UserDocument, "firstName" | "lastName"> | null,
): string =>
  user
    ? [user.firstName, user.lastName].filter(Boolean).join(" ")
    : "Tirvona user";

// Driver details are shown from assignment until the ride closes normally.
const SHOWS_DRIVER: readonly RideStatus[] = [
  RideStatus.DRIVER_ASSIGNED,
  ...DRIVER_ENGAGED_STATUSES,
  RideStatus.COMPLETED,
  RideStatus.CANCELLED,
];

@Injectable()
export class RideViewService {
  private readonly overrideWaitSeconds: number;

  constructor(
    @InjectModel(User.name) private readonly userModel: Model<User>,
    @InjectModel(DriverProfile.name)
    private readonly driverModel: Model<DriverProfile>,
    private readonly locations: LocationsService,
    private readonly driverLocations: DriverLocationService,
    private readonly commissions: CommissionService,
    config: ConfigService,
  ) {
    this.overrideWaitSeconds = config.getOrThrow<number>(
      "rideEndOverrideWaitSeconds",
    );
  }

  base(ride: RideDocument): RideView {
    return {
      id: ride._id.toString(),
      rideCode: ride.rideCode,
      status: ride.status,
      stateVersion: ride.stateVersion ?? 0,
      kind: ride.kind ?? RideKind.NORMAL,
      circuit:
        ride.kind === RideKind.CIRCUIT && ride.circuit
          ? circuitView(ride.circuit, ride)
          : undefined,
      rideType: ride.rideType,
      vehicleType: ride.vehicleType,
      pickup: {
        address: ride.pickup.address,
        latitude: ride.pickup.latitude,
        longitude: ride.pickup.longitude,
      },
      destination: {
        address: ride.destination.address,
        latitude: ride.destination.latitude,
        longitude: ride.destination.longitude,
      },
      distanceMeters: ride.distanceMeters,
      durationSeconds: ride.durationSeconds,
      routeProvider: ride.routeProvider,
      routePolyline: ride.routePolyline,
      fare: {
        currency: ride.fare.currency,
        baseFare: ride.fare.baseFare,
        perKmRate: ride.fare.perKmRate,
        basePerKmRate: ride.fare.basePerKmRate ?? ride.fare.perKmRate,
        peak: ride.fare.peak && {
          name: ride.fare.peak.name,
          hikePercent: ride.fare.peak.hikePercent,
          startTime: ride.fare.peak.startTime,
          endTime: ride.fare.peak.endTime,
          surcharge: ride.fare.peak.surcharge,
        },
        perMinuteRate: ride.fare.perMinuteRate,
        minimumFare: ride.fare.minimumFare,
        distanceCharge: ride.fare.distanceCharge,
        timeCharge: ride.fare.timeCharge,
        subtotal: ride.fare.subtotal,
        minimumFareApplied: ride.fare.minimumFareApplied,
        estimatedFare: ride.fare.estimatedFare,
        finalFare: ride.fare.finalFare,
        discount: ride.fare.discount,
        payableFare: ride.fare.payableFare,
        final: finalFareView(ride.fare.final),
        pricingMode: ride.fare.pricingMode ?? DEFAULT_PRICING_MODE,
        quotedFare: ride.fare.quotedFare,
        quotedAt: ride.fare.quotedAt,
        adjustments: ride.fare.adjustments?.length
          ? ride.fare.adjustments.map(adjustmentView)
          : undefined,
      },
      waiting: waitingView(ride),
      requestedAt: ride.requestedAt,
      assignedAt: ride.assignedAt,
      acceptedAt: ride.acceptedAt,
      arrivedAt: ride.arrivedAt,
      startedAt: ride.startedAt,
      endRequestedAt: ride.endRequestedAt,
      completedAt: ride.completedAt,
      completionMode: ride.completionMode,
      cancelledAt: ride.cancelledAt,
      expiredAt: ride.expiredAt,
      searchExpiresAt:
        ride.status === RideStatus.SEARCHING ? ride.searchExpiresAt : undefined,
      cancellation: ride.cancellation
        ? {
            cancelledBy: ride.cancellation.cancelledBy,
            reason: ride.cancellation.reason,
            reasonCode: ride.cancellation.reasonCode,
            feeAmount: ride.cancellation.feeAmount,
            feeStatus: ride.cancellation.feeStatus,
          }
        : undefined,
      promo: ride.promo
        ? {
            code: ride.promo.code,
            title: ride.promo.title,
            discount: ride.fare.discount ?? ride.promo.estimatedDiscount,
          }
        : undefined,
      zone:
        ride.zoneId && ride.zoneName
          ? { id: ride.zoneId.toString(), name: ride.zoneName }
          : undefined,
      paymentStatus: effectivePaymentStatus(ride),
      payment: ride.payment
        ? {
            paymentId: ride.payment.paymentId.toString(),
            gatewayPaymentId: ride.payment.gatewayPaymentId,
            method: ride.payment.method,
            amount: ride.payment.amount,
            paidAt: ride.payment.paidAt,
            failureReason: ride.payment.failureReason,
            refundedAmount: ride.payment.refundedAmount,
          }
        : undefined,
    };
  }

  /** `ride` must have been loaded with `+otpCode` for the OTP to appear. */
  async forCustomer(ride: RideDocument): Promise<CustomerRideView> {
    const view: CustomerRideView = this.base(ride);
    if (ride.driverId && SHOWS_DRIVER.includes(ride.status)) {
      view.driver = await this.driverInfo(ride.driverId, ride.vehicle);
      if (view.driver && DRIVER_ENGAGED_STATUSES.includes(ride.status))
        view.driver.location = await this.driverLocations.lastKnown(
          ride.driverId,
        );
      // Like the customer's number for the driver, the driver's number is
      // shared only while the driver is committed to the ride (accepted →
      // started): not while an offer is pending, and not after it ends.
      else if (view.driver) view.driver.phone = "";
    }
    if (ride.status === RideStatus.DRIVER_ARRIVED && ride.otpCode)
      view.otp = {
        code: ride.otpCode,
        expiresAt: ride.otpExpiresAt,
        purpose: "START",
      };
    else if (
      ride.status === RideStatus.RIDE_STARTED &&
      ride.endRequestedAt &&
      ride.endOtpCode
    )
      view.otp = {
        code: ride.endOtpCode,
        expiresAt: ride.endOtpExpiresAt,
        purpose: "END",
      };
    return view;
  }

  async forDriver(
    ride: RideDocument,
    driver: DriverProfileDocument,
  ): Promise<DriverRideView> {
    const customer = await this.userModel
      .findById(ride.customerId)
      .select("firstName lastName phone")
      .lean()
      .exec();
    // The customer's phone is shared only once the driver has committed.
    const engaged = DRIVER_ENGAGED_STATUSES.includes(ride.status);
    return {
      ...this.base(ride),
      earning: await this.earningFor(ride),
      customer: {
        name: engaged
          ? fullName(customer)
          : (customer?.firstName ?? "Customer"),
        phone: engaged ? customer?.phone : undefined,
      },
      endOtp:
        ride.status === RideStatus.RIDE_STARTED && ride.endRequestedAt
          ? {
              requestedAt: ride.endRequestedAt,
              expiresAt: ride.endOtpExpiresAt,
              overrideAvailableAt: overrideAvailableAt(
                ride.endRequestedAt,
                this.overrideWaitSeconds,
              ),
            }
          : undefined,
      assignmentExpiresAt:
        ride.status === RideStatus.DRIVER_ASSIGNED
          ? ride.assignmentExpiresAt
          : undefined,
      pickupDistanceMeters: driver.currentLocation
        ? this.locations.approximateDistanceMeters(
            fromGeoJsonPoint(driver.currentLocation),
            ride.pickup,
          )
        : ride.driverDistanceMeters,
    };
  }

  /** Fare less commission, at the rate in force now (the final earning uses the rate at completion). */
  private async earningFor(
    ride: RideDocument,
  ): Promise<DriverEarningView | undefined> {
    try {
      const commission = await this.commissions.resolve(
        ride.rideType,
        ride.completedAt ?? new Date(),
      );
      const gross = ride.fare.finalFare ?? ride.fare.estimatedFare;
      const split = splitFare(toPaise(gross), commission.value);
      return {
        gross,
        commissionPercent: commission.value,
        commission: toRupees(split.commissionPaise),
        net: toRupees(split.netEarningPaise),
        final: ride.fare.finalFare !== undefined,
      };
    } catch {
      // An offer must still show without an earning estimate.
      return undefined;
    }
  }

  async driverInfo(
    driverId: Types.ObjectId,
    vehicle?: RideVehicle,
  ): Promise<RideDriverInfo | undefined> {
    const profile = await this.driverModel.findById(driverId).lean().exec();
    if (!profile) return undefined;
    const user = await this.userModel
      .findById(profile.userId)
      .select("firstName lastName phone")
      .lean()
      .exec();
    return {
      name: fullName(user),
      phone: user?.phone ?? "",
      ratingAverage: profile.ratingAverage,
      ratingCount: profile.ratingCount ?? 0,
      totalRides: profile.totalRides,
      vehicle: vehicle
        ? {
            vehicleType: vehicle.vehicleType,
            registrationNumber: vehicle.registrationNumber,
            make: vehicle.make,
            model: vehicle.model,
            color: vehicle.color,
          }
        : undefined,
    };
  }
}

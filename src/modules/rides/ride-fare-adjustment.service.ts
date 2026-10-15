import { HttpStatus, Injectable } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import { ApiException } from "../../common/exceptions/api.exception";
import { rideConflict, rideNotFound } from "./ride-errors";
import { RideEventsService } from "./ride-events.service";
import { RidePaymentStatus } from "./ride-payment-status";
import { RideStatus } from "./ride-state-machine";
import { RideKind } from "../circuit-rides/circuit-ride.types";
import { FareAdjustmentType, Ride } from "./schemas/ride.schema";
import type { RideDocument, RideFareAdjustment } from "./schemas/ride.schema";

/** The smallest amount the payment gateway accepts; an adjustment may not push a bill below it. */
const MIN_PAYABLE_RUPEES = 1;

export interface FareAdjustmentInput {
  type: FareAdjustmentType;
  /** Positive rupees; the type decides the sign. */
  amount: number;
  reason: string;
  /** Required for a CHARGE: the customer agreed to pay more. */
  customerConsent?: boolean;
}

export interface FareAdjustmentResult {
  ride: RideDocument;
  /** Signed rupees applied to the fare. */
  delta: number;
  finalFareBefore: number;
  finalFareAfter: number;
  payableBefore: number;
  payableAfter: number;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * Manual fare corrections by operations (support, disputes, a missed toll).
 *
 * Only a completed ride whose bill is still unopened (payment PENDING: no
 * gateway order exists yet) can be adjusted — once an order exists its amount
 * is fixed, and once paid the existing refund flow is the way to give money
 * back. The change is one compare-and-set on the stored final fare, so two
 * admins adjusting at once cannot both win, and every change is appended to
 * the ride (never edited) and audited by the caller.
 */
@Injectable()
export class RideFareAdjustmentService {
  constructor(
    @InjectModel(Ride.name) private readonly rideModel: Model<Ride>,
    private readonly events: RideEventsService,
  ) {}

  async apply(
    rideId: string,
    adminUserId: string,
    input: FareAdjustmentInput,
  ): Promise<FareAdjustmentResult> {
    const ride = await this.rideModel.findById(rideId).exec();
    if (!ride) throw rideNotFound();
    this.assertAdjustable(ride, input);

    const finalFareBefore = ride.fare.finalFare as number;
    const payableBefore = ride.fare.payableFare ?? finalFareBefore;
    const delta = round2(
      input.type === FareAdjustmentType.CREDIT ? -input.amount : input.amount,
    );
    const finalFareAfter = round2(finalFareBefore + delta);
    const payableAfter = round2(payableBefore + delta);
    if (finalFareAfter < 0 || payableAfter < MIN_PAYABLE_RUPEES)
      throw new ApiException(
        HttpStatus.CONFLICT,
        `An adjustment cannot bring the amount payable below ₹${MIN_PAYABLE_RUPEES}`,
        "FARE_ADJUSTMENT_NOT_ALLOWED",
        { payableFare: payableBefore },
      );

    const adjustment: RideFareAdjustment = {
      type: input.type,
      amount: delta,
      reason: input.reason,
      source: "ADMIN",
      at: new Date(),
      by: new Types.ObjectId(adminUserId),
      ...(input.customerConsent !== undefined
        ? { customerConsent: input.customerConsent }
        : {}),
    };
    const adjustmentsTotal = round2(
      (ride.fare.final?.adjustmentsTotal ?? 0) + delta,
    );
    const updated = await this.rideModel
      .findOneAndUpdate(
        {
          _id: ride._id,
          status: RideStatus.COMPLETED,
          // No gateway order exists yet, and the bill is the one we read.
          paymentStatus: RidePaymentStatus.PENDING,
          "fare.finalFare": finalFareBefore,
        },
        {
          $set: {
            "fare.finalFare": finalFareAfter,
            "fare.payableFare": payableAfter,
            "fare.final.total": finalFareAfter,
            "fare.final.payable": payableAfter,
            "fare.final.adjustmentsTotal": adjustmentsTotal,
          },
          $push: { "fare.adjustments": adjustment },
          // Clients keep the snapshot with the highest version.
          $inc: { stateVersion: 1 },
        },
        { returnDocument: "after", runValidators: true },
      )
      .exec();
    if (!updated)
      throw rideConflict(
        "The ride's bill changed or a payment started. Reload and retry.",
        ride.status,
        "FARE_ADJUSTMENT_NOT_ALLOWED",
      );
    // Both apps show the new amount at once (the pay screen reads the ride).
    this.events.paymentUpdated(
      updated._id,
      { paymentStatus: updated.paymentStatus, fareAdjusted: true },
      updated,
    );
    return {
      ride: updated,
      delta,
      finalFareBefore,
      finalFareAfter,
      payableBefore,
      payableAfter,
    };
  }

  private assertAdjustable(
    ride: RideDocument,
    input: FareAdjustmentInput,
  ): void {
    const refuse = (message: string, data?: Record<string, unknown>) =>
      new ApiException(
        HttpStatus.CONFLICT,
        message,
        "FARE_ADJUSTMENT_NOT_ALLOWED",
        { currentStatus: ride.status, ...data },
      );
    if (ride.kind === RideKind.CIRCUIT)
      throw refuse("Circuit bills are not adjusted here");
    if (ride.status !== RideStatus.COMPLETED || !ride.fare.final)
      throw refuse("Only a completed ride's fare can be adjusted");
    if (ride.paymentStatus !== RidePaymentStatus.PENDING)
      throw refuse(
        ride.paymentStatus === RidePaymentStatus.NOT_REQUIRED
          ? "This ride has nothing to pay"
          : "Payment has already started. Once it is paid, use a refund instead",
        { paymentStatus: ride.paymentStatus },
      );
    if (
      input.type === FareAdjustmentType.CHARGE &&
      input.customerConsent !== true
    )
      throw refuse("Charging more needs the customer's consent");
  }
}

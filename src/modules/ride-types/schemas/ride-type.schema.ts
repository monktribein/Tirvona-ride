import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import type { HydratedDocument } from "mongoose";
import { PricingMode, WAITING_DEFAULTS, WAITING_LIMITS } from "../../pricing/upfront-fare";
import type { VehicleType } from "../../vehicles/schemas/vehicle.schema";

/**
 * The V1 products seeded on first boot (locked blueprint: BIKE, AUTO,
 * E_RICKSHAW, CAB). Since Phase 7 a ride type's code is data, not an enum:
 * admins can create further products (e.g. "BUS") without a deploy. These constants remain for seeds, tests and defaults.
 */
export enum RideTypeCode {
  BIKE = "BIKE",
  AUTO = "AUTO",
  E_RICKSHAW = "E_RICKSHAW",
  CAB = "CAB",
}

/** Upper-case letters, digits and underscores, starting with a letter. */
export const RIDE_TYPE_CODE_PATTERN = /^[A-Z][A-Z0-9_]{1,23}$/;

/** Largest seat count an admin can give a ride type (a bus needs more than a cab). */
export const MAX_SEAT_CAPACITY = 60;

/**
 * A ride type IS a vehicle type: its code is the code drivers register their
 * vehicle under and what matching filters on, so `vehicleType` always equals
 * `code`. Creating a ride type (e.g. "BUS") therefore creates the vehicle type
 * too, and only drivers with a vehicle of that type serve it.
 *
 * Never deleted: historical rides reference the code, so a retired product
 * is switched off (isActive=false) and stays readable.
 */
@Schema({ timestamps: true, collection: "ride_types" })
export class RideType {
  @Prop({ required: true, match: RIDE_TYPE_CODE_PATTERN, immutable: true })
  code!: string;

  @Prop({ required: true, trim: true })
  displayName!: string;

  @Prop({ trim: true })
  description?: string;

  /** Stable icon key the mobile apps map to a bundled icon (bike, auto, e_rickshaw, cab). */
  @Prop({ required: true, trim: true })
  icon!: string;

  /** Vehicle type drivers must have to serve this ride type; always equal to `code`. */
  @Prop({ required: true, uppercase: true, trim: true })
  vehicleType!: VehicleType;

  @Prop({ required: true, min: 1, max: MAX_SEAT_CAPACITY })
  seatCapacity!: number;

  /**
   * Whether a driver of this vehicle type must provide a driving licence
   * (number, expiry and document) to complete KYC. Absent means required;
   * an admin switches it off for types such as the e-rickshaw.
   */
  @Prop({ required: true, default: true })
  licenseRequired!: boolean;

  /**
   * UPFRONT: the fare quoted at booking is the fare (plus waiting, less an
   * early drop). METERED: recalculated from the actual trip at completion.
   * Absent on rows from before upfront fares = METERED.
   */
  @Prop({ required: true, enum: PricingMode, default: PricingMode.METERED })
  pricingMode!: PricingMode;

  /** Free wait at the pickup (minutes) before waiting is charged. UPFRONT rides only. */
  @Prop({
    required: true,
    default: WAITING_DEFAULTS.freeMinutes,
    min: WAITING_LIMITS.freeMinutes.min,
    max: WAITING_LIMITS.freeMinutes.max,
  })
  waitFreeMinutes!: number;

  /** Rupees per chargeable waiting minute; 0 = waiting is free. */
  @Prop({
    required: true,
    default: WAITING_DEFAULTS.perMinuteRate,
    min: WAITING_LIMITS.perMinuteRate.min,
    max: WAITING_LIMITS.perMinuteRate.max,
  })
  waitPerMinuteRate!: number;

  /** Cap on chargeable waiting minutes. */
  @Prop({
    required: true,
    default: WAITING_DEFAULTS.maxChargeMinutes,
    min: WAITING_LIMITS.maxChargeMinutes.min,
    max: WAITING_LIMITS.maxChargeMinutes.max,
  })
  waitMaxChargeMinutes!: number;

  @Prop({ required: true, default: 0 })
  sortOrder!: number;

  /** ACTIVE = customers can book it; INACTIVE = hidden from booking, history kept. */
  @Prop({ required: true, default: true })
  isActive!: boolean;
}

export type RideTypeDocument = HydratedDocument<RideType>;
export const RideTypeSchema = SchemaFactory.createForClass(RideType);

RideTypeSchema.index({ code: 1 }, { unique: true });
RideTypeSchema.index({ isActive: 1, sortOrder: 1 });

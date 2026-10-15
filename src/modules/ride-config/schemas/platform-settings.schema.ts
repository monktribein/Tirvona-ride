import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";
import { FARE_SETTING_LIMITS } from "../../pricing/upfront-fare";

/** The one document of ride/matching settings; `key` makes "exactly one" a unique index. */
export const RIDE_MATCHING_SETTINGS_KEY = "ride-matching";

/**
 * Platform-wide ride and matching settings (not per ride type):
 * - matchingRadiusKm: how far from the pickup dispatch looks for a driver
 *   (also the supply/ETA shown on a quote).
 * - nearbyDriversRadiusKm: how far around the rider the Home map draws cars.
 * They are separate on purpose and unrelated to the per-ride-type trip limits.
 *
 * Upfront-fare settings live here too (absent = the defaults in
 * FARE_SETTING_DEFAULTS, so a deploy changes nothing until an admin edits them):
 * - quoteValiditySeconds: how long a quote can be confirmed;
 * - etaBufferPercent: slack added to the route ETA when quoting;
 * - earlyDropThresholdPercent: share of the booked distance below which an
 *   early-ended trip is priced on the distance actually travelled.
 */
@Schema({ timestamps: true, collection: "platform_settings" })
export class PlatformSettings {
  @Prop({
    required: true,
    immutable: true,
    default: RIDE_MATCHING_SETTINGS_KEY,
  })
  key!: string;

  @Prop({ required: true, min: 0.001 })
  matchingRadiusKm!: number;

  @Prop({ required: true, min: 0.001 })
  nearbyDriversRadiusKm!: number;

  @Prop({
    min: FARE_SETTING_LIMITS.quoteValiditySeconds.min,
    max: FARE_SETTING_LIMITS.quoteValiditySeconds.max,
  })
  quoteValiditySeconds?: number;

  @Prop({
    min: FARE_SETTING_LIMITS.etaBufferPercent.min,
    max: FARE_SETTING_LIMITS.etaBufferPercent.max,
  })
  etaBufferPercent?: number;

  @Prop({
    min: FARE_SETTING_LIMITS.earlyDropThresholdPercent.min,
    max: FARE_SETTING_LIMITS.earlyDropThresholdPercent.max,
  })
  earlyDropThresholdPercent?: number;

  @Prop({ required: true, min: 1, default: 1 })
  version!: number;

  @Prop({ type: SchemaTypes.ObjectId, ref: "User" })
  updatedBy?: Types.ObjectId;
}

export type PlatformSettingsDocument = HydratedDocument<PlatformSettings>;
export const PlatformSettingsSchema =
  SchemaFactory.createForClass(PlatformSettings);

PlatformSettingsSchema.index({ key: 1 }, { unique: true });

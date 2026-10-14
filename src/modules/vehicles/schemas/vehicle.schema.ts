import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * A vehicle type is the code of a ride type: the two are one and the same, so
 * an admin who creates a ride type (e.g. "BUS") has created the vehicle type
 * drivers register and that matching filters on. It is data, not an enum;
 * RideTypesService#assertVehicleType checks that a code exists. The constant
 * keeps the four seeded codes handy for seeds, defaults and tests.
 */
export type VehicleType = string;
export const VehicleType = {
  BIKE: "BIKE",
  AUTO: "AUTO",
  E_RICKSHAW: "E_RICKSHAW",
  CAB: "CAB",
} as const;

@Schema({ timestamps: true, collection: "vehicles" })
export class Vehicle {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "DriverProfile" })
  driverId!: Types.ObjectId;

  @Prop({ required: true, uppercase: true, trim: true })
  vehicleType!: VehicleType;

  @Prop({ required: true, uppercase: true, trim: true })
  registrationNumber!: string;

  @Prop()
  make?: string;

  // Named `vehicleModel`, not `model` — the latter collides with Mongoose's
  // built-in Document#model() method and breaks the generated types.
  @Prop()
  vehicleModel?: string;

  @Prop()
  color?: string;

  @Prop()
  manufactureYear?: number;

  @Prop()
  vehicleImage?: string;

  @Prop({ required: true, default: true })
  isActive!: boolean;
}

export type VehicleDocument = HydratedDocument<Vehicle>;
export const VehicleSchema = SchemaFactory.createForClass(Vehicle);

VehicleSchema.index({ registrationNumber: 1 }, { unique: true });
VehicleSchema.index({ driverId: 1, isActive: 1 });
// One active vehicle per driver account.
VehicleSchema.index(
  { driverId: 1 },
  { unique: true, partialFilterExpression: { isActive: true } },
);

import { Injectable, Logger } from "@nestjs/common";
import type { OnModuleInit } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import {
  apiBadRequest,
  apiConflict,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import { DEFAULT_PRICING_MODE, WAITING_DEFAULTS } from "../pricing/upfront-fare";
import type { PricingMode, WaitingTerms } from "../pricing/upfront-fare";
import type {
  CreateRideTypeDto,
  UpdateRideTypeDto,
} from "./dto/update-ride-type.dto";
import { DEFAULT_RIDE_TYPES } from "./ride-types.seed";
import { RideType } from "./schemas/ride-type.schema";
import type { RideTypeDocument } from "./schemas/ride-type.schema";

export interface RideTypeSummary {
  id: string;
  code: string;
  displayName: string;
  description?: string;
  icon: string;
  /** Always equal to `code`: a ride type is a vehicle type. */
  vehicleType: string;
  seatCapacity: number;
  /** Drivers of this vehicle type must provide a driving licence for KYC. */
  licenseRequired: boolean;
  /** UPFRONT (the booked fare is the fare) or METERED (recalculated at completion). */
  pricingMode: PricingMode;
  waitFreeMinutes: number;
  waitPerMinuteRate: number;
  waitMaxChargeMinutes: number;
  sortOrder: number;
  isActive: boolean;
  updatedAt: Date;
}

/** The waiting terms of a ride type, with defaults for rows from before they existed. */
export function waitingTermsOf(
  rideType: Pick<
    RideTypeDocument,
    "waitFreeMinutes" | "waitPerMinuteRate" | "waitMaxChargeMinutes"
  >,
): WaitingTerms {
  return {
    freeMinutes: rideType.waitFreeMinutes ?? WAITING_DEFAULTS.freeMinutes,
    perMinuteRate: rideType.waitPerMinuteRate ?? WAITING_DEFAULTS.perMinuteRate,
    maxChargeMinutes:
      rideType.waitMaxChargeMinutes ?? WAITING_DEFAULTS.maxChargeMinutes,
  };
}

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | undefined)?.code === 11000;

@Injectable()
export class RideTypesService implements OnModuleInit {
  private readonly logger = new Logger(RideTypesService.name);

  constructor(
    @InjectModel(RideType.name) private readonly rideTypeModel: Model<RideType>,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.seedDefaults();
    await this.warnAboutLegacyVehicleTypes();
  }

  /**
   * A ride type used to be able to point at another ride type's vehicle type
   * (e.g. CAB_XL served by CAB). Now they are one and the same; rows created
   * the old way keep working but are flagged so an admin can retire them.
   */
  private async warnAboutLegacyVehicleTypes(): Promise<void> {
    const legacy = await this.rideTypeModel
      .find({ $expr: { $ne: ["$vehicleType", "$code"] } })
      .select("code vehicleType")
      .lean()
      .exec();
    for (const row of legacy)
      this.logger.warn(
        `Ride type ${row.code} is served by vehicle type ${row.vehicleType}; new ride types always use their own code`,
      );
  }

  /** Idempotent and safe to run concurrently from several instances. */
  async seedDefaults(): Promise<void> {
    for (const rideType of DEFAULT_RIDE_TYPES) {
      try {
        const result = await this.rideTypeModel
          .updateOne(
            { code: rideType.code },
            { $setOnInsert: rideType },
            { upsert: true },
          )
          .exec();
        if (result.upsertedCount > 0)
          this.logger.log(`Seeded ride type ${rideType.code}`);
      } catch (error) {
        // Another instance won the upsert race; the row exists either way.
        if (!isDuplicateKey(error)) throw error;
      }
    }
  }

  toSummary(rideType: RideTypeDocument): RideTypeSummary {
    return {
      id: rideType._id.toString(),
      code: rideType.code,
      displayName: rideType.displayName,
      description: rideType.description,
      icon: rideType.icon,
      vehicleType: rideType.vehicleType,
      seatCapacity: rideType.seatCapacity,
      licenseRequired: rideType.licenseRequired !== false,
      pricingMode: rideType.pricingMode ?? DEFAULT_PRICING_MODE,
      waitFreeMinutes: rideType.waitFreeMinutes ?? WAITING_DEFAULTS.freeMinutes,
      waitPerMinuteRate:
        rideType.waitPerMinuteRate ?? WAITING_DEFAULTS.perMinuteRate,
      waitMaxChargeMinutes:
        rideType.waitMaxChargeMinutes ?? WAITING_DEFAULTS.maxChargeMinutes,
      sortOrder: rideType.sortOrder,
      isActive: rideType.isActive,
      updatedAt: rideType.get("updatedAt") as Date,
    };
  }

  async listActive(): Promise<RideTypeDocument[]> {
    return this.rideTypeModel
      .find({ isActive: true })
      .sort({ sortOrder: 1 })
      .exec();
  }

  async listAll(): Promise<RideTypeDocument[]> {
    return this.rideTypeModel.find().sort({ sortOrder: 1 }).exec();
  }

  /**
   * Vehicle types drivers can register: every ride type's code, switched on
   * or not (an e-rickshaw driver can register before the product launches).
   */
  async listVehicleTypes(): Promise<RideTypeDocument[]> {
    return this.listAll();
  }

  /**
   * Whether KYC needs a driving licence from drivers of this vehicle type.
   * Unknown types and rows from before the flag existed count as required.
   */
  async isLicenseRequired(vehicleType: string | undefined): Promise<boolean> {
    if (!vehicleType) return true;
    const rideType = await this.rideTypeModel
      .findOne({ code: vehicleType })
      .select("licenseRequired")
      .lean()
      .exec();
    return rideType?.licenseRequired !== false;
  }

  /** A vehicle type is valid when a ride type with that code exists. */
  async assertVehicleType(code: string): Promise<void> {
    if (!(await this.rideTypeModel.exists({ code })))
      throw apiBadRequest(
        `${code} is not a vehicle type Tirvona serves`,
        "VEHICLE_TYPE_INVALID",
      );
  }

  async findByCode(code: string): Promise<RideTypeDocument | null> {
    return this.rideTypeModel.findOne({ code }).exec();
  }

  async getByCode(code: string): Promise<RideTypeDocument> {
    const rideType = await this.rideTypeModel.findOne({ code }).exec();
    if (!rideType)
      throw apiNotFound("Ride type not found", "RIDE_TYPE_NOT_FOUND");
    return rideType;
  }

  /** For booking: the ride type must exist and be switched on. */
  async getBookable(code: string): Promise<RideTypeDocument> {
    const rideType = await this.getByCode(code);
    if (!rideType.isActive)
      throw apiBadRequest(
        `${rideType.displayName} rides are not available right now`,
        "RIDE_TYPE_INACTIVE",
      );
    return rideType;
  }

  async create(
    dto: Omit<CreateRideTypeDto, "pricing">,
  ): Promise<RideTypeDocument> {
    try {
      return await this.rideTypeModel.create({
        code: dto.code,
        displayName: dto.displayName,
        description: dto.description,
        icon: dto.icon,
        vehicleType: dto.code,
        seatCapacity: dto.seatCapacity,
        licenseRequired: dto.licenseRequired ?? true,
        pricingMode: dto.pricingMode ?? DEFAULT_PRICING_MODE,
        waitFreeMinutes: dto.waitFreeMinutes ?? WAITING_DEFAULTS.freeMinutes,
        waitPerMinuteRate:
          dto.waitPerMinuteRate ?? WAITING_DEFAULTS.perMinuteRate,
        waitMaxChargeMinutes:
          dto.waitMaxChargeMinutes ?? WAITING_DEFAULTS.maxChargeMinutes,
        sortOrder: dto.sortOrder ?? 50,
        isActive: dto.isActive ?? false,
      });
    } catch (error) {
      if (isDuplicateKey(error))
        throw apiConflict(
          `A ride type with code ${dto.code} already exists`,
          "RIDE_TYPE_ALREADY_EXISTS",
        );
      throw error;
    }
  }

  /**
   * Edits never touch rides already booked: each ride snapshots its ride
   * type code, vehicle type and fare at booking. There is no delete — a
   * retired product is deactivated so historical rides stay readable.
   */
  async update(
    code: string,
    dto: UpdateRideTypeDto,
  ): Promise<RideTypeDocument> {
    const rideType = await this.getByCode(code);
    if (dto.displayName !== undefined) rideType.displayName = dto.displayName;
    if (dto.description !== undefined) rideType.description = dto.description;
    if (dto.icon !== undefined) rideType.icon = dto.icon;
    if (dto.seatCapacity !== undefined)
      rideType.seatCapacity = dto.seatCapacity;
    if (dto.licenseRequired !== undefined)
      rideType.licenseRequired = dto.licenseRequired;
    if (dto.pricingMode !== undefined) rideType.pricingMode = dto.pricingMode;
    if (dto.waitFreeMinutes !== undefined)
      rideType.waitFreeMinutes = dto.waitFreeMinutes;
    if (dto.waitPerMinuteRate !== undefined)
      rideType.waitPerMinuteRate = dto.waitPerMinuteRate;
    if (dto.waitMaxChargeMinutes !== undefined)
      rideType.waitMaxChargeMinutes = dto.waitMaxChargeMinutes;
    if (dto.isActive !== undefined) rideType.isActive = dto.isActive;
    if (dto.sortOrder !== undefined) rideType.sortOrder = dto.sortOrder;
    await rideType.save();
    return rideType;
  }
}

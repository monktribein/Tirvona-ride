import { HttpStatus, Injectable, Logger } from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import {
  ApiException,
  apiBadRequest,
} from "../../common/exceptions/api.exception";
import {
  FARE_SETTING_DEFAULTS,
  FARE_SETTING_LIMITS,
} from "../pricing/upfront-fare";
import type { FareSettings } from "../pricing/upfront-fare";
import { radiiProblem } from "./distance-policy";
import { MIGRATION_DEFAULTS } from "./ride-config.limits";
import {
  PlatformSettings,
  RIDE_MATCHING_SETTINGS_KEY,
} from "./schemas/platform-settings.schema";
import type { PlatformSettingsDocument } from "./schemas/platform-settings.schema";

const isDuplicateKey = (error: unknown): boolean =>
  (error as { code?: number } | undefined)?.code === 11000;

export interface PlatformSettingsView extends FareSettings {
  matchingRadiusKm: number;
  nearbyDriversRadiusKm: number;
  version: number;
  updatedBy?: string;
  updatedAt: Date;
}

export interface RadiiChanges extends Partial<FareSettings> {
  matchingRadiusKm?: number;
  nearbyDriversRadiusKm?: number;
}

const FARE_SETTING_KEYS = [
  "quoteValiditySeconds",
  "etaBufferPercent",
] as const;

function fareSettingsOf(
  settings: Partial<FareSettings> | null | undefined,
): FareSettings {
  return {
    quoteValiditySeconds:
      settings?.quoteValiditySeconds ??
      FARE_SETTING_DEFAULTS.quoteValiditySeconds,
    etaBufferPercent:
      settings?.etaBufferPercent ?? FARE_SETTING_DEFAULTS.etaBufferPercent,
  };
}

/**
 * Matching and nearby-driver radii, read from MongoDB on every call (no cache:
 * an edit is live on the next request everywhere). Missing or unusable
 * settings are a 503 rather than a silent default.
 */
@Injectable()
export class PlatformSettingsService {
  private readonly logger = new Logger(PlatformSettingsService.name);

  constructor(
    @InjectModel(PlatformSettings.name)
    private readonly settingsModel: Model<PlatformSettings>,
  ) {}

  toView(settings: PlatformSettingsDocument): PlatformSettingsView {
    return {
      matchingRadiusKm: settings.matchingRadiusKm,
      nearbyDriversRadiusKm: settings.nearbyDriversRadiusKm,
      ...fareSettingsOf(settings),
      version: settings.version,
      updatedBy: settings.updatedBy?.toString(),
      updatedAt: settings.get("updatedAt") as Date,
    };
  }

  async find(): Promise<PlatformSettingsDocument | null> {
    return this.settingsModel
      .findOne({ key: RIDE_MATCHING_SETTINGS_KEY })
      .exec();
  }

  /**
   * Upfront-fare settings, read on every call like the radii. Unlike the
   * radii they have safe defaults, so a missing document or field is the
   * default rather than a 503.
   */
  async fareSettings(): Promise<FareSettings> {
    return fareSettingsOf(await this.find());
  }

  async getRequired(): Promise<PlatformSettingsDocument> {
    const settings = await this.find();
    if (!settings)
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Ride matching settings are not configured",
        "PLATFORM_SETTINGS_MISSING",
      );
    const problem = radiiProblem(settings);
    if (problem) {
      this.logger.error(
        `Platform ride/matching settings are invalid: ${problem}`,
      );
      throw new ApiException(
        HttpStatus.SERVICE_UNAVAILABLE,
        "Ride matching settings are misconfigured",
        "PLATFORM_SETTINGS_INVALID",
      );
    }
    return settings;
  }

  /** How far from the pickup dispatch (and the quote's driver supply) searches, in metres. */
  async matchingRadiusMeters(): Promise<number> {
    return (await this.getRequired()).matchingRadiusKm * 1000;
  }

  /** How far around the rider the Home map shows cars, in metres. */
  async nearbyDriversRadiusMeters(): Promise<number> {
    return (await this.getRequired()).nearbyDriversRadiusKm * 1000;
  }

  /** Admin edit: unspecified radii keep their stored value; the result is validated as a whole. */
  async update(
    changes: RadiiChanges,
    adminId: string,
  ): Promise<{
    before: PlatformSettingsDocument | null;
    after: PlatformSettingsDocument;
  }> {
    const before = await this.find();
    const merged = {
      matchingRadiusKm: changes.matchingRadiusKm ?? before?.matchingRadiusKm,
      nearbyDriversRadiusKm:
        changes.nearbyDriversRadiusKm ?? before?.nearbyDriversRadiusKm,
    };
    const problem = radiiProblem(merged);
    if (problem) throw apiBadRequest(problem, "VALIDATION_FAILED");
    const fareChanges = Object.fromEntries(
      FARE_SETTING_KEYS.filter((key) => changes[key] !== undefined).map(
        (key) => [key, changes[key]],
      ),
    );
    for (const [key, value] of Object.entries(fareChanges)) {
      const limits = FARE_SETTING_LIMITS[key as (typeof FARE_SETTING_KEYS)[number]];
      if (
        typeof value !== "number" ||
        value < limits.min ||
        value > limits.max
      )
        throw apiBadRequest(
          `${key} must be between ${limits.min} and ${limits.max}`,
          "VALIDATION_FAILED",
        );
    }
    const after = await this.settingsModel
      .findOneAndUpdate(
        { key: RIDE_MATCHING_SETTINGS_KEY },
        {
          $set: {
            ...merged,
            ...fareChanges,
            updatedBy: new Types.ObjectId(adminId),
          },
          $inc: { version: 1 },
          $setOnInsert: { key: RIDE_MATCHING_SETTINGS_KEY },
        },
        { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
      )
      .exec();
    return { before, after };
  }

  /** First-boot migration (idempotent): writes the pre-admin-control values only when no document exists. */
  async migrateMissing(): Promise<void> {
    try {
      const result = await this.settingsModel
        .updateOne(
          { key: RIDE_MATCHING_SETTINGS_KEY },
          {
            $setOnInsert: {
              key: RIDE_MATCHING_SETTINGS_KEY,
              matchingRadiusKm: MIGRATION_DEFAULTS.matchingRadiusKm,
              nearbyDriversRadiusKm: MIGRATION_DEFAULTS.nearbyDriversRadiusKm,
              version: 1,
            },
          },
          { upsert: true },
        )
        .exec();
      if (result.upsertedCount > 0)
        this.logger.log(
          `Migrated ride/matching settings: matching ${MIGRATION_DEFAULTS.matchingRadiusKm} km, nearby drivers ${MIGRATION_DEFAULTS.nearbyDriversRadiusKm} km`,
        );
    } catch (error) {
      if (!isDuplicateKey(error)) throw error;
    }
  }
}

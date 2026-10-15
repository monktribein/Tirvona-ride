import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsInt,
  IsNumber,
  IsPositive,
  Max,
  Min,
  ValidateIf,
} from "class-validator";
import { FARE_SETTING_LIMITS } from "../../pricing/upfront-fare";

// Absent = keep the stored value. Unlike @IsOptional, an explicit null is NOT skipped: it fails the number check.
const whenSent = () =>
  ValidateIf((_object: unknown, value: unknown) => value !== undefined);

const DECIMALS = { allowNaN: false, allowInfinity: false, maxDecimalPlaces: 3 };

/** At least one field is required; an unset field keeps its stored value (the pair is re-validated as a whole). */
export class UpdateRideDistanceConfigDto {
  @ApiPropertyOptional({
    example: 200,
    description: "Shortest bookable trip, in metres",
  })
  @whenSent()
  @IsInt()
  @IsPositive()
  minDistanceMeters?: number;

  @ApiPropertyOptional({
    example: 80,
    description: "Longest bookable trip, in kilometres",
  })
  @whenSent()
  @IsNumber(DECIMALS)
  @IsPositive()
  maxDistanceKm?: number;
}

export class UpdatePlatformSettingsDto {
  @ApiPropertyOptional({
    example: 8,
    description: "How far from the pickup drivers are searched, in km",
  })
  @whenSent()
  @IsNumber(DECIMALS)
  @IsPositive()
  matchingRadiusKm?: number;

  @ApiPropertyOptional({
    example: 3,
    description: "How far around the rider the Home map shows cars, in km",
  })
  @whenSent()
  @IsNumber(DECIMALS)
  @IsPositive()
  nearbyDriversRadiusKm?: number;

  @ApiPropertyOptional({
    example: 300,
    description:
      "How long an upfront quote can be confirmed before the app must ask again, in seconds",
  })
  @whenSent()
  @IsInt()
  @Min(FARE_SETTING_LIMITS.quoteValiditySeconds.min)
  @Max(FARE_SETTING_LIMITS.quoteValiditySeconds.max)
  quoteValiditySeconds?: number;

  @ApiPropertyOptional({
    example: 10,
    description:
      "Percent added to the route ETA when pricing an upfront quote (slack for traffic)",
  })
  @whenSent()
  @IsInt()
  @Min(FARE_SETTING_LIMITS.etaBufferPercent.min)
  @Max(FARE_SETTING_LIMITS.etaBufferPercent.max)
  etaBufferPercent?: number;
}

/** Both limits at once, for creating a ride type. */
export class InitialDistanceDto {
  @ApiProperty({ example: 200 })
  @IsInt()
  @IsPositive()
  minDistanceMeters!: number;

  @ApiProperty({ example: 80 })
  @IsNumber(DECIMALS)
  @IsPositive()
  maxDistanceKm!: number;
}

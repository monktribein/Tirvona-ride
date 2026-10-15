import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsEnum, IsOptional, Matches } from "class-validator";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import { LOCAL_DATE, ReportPreset } from "../report-range";

export class ReportQueryDto {
  @ApiPropertyOptional({
    enum: ReportPreset,
    default: ReportPreset.LAST_7_DAYS,
  })
  @IsOptional()
  @IsEnum(ReportPreset)
  preset?: ReportPreset;

  @ApiPropertyOptional({
    example: "2026-09-01",
    description: "Custom range start (local date, inclusive)",
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: "from must be a date like 2026-09-01" })
  from?: string;

  @ApiPropertyOptional({
    example: "2026-09-26",
    description: "Custom range end (local date, inclusive)",
  })
  @IsOptional()
  @Matches(LOCAL_DATE, { message: "to must be a date like 2026-09-26" })
  to?: string;
}

export class FareQuotesQueryDto extends ReportQueryDto {
  @ApiPropertyOptional({
    example: "AUTO",
    description: "Only this ride type (default: all upfront ride types)",
  })
  @IsOptional()
  @Matches(RIDE_TYPE_CODE_PATTERN, {
    message: "rideType must be a ride type code such as AUTO",
  })
  rideType?: string;
}

import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Transform } from "class-transformer";
import {
  Matches,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Max,
  Min,
} from "class-validator";
import { RIDE_TYPE_CODE_PATTERN } from "../../ride-types/schemas/ride-type.schema";
import type { VehicleType } from "../schemas/vehicle.schema";

export class CreateVehicleDto {
  @ApiProperty({
    example: "CAB",
    description: "Code of a ride type (GET /vehicles/types)",
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(RIDE_TYPE_CODE_PATTERN, {
    message: "vehicleType is not a valid vehicle type code",
  })
  vehicleType!: VehicleType;

  @ApiProperty({ example: "UP32AB1234" })
  @IsString()
  @Length(4, 15)
  registrationNumber!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  make?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 60)
  model?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @Length(1, 40)
  color?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1980)
  @Max(new Date().getFullYear() + 1)
  manufactureYear?: number;
}

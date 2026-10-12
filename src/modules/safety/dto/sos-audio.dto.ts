import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

export class SosAudioStateDto {
  @ApiProperty({
    enum: ["RECORDING", "STOPPED", "PERMISSION_DENIED", "FAILED"],
  })
  @IsIn(["RECORDING", "STOPPED", "PERMISSION_DENIED", "FAILED"])
  state!: "RECORDING" | "STOPPED" | "PERMISSION_DENIED" | "FAILED";

  @ApiPropertyOptional({
    description: "Version of the recording notice the person accepted",
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Matches(/^[A-Za-z0-9._-]+$/)
  consentVersion?: string;
}

/** `GET …/audio/chunks`: chunks after `after`, or the newest `tail`. */
export class AudioChunkListQueryDto {
  @ApiPropertyOptional({ description: "Only chunks with seq greater than this" })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(-1)
  after?: number;

  @ApiPropertyOptional({
    description: "Start at the live edge: the newest N chunks",
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  tail?: number;
}

export class AudioDownloadQueryDto {
  @ApiPropertyOptional({ description: "1: send as a file download" })
  @IsOptional()
  @IsIn(["1"])
  download?: "1";
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import type { Request, Response } from "express";
import { Types } from "mongoose";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import { startOfDayInTimeZone } from "../../common/utils/time";
import { ComplaintsService } from "../complaints/complaints.service";
import type {
  AdminComplaintDetail,
  AdminComplaintView,
  ComplaintSummary,
} from "../complaints/complaints.service";
import {
  AdminListComplaintsQueryDto,
  UpdateComplaintDto,
} from "../complaints/dto/complaint.dto";
import type { Page } from "../rides/rides.service";
import {
  AudioChunkListQueryDto,
  AudioDownloadQueryDto,
} from "../safety/dto/sos-audio.dto";
import { ListSosQueryDto, UpdateSosDto } from "../safety/dto/sos.dto";
import { SosAudioService } from "../safety/sos-audio.service";
import type { AudioChunkList } from "../safety/sos-audio.service";
import { SosService } from "../safety/sos.service";
import type {
  AdminSosDetail,
  AdminSosListItem,
  SosSummary,
} from "../safety/sos.service";

@ApiTags("Admin · Safety")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/sos", version: "1" })
export class AdminSosController {
  constructor(
    private readonly sos: SosService,
    private readonly audio: SosAudioService,
  ) {}

  @Get()
  @ApiOperation({ summary: "SOS incidents (filter by status, or open=true)" })
  async list(
    @Query() query: ListSosQueryDto,
  ): Promise<ApiSuccessBody<Page<AdminSosListItem>>> {
    return ok(await this.sos.adminList(query));
  }

  @Get("summary")
  @ApiOperation({
    summary: "Active SOS counts (polled by the admin alert banner)",
  })
  async summary(): Promise<ApiSuccessBody<SosSummary>> {
    return ok(await this.sos.summary());
  }

  @Get(":id")
  @ApiOperation({
    summary: "One incident with ride, people, location, contacts and timeline",
  })
  async detail(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AdminSosDetail>> {
    return ok(await this.sos.adminDetail(id));
  }

  @Patch(":id")
  @ApiOperation({
    summary: "Acknowledge / mark in progress / resolve / close as false alarm",
  })
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateSosDto,
  ): Promise<ApiSuccessBody<AdminSosDetail>> {
    return ok(await this.sos.adminUpdate(admin.userId, id, dto));
  }

  // ── Microphone recording (docs/safety/sos-audio.md) ──────────────────

  @Get(":id/audio/chunks")
  @ApiOperation({
    summary:
      "Chunks of the SOS recording: after=<seq>, or tail=<n> for the live edge",
  })
  async audioChunks(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Query() query: AudioChunkListQueryDto,
  ): Promise<ApiSuccessBody<AudioChunkList>> {
    const sosId = new Types.ObjectId(id);
    // Starting to listen (not each poll) is what is logged.
    if (query.tail !== undefined)
      await this.audio.logAccess(
        sosId,
        { actor: "ADMIN", adminId: admin.userId },
        "LIVE",
      );
    return ok(await this.audio.listChunks(sosId, query));
  }

  @Get(":id/audio/chunks/:seq")
  @ApiOperation({ summary: "One chunk of the SOS recording as a WAV file" })
  async audioChunk(
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("seq", ParseIntPipe) seq: number,
    @Res() response: Response,
  ): Promise<void> {
    const wav = await this.audio.chunkWav(new Types.ObjectId(id), seq);
    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Content-Length", String(wav.length));
    response.end(wav);
  }

  @Get(":id/audio/recording")
  @ApiOperation({
    summary:
      "The SOS recording so far as one WAV file (Range supported; ?download=1 saves it)",
  })
  async audioRecording(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Query() query: AudioDownloadQueryDto,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    const sosId = new Types.ObjectId(id);
    const download = query.download === "1";
    await this.audio.logAccess(
      sosId,
      { actor: "ADMIN", adminId: admin.userId },
      download ? "DOWNLOAD" : "PLAYBACK",
    );
    await this.audio.sendWav(sosId, request.headers.range, response, {
      filename: download ? `sos-${id}.wav` : undefined,
    });
  }

  @Post(":id/notify-contacts")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary:
      "Send the WhatsApp alert again to emergency contacts it did not reach",
  })
  async notifyContacts(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AdminSosDetail>> {
    return ok(await this.sos.resendContactAlerts(id));
  }
}

@ApiTags("Admin · Complaints")
@ApiBearerAuth()
@Roles(UserRole.ADMIN)
@Controller({ path: "admin/complaints", version: "1" })
export class AdminComplaintsController {
  private readonly timeZone: string;

  constructor(
    private readonly complaints: ComplaintsService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  @Get()
  @ApiOperation({ summary: "Complaints (status, category, priority, search)" })
  async list(
    @Query() query: AdminListComplaintsQueryDto,
  ): Promise<ApiSuccessBody<Page<AdminComplaintView>>> {
    return ok(await this.complaints.adminList(query));
  }

  @Get("summary")
  @ApiOperation({ summary: "Open / in review / urgent counts" })
  async summary(): Promise<ApiSuccessBody<ComplaintSummary>> {
    return ok(
      await this.complaints.summary(
        startOfDayInTimeZone(new Date(), this.timeZone),
      ),
    );
  }

  @Get(":id")
  @ApiOperation({
    summary: "One complaint with user, ride, driver and history",
  })
  async detail(
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<AdminComplaintDetail>> {
    return ok(await this.complaints.adminDetail(id));
  }

  @Patch(":id")
  @ApiOperation({
    summary:
      "Change status / priority, add a resolution or internal note, assign",
  })
  async update(
    @CurrentUser() admin: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateComplaintDto,
  ): Promise<ApiSuccessBody<AdminComplaintDetail>> {
    return ok(await this.complaints.adminUpdate(admin.userId, id, dto));
  }
}

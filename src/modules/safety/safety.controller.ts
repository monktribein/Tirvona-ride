import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseIntPipe,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ApiBearerAuth, ApiOperation, ApiTags } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import type { Request, Response } from "express";
import { CurrentUser } from "../../common/decorators/current-user.decorator";
import { Public } from "../../common/decorators/public.decorator";
import { Roles } from "../../common/decorators/roles.decorator";
import { ok } from "../../common/http/api-response";
import type { ApiSuccessBody } from "../../common/http/api-response";
import { apiBadRequest } from "../../common/exceptions/api.exception";
import { ParseObjectIdPipe } from "../../common/pipes/parse-object-id.pipe";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { UserRole } from "../../common/types/user-role.enum";
import {
  CreateEmergencyContactDto,
  UpdateEmergencyContactDto,
} from "./dto/emergency-contact.dto";
import {
  AudioChunkListQueryDto,
  SosAudioStateDto,
} from "./dto/sos-audio.dto";
import { TriggerSosDto } from "./dto/sos.dto";
import { SOS_AUDIO_SCRIPT } from "./share-audio-script";
import { SosAudioService } from "./sos-audio.service";
import type { AudioChunkList, SosAudioView } from "./sos-audio.service";
import { EmergencyContactsService } from "./emergency-contacts.service";
import type { EmergencyContactView } from "./emergency-contacts.service";
import { ShareRideService } from "./share-ride.service";
import type { ShareLinkView } from "./share-ride.service";
import { renderShareErrorPage, renderSharedRidePage } from "./share-ride-page";
import type { SharedRideView } from "./share-ride-view";
import { SosService } from "./sos.service";
import type { SosTriggerResult, SosView } from "./sos.service";

@ApiTags("Safety")
@ApiBearerAuth()
@Roles(UserRole.CUSTOMER, UserRole.DRIVER)
@Controller({ path: "users/me/emergency-contacts", version: "1" })
export class EmergencyContactsController {
  constructor(private readonly contacts: EmergencyContactsService) {}

  @Get()
  @ApiOperation({ summary: "The caller's emergency contacts (primary first)" })
  async list(
    @CurrentUser() user: AuthenticatedUser,
  ): Promise<ApiSuccessBody<EmergencyContactView[]>> {
    return ok(await this.contacts.list(user.userId));
  }

  @Post()
  @ApiOperation({
    summary: "Add an emergency contact (the first one becomes primary)",
  })
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateEmergencyContactDto,
  ): Promise<ApiSuccessBody<EmergencyContactView>> {
    return ok(await this.contacts.create(user.userId, dto));
  }

  @Patch(":id")
  @ApiOperation({ summary: "Edit an emergency contact, or make it primary" })
  async update(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: UpdateEmergencyContactDto,
  ): Promise<ApiSuccessBody<EmergencyContactView>> {
    return ok(await this.contacts.update(user.userId, id, dto));
  }

  @Delete(":id")
  @ApiOperation({ summary: "Remove an emergency contact" })
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<{ deleted: true }>> {
    await this.contacts.remove(user.userId, id);
    return ok({ deleted: true });
  }
}

@ApiTags("Safety")
@ApiBearerAuth()
@Controller({ path: "rides", version: "1" })
export class RideSafetyController {
  constructor(
    private readonly sos: SosService,
    private readonly share: ShareRideService,
    private readonly audio: SosAudioService,
  ) {}

  @Put(":id/sos/:sosId/audio/:seq")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  // One chunk every ~5 s per phone; generous so retries after a bad patch of
  // network (a backlog uploaded at once) are never throttled.
  @Throttle({ default: { limit: 600, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Upload one chunk of the SOS microphone recording (raw 16-bit mono 16 kHz PCM, application/octet-stream). Repeating a chunk is safe.",
  })
  async uploadAudio(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("sosId", ParseObjectIdPipe) sosId: string,
    @Param("seq", ParseIntPipe) seq: number,
    @Req() request: Request,
  ): Promise<ApiSuccessBody<SosAudioView>> {
    if (seq < 0 || seq > 100_000)
      throw apiBadRequest("Invalid chunk number", "SOS_AUDIO_INVALID");
    // The body is a Buffer only for application/octet-stream (app.setup.ts).
    return ok(
      await this.audio.ingest(user, id, sosId, seq, request.body as unknown),
    );
  }

  @Post(":id/sos/:sosId/audio/state")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @HttpCode(HttpStatus.OK)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary:
      "Say what the microphone is doing: recording, stopped, permission denied, failed",
  })
  async audioState(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Param("sosId", ParseObjectIdPipe) sosId: string,
    @Body() dto: SosAudioStateDto,
  ): Promise<ApiSuccessBody<SosAudioView>> {
    return ok(
      await this.audio.reportState(
        user,
        id,
        sosId,
        dto.state,
        dto.consentVersion,
      ),
    );
  }

  @Post(":id/sos")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  // Generous: a person in danger may press repeatedly; repeats update one incident.
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  @ApiOperation({
    summary: "Raise an SOS on a ride you are part of (alerts the safety team)",
  })
  async triggerSos(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
    @Body() dto: TriggerSosDto,
  ): Promise<ApiSuccessBody<SosTriggerResult>> {
    return ok(await this.sos.trigger(user, id, dto));
  }

  @Get(":id/sos")
  @Roles(UserRole.CUSTOMER, UserRole.DRIVER)
  @ApiOperation({ summary: "Your SOS alerts on this ride and their status" })
  async listSos(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<SosView[]>> {
    return ok(await this.sos.listForRide(user, id));
  }

  @Post(":id/share")
  @Roles(UserRole.CUSTOMER)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @ApiOperation({
    summary: "Create a public read-only link to this ride's live status",
  })
  async createShare(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<ShareLinkView>> {
    return ok(await this.share.create(user.userId, id));
  }

  @Get(":id/share")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({ summary: "How many share links of this ride are live" })
  async shareStatus(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<{ active: number }>> {
    return ok(await this.share.activeLinkCount(user.userId, id));
  }

  @Delete(":id/share")
  @Roles(UserRole.CUSTOMER)
  @ApiOperation({
    summary: "Stop sharing: every link of this ride stops working",
  })
  async revokeShare(
    @CurrentUser() user: AuthenticatedUser,
    @Param("id", ParseObjectIdPipe) id: string,
  ): Promise<ApiSuccessBody<{ revoked: number }>> {
    return ok(await this.share.revoke(user.userId, id));
  }
}

/** Public, read-only. No login; only sanitized ride information. */
@ApiTags("Safety")
@Public()
@Throttle({ default: { limit: 60, ttl: 60_000 } })
@Controller({ path: "shared-rides", version: "1" })
export class SharedRidesController {
  private readonly timeZone: string;

  constructor(
    private readonly share: ShareRideService,
    private readonly audio: SosAudioService,
    config: ConfigService,
  ) {
    this.timeZone = config.getOrThrow<string>("appTimeZone");
  }

  /** The status view; on an SOS link it also carries the recording's state. */
  private async viewFor(
    token: string,
  ): Promise<{ view: SharedRideView; isSos: boolean }> {
    const view = await this.share.publicView(token);
    const sosId = await this.share.sosIdIfSosLink(token);
    if (!sosId) return { view, isSos: false };
    return {
      view: { ...view, audio: await this.audio.sharedView(sosId) },
      isSos: true,
    };
  }

  // ── Audio on an SOS link (declared before ":token") ──────────────────

  @Get("assets/sos-audio.js")
  @ApiOperation({ summary: "The audio player script of the SOS tracking page" })
  script(@Res({ passthrough: true }) response: Response): string {
    response.setHeader("Content-Type", "application/javascript; charset=utf-8");
    response.setHeader("Cache-Control", "public, max-age=300");
    return SOS_AUDIO_SCRIPT;
  }

  @Get(":token/audio/chunks")
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: "Chunks of the SOS recording: after=<seq>, or tail=<n> for the live edge",
  })
  async audioChunks(
    @Param("token") token: string,
    @Query() query: AudioChunkListQueryDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiSuccessBody<AudioChunkList>> {
    this.privateHeaders(response);
    const sosId = await this.share.sosIdForLink(token);
    // Starting to listen (not each poll) is what is logged.
    if (query.tail !== undefined)
      await this.audio.logAccess(sosId, { actor: "CONTACT" }, "LIVE");
    return ok(await this.audio.listChunks(sosId, query));
  }

  @Get(":token/audio/chunks/:seq")
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiOperation({ summary: "One chunk of the SOS recording as a WAV file" })
  async audioChunk(
    @Param("token") token: string,
    @Param("seq", ParseIntPipe) seq: number,
    @Res() response: Response,
  ): Promise<void> {
    this.privateHeaders(response);
    const sosId = await this.share.sosIdForLink(token);
    const wav = await this.audio.chunkWav(sosId, seq);
    response.setHeader("Content-Type", "audio/wav");
    response.setHeader("Content-Length", String(wav.length));
    response.end(wav);
  }

  @Get(":token/audio.wav")
  @Throttle({ default: { limit: 240, ttl: 60_000 } })
  @ApiOperation({
    summary: "The SOS recording so far as one WAV file (Range supported)",
  })
  async audioRecording(
    @Param("token") token: string,
    @Req() request: Request,
    @Res() response: Response,
  ): Promise<void> {
    this.privateHeaders(response);
    const sosId = await this.share.sosIdForLink(token);
    await this.audio.logAccess(sosId, { actor: "CONTACT" }, "PLAYBACK");
    await this.audio.sendWav(sosId, request.headers.range, response);
  }

  // Declared before ":token" so "view" is never read as a token.
  @Get("view/:token")
  @ApiOperation({ summary: "The share link's page (HTML)" })
  async page(
    @Param("token") token: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<string> {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    this.privateHeaders(response);
    try {
      const { view, isSos } = await this.viewFor(token);
      return renderSharedRidePage(
        view,
        this.timeZone,
        isSos ? token : undefined,
      );
    } catch (error) {
      const status = (error as { getStatus?: () => number }).getStatus?.();
      if (status !== HttpStatus.NOT_FOUND && status !== HttpStatus.GONE)
        throw error;
      response.status(status);
      return renderShareErrorPage(status === HttpStatus.GONE);
    }
  }

  @Get(":token")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Sanitized live status for a share token (JSON)" })
  async status(
    @Param("token") token: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ApiSuccessBody<SharedRideView>> {
    this.privateHeaders(response);
    return ok((await this.viewFor(token)).view);
  }

  private privateHeaders(response: Response): void {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Robots-Tag", "noindex, nofollow");
    response.setHeader("Referrer-Policy", "no-referrer");
  }
}

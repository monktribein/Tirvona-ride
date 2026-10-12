import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { InjectModel } from "@nestjs/mongoose";
import type { Model } from "mongoose";
import { Types } from "mongoose";
import type { Response } from "express";
import {
  apiBadRequest,
  apiConflict,
  apiNotFound,
} from "../../common/exceptions/api.exception";
import type { AuthenticatedUser } from "../../common/types/jwt-payload";
import { AuditLogService } from "../audit/audit-log.service";
import { SosAudioChunk } from "./schemas/sos-audio-chunk.schema";
import { SosEvent } from "./schemas/sos-event.schema";
import type { SosEventDocument } from "./schemas/sos-event.schema";
import {
  SOS_AUDIO_MAX_CHUNK_BYTES,
  SOS_AUDIO_SAMPLE_RATE,
  WAV_HEADER_BYTES,
  partsForRange,
  parseByteRange,
  pcmDurationMs,
  planWav,
  sosAudioState,
  wavHeader,
} from "./sos-audio";
import type { SosAudioDeviceState, SosAudioState, WavPlan } from "./sos-audio";
import type { SharedAudioView } from "./share-ride-view";

/** What the person who pressed SOS sees of their own recording. */
export interface SosAudioView {
  state: SosAudioState;
  /** Chunks the server has stored. */
  chunks: number;
  /** Seconds of audio the server has stored. */
  seconds: number;
  /** Where a phone that (re)starts recording continues numbering its chunks. */
  nextSeq: number;
  lastChunkAt?: Date;
}

/** What the safety team sees. */
export interface AdminSosAudio extends SosAudioView {
  enabled: boolean;
  deviceState?: SosAudioDeviceState;
  bytes: number;
  firstChunkAt?: Date;
  stoppedAt?: Date;
  consentVersion?: string;
  sampleRate: number;
  /** Chunks that never arrived (a gap in the recording). */
  missingChunks: number;
  retentionUntil?: Date;
  /** Who listened, newest last. */
  access: Array<{
    actor: "ADMIN" | "CONTACT";
    kind: "LIVE" | "PLAYBACK" | "DOWNLOAD";
    at: Date;
    admin?: string;
  }>;
}

export interface AudioChunkList {
  chunks: Array<{ seq: number; durationMs: number }>;
  latestSeq: number;
  state: SosAudioState;
  /** Seconds stored so far. */
  seconds: number;
}

type Actor =
  | { actor: "ADMIN"; adminId: string; adminName?: string }
  | { actor: "CONTACT" };

const isDuplicateKey = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  (error as { code?: number }).code === 11000;

/** How long a repeated listen by the same person counts as one entry in the access log. */
const ACCESS_DEDUPE_MS = 2 * 60_000;
const MAX_ACCESS_ENTRIES = 200;
/** Chunks read from the database at once while streaming a recording (~3 MB). */
const STREAM_BATCH = 20;

/**
 * SOS microphone recordings. The phone uploads numbered raw-PCM chunks while
 * an SOS is open; this stores them, reports honestly what has been stored,
 * and serves them back as WAV to the safety team and to the contacts' link.
 *
 * Nothing here can fail or delay the SOS itself: the incident, the admin
 * alert and the WhatsApp messages do not depend on audio.
 */
@Injectable()
export class SosAudioService {
  private readonly logger = new Logger(SosAudioService.name);
  private readonly enabled: boolean;
  private readonly retentionMs: number;
  private readonly maxMs: number;

  constructor(
    @InjectModel(SosEvent.name) private readonly sosModel: Model<SosEvent>,
    @InjectModel(SosAudioChunk.name)
    private readonly chunkModel: Model<SosAudioChunk>,
    private readonly audit: AuditLogService,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>("sosAudioEnabled") ?? true;
    this.retentionMs =
      (config.get<number>("sosAudioRetentionDays") ?? 90) * 86_400_000;
    this.maxMs = (config.get<number>("sosAudioMaxSeconds") ?? 14_400) * 1000;
  }

  // ── The phone (the person who pressed SOS) ───────────────────────────

  /**
   * Stores one chunk. Idempotent: a chunk sent again (the response was lost)
   * is reported as stored, not stored twice.
   */
  async ingest(
    user: AuthenticatedUser,
    rideId: string,
    sosId: string,
    seq: number,
    body: unknown,
  ): Promise<SosAudioView> {
    this.assertEnabled();
    const sos = await this.ownIncident(user, rideId, sosId);
    if (!sos.isOpen)
      throw apiConflict("This alert is closed", "SOS_CLOSED", {
        stop: true,
      });
    if (!Buffer.isBuffer(body) || body.length === 0)
      throw apiBadRequest(
        "Send the audio as application/octet-stream",
        "SOS_AUDIO_INVALID",
      );
    if (body.length > SOS_AUDIO_MAX_CHUNK_BYTES || body.length % 2 !== 0)
      throw apiBadRequest(
        "Audio chunks are 16-bit PCM of at most 12 seconds",
        "SOS_AUDIO_INVALID",
      );
    if (sos.audio.durationMs >= this.maxMs)
      throw apiConflict(
        "The recording reached its length limit",
        "SOS_AUDIO_LIMIT",
        { stop: true },
      );

    const now = new Date();
    const durationMs = pcmDurationMs(body.length);
    const expireAt = new Date(now.getTime() + this.retentionMs);
    try {
      await this.chunkModel.create({
        sosId: sos._id,
        seq,
        data: body,
        byteLength: body.length,
        durationMs,
        receivedAt: now,
        expireAt,
      });
    } catch (error) {
      if (isDuplicateKey(error)) return this.viewOf(sos);
      throw error;
    }

    const updated = await this.sosModel
      .findOneAndUpdate(
        { _id: sos._id },
        {
          $inc: {
            "audio.chunkCount": 1,
            "audio.bytes": body.length,
            "audio.durationMs": durationMs,
          },
          $set: {
            "audio.lastChunkAt": now,
            "audio.deviceState": "RECORDING",
            "audio.sampleRate": SOS_AUDIO_SAMPLE_RATE,
            "audio.retentionUntil": expireAt,
          },
          $min: { "audio.firstChunkAt": now },
          $max: { "audio.lastSeq": seq },
          $unset: { "audio.stoppedAt": "" },
        },
        { returnDocument: "after" },
      )
      .exec();
    return this.viewOf(updated ?? sos);
  }

  /** The phone says what its microphone is doing (including "I cannot record"). */
  async reportState(
    user: AuthenticatedUser,
    rideId: string,
    sosId: string,
    state: SosAudioDeviceState,
    consentVersion?: string,
  ): Promise<SosAudioView> {
    this.assertEnabled();
    const sos = await this.ownIncident(user, rideId, sosId);
    const now = new Date();
    const set: Record<string, unknown> = { "audio.deviceState": state };
    if (state === "STOPPED") set["audio.stoppedAt"] = now;
    if (consentVersion && state === "RECORDING") {
      set["audio.consentVersion"] = consentVersion;
    }
    const updated = await this.sosModel
      .findOneAndUpdate({ _id: sos._id }, { $set: set }, { returnDocument: "after" })
      .exec();
    if (state === "PERMISSION_DENIED" || state === "FAILED")
      this.logger.warn(
        `SOS ${sos.sosCode}: the phone cannot record audio (${state})`,
      );
    return this.viewOf(updated ?? sos);
  }

  // ── Views ────────────────────────────────────────────────────────────

  /** For the person who pressed SOS, and for the contacts' page. */
  viewOf(
    sos: Pick<SosEventDocument, "audio" | "isOpen">,
    now = new Date(),
  ): SosAudioView {
    const audio = sos.audio ?? { chunkCount: 0, durationMs: 0 };
    return {
      state: sosAudioState(
        {
          chunkCount: audio.chunkCount,
          lastChunkAt: audio.lastChunkAt,
          stoppedAt: audio.stoppedAt,
          deviceState: audio.deviceState,
          closed: !sos.isOpen,
        },
        now,
      ),
      chunks: audio.chunkCount,
      seconds: Math.round(audio.durationMs / 1000),
      nextSeq: ((audio as { lastSeq?: number }).lastSeq ?? -1) + 1,
      lastChunkAt: audio.lastChunkAt,
    };
  }

  /** The contacts' page: no counts of chunks, no device details. */
  async sharedView(sosId: Types.ObjectId): Promise<SharedAudioView> {
    const sos = await this.sosModel
      .findById(sosId)
      .select("audio isOpen")
      .exec();
    const view = sos ? this.viewOf(sos) : undefined;
    return { state: view?.state ?? "NONE", seconds: view?.seconds ?? 0 };
  }

  adminView(
    sos: SosEventDocument,
    adminNames: ReadonlyMap<string, string>,
  ): AdminSosAudio {
    const audio = sos.audio;
    return {
      ...this.viewOf(sos),
      enabled: this.enabled,
      deviceState: audio.deviceState,
      bytes: audio.bytes,
      firstChunkAt: audio.firstChunkAt,
      stoppedAt: audio.stoppedAt,
      consentVersion: audio.consentVersion,
      sampleRate: audio.sampleRate,
      missingChunks: Math.max(0, (audio.lastSeq ?? -1) + 1 - audio.chunkCount),
      retentionUntil: audio.retentionUntil,
      access: sos.audioAccess.map((entry) => ({
        actor: entry.actor,
        kind: entry.kind,
        at: entry.at,
        admin: entry.adminId
          ? adminNames.get(entry.adminId.toString())
          : undefined,
      })),
    };
  }

  // ── Listeners (safety team, contacts' link) ──────────────────────────

  async listChunks(
    sosId: Types.ObjectId,
    query: { after?: number; tail?: number },
  ): Promise<AudioChunkList> {
    const sos = await this.sosModel
      .findById(sosId)
      .select("audio isOpen")
      .exec();
    if (!sos) throw apiNotFound("SOS incident not found", "SOS_NOT_FOUND");
    let rows: Array<{ seq: number; durationMs: number }>;
    if (query.tail !== undefined) {
      rows = (
        await this.chunkModel
          .find({ sosId })
          .sort({ seq: -1 })
          .limit(query.tail)
          .select("seq durationMs")
          .lean()
          .exec()
      ).reverse();
    } else {
      rows = await this.chunkModel
        .find({ sosId, seq: { $gt: query.after ?? -1 } })
        .sort({ seq: 1 })
        .limit(20)
        .select("seq durationMs")
        .lean()
        .exec();
    }
    const view = this.viewOf(sos);
    return {
      chunks: rows.map((row) => ({ seq: row.seq, durationMs: row.durationMs })),
      latestSeq: sos.audio.lastSeq ?? -1,
      state: view.state,
      seconds: view.seconds,
    };
  }

  /** One chunk as a small WAV file (the live player decodes these one by one). */
  async chunkWav(sosId: Types.ObjectId, seq: number): Promise<Buffer> {
    const chunk = await this.chunkModel
      .findOne({ sosId, seq })
      .select("+data byteLength")
      .exec();
    if (!chunk)
      throw apiNotFound("That audio chunk does not exist", "SOS_AUDIO_NOT_FOUND");
    const sampleRate = await this.sampleRate(sosId);
    return Buffer.concat([wavHeader(chunk.byteLength, sampleRate), chunk.data]);
  }

  /**
   * The whole recording so far as one WAV, with HTTP Range support so the
   * browser's player can seek. Streamed chunk by chunk: never held in memory.
   */
  async sendWav(
    sosId: Types.ObjectId,
    rangeHeader: string | undefined,
    response: Response,
    options: { filename?: string } = {},
  ): Promise<void> {
    const plan = await this.plan(sosId);
    if (plan.parts.length === 0)
      throw apiNotFound("Nothing has been recorded yet", "SOS_AUDIO_NOT_FOUND");

    const range = parseByteRange(rangeHeader, plan.totalBytes);
    response.setHeader("Accept-Ranges", "bytes");
    response.setHeader("Cache-Control", "no-store, no-transform");
    response.setHeader("Content-Type", "audio/wav");
    if (options.filename)
      response.setHeader(
        "Content-Disposition",
        `attachment; filename="${options.filename}"`,
      );
    if (range === "unsatisfiable") {
      response.status(416);
      response.setHeader("Content-Range", `bytes */${plan.totalBytes}`);
      response.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: plan.totalBytes - 1 };
    if (range) {
      response.status(206);
      response.setHeader(
        "Content-Range",
        `bytes ${start}-${end}/${plan.totalBytes}`,
      );
    }
    response.setHeader("Content-Length", String(end - start + 1));

    if (start < WAV_HEADER_BYTES) {
      const header = wavHeader(
        plan.totalBytes - WAV_HEADER_BYTES,
        plan.sampleRate,
      );
      await write(response, header.subarray(start, end + 1));
    }
    const needed = partsForRange(plan, start, end);
    for (let at = 0; at < needed.length; at += STREAM_BATCH) {
      if (response.destroyed) return;
      const batch = needed.slice(at, at + STREAM_BATCH);
      const chunks = await this.chunkModel
        .find({ sosId, seq: { $in: batch.map((part) => part.seq) } })
        .select("seq +data")
        .exec();
      const bySeq = new Map(chunks.map((chunk) => [chunk.seq, chunk.data]));
      for (const part of batch) {
        const data = bySeq.get(part.seq);
        if (!data || data.length !== part.byteLength) {
          // Deleted while streaming: the promised length cannot be met.
          response.destroy();
          return;
        }
        const from = Math.max(start, part.offset) - part.offset;
        const to = Math.min(end, part.offset + part.byteLength - 1) - part.offset;
        await write(response, data.subarray(from, to + 1));
      }
    }
    response.end();
  }

  /** Logs that someone listened (one entry per person and kind per two minutes). */
  async logAccess(
    sosId: Types.ObjectId,
    who: Actor,
    kind: "LIVE" | "PLAYBACK" | "DOWNLOAD",
  ): Promise<void> {
    const now = new Date();
    const adminId =
      who.actor === "ADMIN" ? new Types.ObjectId(who.adminId) : undefined;
    try {
      const logged = await this.sosModel
        .findOneAndUpdate(
          {
            _id: sosId,
            audioAccess: {
              $not: {
                $elemMatch: {
                  actor: who.actor,
                  kind,
                  ...(adminId ? { adminId } : {}),
                  at: { $gt: new Date(now.getTime() - ACCESS_DEDUPE_MS) },
                },
              },
            },
          },
          {
            $push: {
              audioAccess: {
                $each: [{ actor: who.actor, kind, adminId, at: now }],
                $slice: -MAX_ACCESS_ENTRIES,
              },
            },
          },
          { projection: { sosCode: 1 } },
        )
        .exec();
      // A repeat within the dedupe window matched nothing: not logged again.
      if (logged && who.actor === "ADMIN")
        await this.audit.record({
          adminId: who.adminId,
          action: `SOS_AUDIO_${kind}`,
          targetType: "SOS",
          targetId: sosId.toString(),
          targetLabel: logged.sosCode,
        });
    } catch (error) {
      // Logging must never stop someone from hearing an emergency.
      this.logger.error(`SOS audio access log failed: ${String(error)}`);
    }
  }

  // ── Internals ────────────────────────────────────────────────────────

  private assertEnabled(): void {
    if (!this.enabled)
      throw apiConflict(
        "Audio recording is switched off",
        "SOS_AUDIO_DISABLED",
        { stop: true },
      );
  }

  /** The incident, if the caller raised it on this ride; else 404. */
  private async ownIncident(
    user: AuthenticatedUser,
    rideId: string,
    sosId: string,
  ): Promise<SosEventDocument> {
    const sos = await this.sosModel
      .findOne({
        _id: new Types.ObjectId(sosId),
        rideId: new Types.ObjectId(rideId),
        userId: new Types.ObjectId(user.userId),
      })
      .exec();
    if (!sos) throw apiNotFound("SOS incident not found", "SOS_NOT_FOUND");
    return sos;
  }

  private async sampleRate(sosId: Types.ObjectId): Promise<number> {
    const sos = await this.sosModel
      .findById(sosId)
      .select("audio.sampleRate")
      .lean()
      .exec();
    return sos?.audio?.sampleRate ?? SOS_AUDIO_SAMPLE_RATE;
  }

  private async plan(sosId: Types.ObjectId): Promise<WavPlan> {
    const [parts, sampleRate] = await Promise.all([
      this.chunkModel
        .find({ sosId })
        .sort({ seq: 1 })
        .select("seq byteLength")
        .lean()
        .exec(),
      this.sampleRate(sosId),
    ]);
    return planWav(
      parts.map((part) => ({ seq: part.seq, byteLength: part.byteLength })),
      sampleRate,
    );
  }
}

/** Writes with back-pressure, so a slow listener cannot pile up memory. */
function write(response: Response, data: Uint8Array): Promise<void> {
  return new Promise((resolve) => {
    if (response.destroyed) return resolve();
    if (response.write(data)) resolve();
    else {
      response.once("drain", () => resolve());
      // The listener went away: nothing will ever drain.
      response.once("close", () => resolve());
    }
  });
}

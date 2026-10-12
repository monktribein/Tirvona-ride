import { Prop, Schema, SchemaFactory } from "@nestjs/mongoose";
import { SchemaTypes, Types } from "mongoose";
import type { HydratedDocument } from "mongoose";

/**
 * One numbered slice of an SOS recording: raw 16-bit mono PCM (see
 * sos-audio.ts). Chunks are write-once and never edited; a TTL index on
 * `expireAt` deletes them when the retention period ends.
 */
@Schema({ timestamps: true, collection: "sos_audio_chunks" })
export class SosAudioChunk {
  @Prop({ required: true, type: SchemaTypes.ObjectId, ref: "SosEvent" })
  sosId!: Types.ObjectId;

  /** Position in the recording, starting at 0. The phone numbers them. */
  @Prop({ required: true, min: 0 })
  seq!: number;

  @Prop({ required: true, type: Buffer, select: false })
  data!: Buffer;

  @Prop({ required: true, min: 1 })
  byteLength!: number;

  @Prop({ required: true, min: 0 })
  durationMs!: number;

  /** When the server stored it. */
  @Prop({ required: true })
  receivedAt!: Date;

  @Prop({ required: true })
  expireAt!: Date;

  createdAt!: Date;
}

export type SosAudioChunkDocument = HydratedDocument<SosAudioChunk>;
export const SosAudioChunkSchema = SchemaFactory.createForClass(SosAudioChunk);

// A chunk sent twice (a retry after a lost response) is stored once.
SosAudioChunkSchema.index({ sosId: 1, seq: 1 }, { unique: true });
SosAudioChunkSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });

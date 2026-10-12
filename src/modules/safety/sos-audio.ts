/**
 * Pure helpers for SOS audio (unit-tested in sos-audio.spec.ts).
 *
 * The phone sends raw PCM: 16-bit little-endian, mono, 16 kHz, in numbered
 * chunks of a few seconds. Raw PCM is what lets chunks be joined byte for
 * byte into one gapless recording, and wrapping it in a 44-byte WAV header is
 * all a browser needs to play it.
 */

export const SOS_AUDIO_SAMPLE_RATE = 16_000;
const BYTES_PER_SAMPLE = 2;
export const SOS_AUDIO_BYTES_PER_SECOND =
  SOS_AUDIO_SAMPLE_RATE * BYTES_PER_SAMPLE;
/** Largest chunk the API accepts (12.5 s); the app sends about 5 s. */
export const SOS_AUDIO_MAX_CHUNK_BYTES = 400_000;
export const WAV_HEADER_BYTES = 44;
/** A recording is "live" while its newest chunk is younger than this. */
export const SOS_AUDIO_LIVE_WINDOW_MS = 30_000;

export const pcmDurationMs = (byteLength: number): number =>
  Math.round((byteLength / SOS_AUDIO_BYTES_PER_SECOND) * 1000);

/** The RIFF/WAVE header for `dataBytes` of 16-bit mono PCM. */
export function wavHeader(
  dataBytes: number,
  sampleRate: number = SOS_AUDIO_SAMPLE_RATE,
): Buffer {
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16); // fmt chunk size
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * BYTES_PER_SAMPLE, 28); // byte rate
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export interface AudioPart {
  seq: number;
  byteLength: number;
}

export interface WavPlan {
  sampleRate: number;
  /** Total size of the WAV file: header + every chunk. */
  totalBytes: number;
  /** Each chunk with the file offset where its audio starts. */
  parts: Array<AudioPart & { offset: number }>;
}

/** Lays the chunks out end to end behind one WAV header. */
export function planWav(
  parts: readonly AudioPart[],
  sampleRate: number = SOS_AUDIO_SAMPLE_RATE,
): WavPlan {
  const ordered = [...parts].sort((a, b) => a.seq - b.seq);
  let offset = WAV_HEADER_BYTES;
  const placed = ordered.map((part) => {
    const row = { ...part, offset };
    offset += part.byteLength;
    return row;
  });
  return { sampleRate, totalBytes: offset, parts: placed };
}

/** The chunks that overlap the byte range [start, end] of the WAV file. */
export function partsForRange(
  plan: WavPlan,
  start: number,
  end: number,
): WavPlan["parts"] {
  return plan.parts.filter(
    (part) => part.offset + part.byteLength - 1 >= start && part.offset <= end,
  );
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a single `Range: bytes=a-b` header against a file of `total` bytes.
 * `null`: no usable range, send the whole file. `"unsatisfiable"`: 416.
 */
export function parseByteRange(
  header: string | undefined,
  total: number,
): ByteRange | "unsatisfiable" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, from, to] = match;
  if (from === "" && to === "") return null;
  let start: number;
  let end: number;
  if (from === "") {
    // "-N": the last N bytes.
    const suffix = Number(to);
    if (suffix === 0) return "unsatisfiable";
    start = Math.max(0, total - suffix);
    end = total - 1;
  } else {
    start = Number(from);
    end = to === "" ? total - 1 : Math.min(Number(to), total - 1);
  }
  if (start >= total || start > end) return "unsatisfiable";
  return { start, end };
}

/** What the person who pressed SOS, the safety team and the contacts see. */
export type SosAudioState =
  /** Nothing has been uploaded (yet). */
  | "NONE"
  /** Chunks are arriving. */
  | "RECORDING"
  /** The phone ended the recording itself: what was sent is saved. */
  | "STOPPED"
  /** Chunks stopped arriving without the phone saying so (offline, killed, battery). */
  | "INTERRUPTED"
  /** The phone said it cannot record (permission, no microphone, error). */
  | "UNAVAILABLE";

export type SosAudioDeviceState =
  | "RECORDING"
  | "STOPPED"
  | "PERMISSION_DENIED"
  | "FAILED";

export interface AudioFacts {
  chunkCount: number;
  lastChunkAt?: Date;
  stoppedAt?: Date;
  deviceState?: SosAudioDeviceState;
  /** The incident is closed: nothing records after that. */
  closed?: boolean;
}

/**
 * The honest state of the recording, from what the server actually stored.
 * `RECORDING` needs a chunk in the last 30 s: a phone that went quiet shows
 * as INTERRUPTED rather than pretending to record.
 */
export function sosAudioState(
  facts: AudioFacts,
  now: Date = new Date(),
): SosAudioState {
  const recent =
    facts.lastChunkAt !== undefined &&
    now.getTime() - facts.lastChunkAt.getTime() <= SOS_AUDIO_LIVE_WINDOW_MS;
  if (facts.chunkCount > 0) {
    if (facts.stoppedAt || facts.closed) return "STOPPED";
    return recent ? "RECORDING" : "INTERRUPTED";
  }
  if (
    facts.deviceState === "PERMISSION_DENIED" ||
    facts.deviceState === "FAILED"
  )
    return "UNAVAILABLE";
  return "NONE";
}

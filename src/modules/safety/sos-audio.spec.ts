import {
  SOS_AUDIO_BYTES_PER_SECOND,
  WAV_HEADER_BYTES,
  parseByteRange,
  partsForRange,
  pcmDurationMs,
  planWav,
  sosAudioState,
  wavHeader,
} from "./sos-audio";

describe("sos-audio", () => {
  describe("wavHeader", () => {
    it("describes 16-bit mono PCM at the given rate", () => {
      const header = wavHeader(32_000, 16_000);
      expect(header).toHaveLength(WAV_HEADER_BYTES);
      expect(header.toString("ascii", 0, 4)).toBe("RIFF");
      expect(header.readUInt32LE(4)).toBe(36 + 32_000);
      expect(header.toString("ascii", 8, 16)).toBe("WAVEfmt ");
      expect(header.readUInt16LE(20)).toBe(1); // PCM
      expect(header.readUInt16LE(22)).toBe(1); // mono
      expect(header.readUInt32LE(24)).toBe(16_000);
      expect(header.readUInt32LE(28)).toBe(32_000); // byte rate
      expect(header.readUInt16LE(34)).toBe(16);
      expect(header.toString("ascii", 36, 40)).toBe("data");
      expect(header.readUInt32LE(40)).toBe(32_000);
    });
  });

  it("measures PCM duration", () => {
    expect(pcmDurationMs(SOS_AUDIO_BYTES_PER_SECOND * 5)).toBe(5000);
    expect(pcmDurationMs(0)).toBe(0);
  });

  describe("planWav", () => {
    const plan = planWav([
      { seq: 2, byteLength: 100 },
      { seq: 0, byteLength: 300 },
      { seq: 1, byteLength: 200 },
    ]);

    it("lays chunks end to end in sequence order behind the header", () => {
      expect(plan.totalBytes).toBe(WAV_HEADER_BYTES + 600);
      expect(plan.parts.map((p) => [p.seq, p.offset])).toEqual([
        [0, 44],
        [1, 344],
        [2, 544],
      ]);
    });

    it("finds the chunks a byte range touches", () => {
      expect(partsForRange(plan, 0, 43)).toEqual([]);
      expect(partsForRange(plan, 0, 44).map((p) => p.seq)).toEqual([0]);
      expect(partsForRange(plan, 343, 344).map((p) => p.seq)).toEqual([0, 1]);
      expect(partsForRange(plan, 600, 643).map((p) => p.seq)).toEqual([2]);
    });
  });

  describe("parseByteRange", () => {
    it("ignores a missing or unusable header", () => {
      expect(parseByteRange(undefined, 1000)).toBeNull();
      expect(parseByteRange("items=0-1", 1000)).toBeNull();
      expect(parseByteRange("bytes=-", 1000)).toBeNull();
    });

    it("parses open, closed and suffix ranges", () => {
      expect(parseByteRange("bytes=0-", 1000)).toEqual({ start: 0, end: 999 });
      expect(parseByteRange("bytes=10-19", 1000)).toEqual({
        start: 10,
        end: 19,
      });
      expect(parseByteRange("bytes=-100", 1000)).toEqual({
        start: 900,
        end: 999,
      });
    });

    it("clamps the end to the file and rejects ranges past it", () => {
      expect(parseByteRange("bytes=990-5000", 1000)).toEqual({
        start: 990,
        end: 999,
      });
      expect(parseByteRange("bytes=1000-", 1000)).toBe("unsatisfiable");
      expect(parseByteRange("bytes=20-10", 1000)).toBe("unsatisfiable");
      expect(parseByteRange("bytes=-0", 1000)).toBe("unsatisfiable");
    });
  });

  describe("sosAudioState", () => {
    const now = new Date("2026-10-12T10:00:00Z");
    const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

    it("is NONE before any audio and no failure was reported", () => {
      expect(sosAudioState({ chunkCount: 0 }, now)).toBe("NONE");
      expect(
        sosAudioState({ chunkCount: 0, deviceState: "RECORDING" }, now),
      ).toBe("NONE");
    });

    it("is UNAVAILABLE when the phone says it cannot record", () => {
      expect(
        sosAudioState({ chunkCount: 0, deviceState: "PERMISSION_DENIED" }, now),
      ).toBe("UNAVAILABLE");
      expect(sosAudioState({ chunkCount: 0, deviceState: "FAILED" }, now)).toBe(
        "UNAVAILABLE",
      );
    });

    it("is RECORDING only while chunks keep arriving", () => {
      expect(
        sosAudioState({ chunkCount: 3, lastChunkAt: ago(10) }, now),
      ).toBe("RECORDING");
      expect(
        sosAudioState({ chunkCount: 3, lastChunkAt: ago(90) }, now),
      ).toBe("INTERRUPTED");
    });

    it("is STOPPED when the phone ended it, and keeps what was saved", () => {
      expect(
        sosAudioState(
          { chunkCount: 3, lastChunkAt: ago(5), stoppedAt: ago(4) },
          now,
        ),
      ).toBe("STOPPED");
    });

    it("is STOPPED once the incident is closed, even if a chunk just arrived", () => {
      expect(
        sosAudioState(
          { chunkCount: 3, lastChunkAt: ago(2), closed: true },
          now,
        ),
      ).toBe("STOPPED");
    });

    it("never reports UNAVAILABLE once audio has been saved", () => {
      expect(
        sosAudioState(
          { chunkCount: 2, lastChunkAt: ago(100), deviceState: "FAILED" },
          now,
        ),
      ).toBe("INTERRUPTED");
    });
  });
});

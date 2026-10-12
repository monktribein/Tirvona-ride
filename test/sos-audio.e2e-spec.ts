import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getConnectionToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Connection } from "mongoose";
import { Types } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";
import { WhatsAppGateway } from "../src/modules/whatsapp/whatsapp.gateway";
import type {
  AuthenticationCodeMessage,
  SosAlertMessage,
  WhatsAppSendResult,
} from "../src/modules/whatsapp/whatsapp.gateway";

/**
 * SOS microphone recording (docs/safety/sos-audio.md): the phone uploads PCM
 * chunks, the server reports honestly what it stored, the safety team and the
 * contacts' tracking link can play it, access is logged, and it stops with the
 * incident.
 */

class FakeWhatsApp extends WhatsAppGateway {
  readonly provider = "fake";
  readonly sos: SosAlertMessage[] = [];

  async sendAuthenticationCode(
    _message: AuthenticationCodeMessage,
  ): Promise<WhatsAppSendResult> {
    return { messageId: "wamid.otp" };
  }

  async sendSosAlert(message: SosAlertMessage): Promise<WhatsAppSendResult> {
    this.sos.push(message);
    return { messageId: `wamid.sos.${this.sos.length}` };
  }
}

const PASSWORD = "Password@123";
const PHONES = {
  admin: "+919870000011",
  customer: "+919870000012",
  driver: "+919870000013",
  stranger: "+919870000014",
} as const;
type Who = keyof typeof PHONES;
const CONTACT = "+919005011099";
/** One second of 16 kHz 16-bit mono PCM, every byte set to `fill`. */
const SECOND = 32_000;
const pcm = (fill: number, seconds = 1): Buffer =>
  Buffer.alloc(SECOND * seconds, fill);

/** supertest only buffers known text types: collect the bytes ourselves. */
const bytes = (test: request.Test): request.Test =>
  test.buffer(true).parse((res, done) => {
    const parts: Buffer[] = [];
    res.on("data", (part: Buffer) => parts.push(part));
    res.on("end", () => done(null, Buffer.concat(parts)));
  });

describe("SOS microphone recording (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  let db: Connection;
  let whatsapp: FakeWhatsApp;
  let drain: () => Promise<void>;
  const tokens = {} as Record<Who, string>;
  const userIds = {} as Record<Who, string>;
  let rideId: string;
  let sosId: string;
  let trackingToken: string;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const chunkUrl = (seq: number, id = sosId) =>
    `/api/v1/rides/${rideId}/sos/${id}/audio/${seq}`;
  const upload = (seq: number, body: Buffer, who: Who = "customer") =>
    api()
      .put(chunkUrl(seq))
      .set(as(who))
      .set("Content-Type", "application/octet-stream")
      .send(body);
  const sosDoc = (id: string) =>
    db.collection("sos_events").findOne({ _id: new Types.ObjectId(id) });
  const adminDetail = async () =>
    (
      await api()
        .get(`/api/v1/admin/sos/${sosId}`)
        .set(as("admin"))
        .expect(200)
    ).body.data;
  const press = () =>
    api()
      .post(`/api/v1/rides/${rideId}/sos`)
      .set(as("customer"))
      .send({ latitude: 28.62, longitude: 77.365 })
      .expect(201);
  const close = (id: string) =>
    api()
      .patch(`/api/v1/admin/sos/${id}`)
      .set(as("admin"))
      .send({ status: "RESOLVED", note: "test" })
      .expect(200);

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-sos-audio-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_sos_audio",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      MATCHING_SWEEP_INTERVAL_MS: "0",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      WHATSAPP_PROVIDER: "log",
      SOS_CONTACT_RETRY_DELAY_MS: "5",
      SOS_AUDIO_MAX_SECONDS: "10",
      SHARE_RIDE_LINK_BASE_URL: "https://track.tirvona.test/s",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    whatsapp = new FakeWhatsApp();
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(WhatsAppGateway)
      .useValue(whatsapp)
      .compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.init();
    db = app.get<Connection>(getConnectionToken());

    const { UsersService } = await import("../src/modules/users/users.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { SosContactAlertService } =
      await import("../src/modules/safety/sos-contact-alert.service");
    const users = app.get(UsersService, { strict: false });
    drain = () => app.get(SosContactAlertService, { strict: false }).drain();

    const roles = {
      admin: UserRole.ADMIN,
      customer: UserRole.CUSTOMER,
      driver: UserRole.DRIVER,
      stranger: UserRole.CUSTOMER,
    };
    for (const who of Object.keys(PHONES) as Who[]) {
      const user = await users.create({
        phone: PHONES[who],
        password: PASSWORD,
        role: roles[who],
        firstName: who,
      });
      userIds[who] = user._id.toString();
    }
    for (const who of Object.keys(PHONES) as Who[]) {
      const response = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES[who], password: PASSWORD })
        .expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }

    const profile = await db.collection("driver_profiles").insertOne({
      userId: new Types.ObjectId(userIds.driver),
      driverCode: "DR-AUD-1",
      driverStatus: "APPROVED",
      isOnline: true,
      isAvailable: false,
      ratingAverage: 0,
      ratingCount: 0,
      totalRides: 0,
    });
    const ride = await db.collection("rides").insertOne({
      rideCode: "TRSOSAU001",
      customerId: new Types.ObjectId(userIds.customer),
      driverId: profile.insertedId,
      driverUserId: new Types.ObjectId(userIds.driver),
      rideType: "CAB",
      status: "RIDE_STARTED",
      isActive: true,
      pickup: { address: "Sector 62, Noida", latitude: 28.6208, longitude: 77.3639 },
      destination: { address: "Noida City Centre", latitude: 28.5745, longitude: 77.356 },
      vehicle: { vehicleType: "CAB", registrationNumber: "UP16AB9999" },
      requestedAt: new Date(),
      startedAt: new Date(),
    });
    rideId = ride.insertedId.toHexString();

    await api()
      .post("/api/v1/users/me/emergency-contacts")
      .set(as("customer"))
      .send({ name: "Kushal", phone: CONTACT, isPrimary: true })
      .expect(201);
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  describe("uploading chunks", () => {
    it("starts with no audio on a new alert", async () => {
      const result = (await press()).body.data;
      sosId = result.sos.id;
      expect(result.sos.audio).toMatchObject({ state: "NONE", chunks: 0, seconds: 0 });
      await drain();
      trackingToken = (await sosDoc(sosId))?.trackingToken as string;
      expect(trackingToken).toBeTruthy();
    });

    it("stores a chunk and reports only what was stored", async () => {
      await api()
        .post(`/api/v1/rides/${rideId}/sos/${sosId}/audio/state`)
        .set(as("customer"))
        .send({ state: "RECORDING", consentVersion: "sos-audio-v1" })
        .expect(200);
      const first = (await upload(0, pcm(1)).expect(200)).body.data;
      expect(first).toMatchObject({ state: "RECORDING", chunks: 1, seconds: 1 });
      const second = (await upload(1, pcm(2)).expect(200)).body.data;
      expect(second).toMatchObject({ chunks: 2, seconds: 2 });
    });

    it("stores a repeated chunk once", async () => {
      const again = (await upload(1, pcm(2)).expect(200)).body.data;
      expect(again.chunks).toBe(2);
      expect(
        await db
          .collection("sos_audio_chunks")
          .countDocuments({ sosId: new Types.ObjectId(sosId) }),
      ).toBe(2);
    });

    it("shows the person their own recording in the SOS list", async () => {
      const mine = (
        await api()
          .get(`/api/v1/rides/${rideId}/sos`)
          .set(as("customer"))
          .expect(200)
      ).body.data;
      expect(mine[0].audio).toMatchObject({ state: "RECORDING", chunks: 2 });
    });

    it("rejects bytes that are not whole 16-bit samples, empty or oversized bodies, and other content types", async () => {
      const code = (res: request.Response) => res.body.code;
      // Half a sample, nothing, and just over the 400 kB chunk limit.
      expect(code(await upload(2, Buffer.alloc(3, 1)).expect(400))).toBe(
        "SOS_AUDIO_INVALID",
      );
      expect(code(await upload(2, Buffer.alloc(0)).expect(400))).toBe(
        "SOS_AUDIO_INVALID",
      );
      expect(code(await upload(2, Buffer.alloc(450_000, 1)).expect(400))).toBe(
        "SOS_AUDIO_INVALID",
      );
      // JSON is not audio.
      const json = await api()
        .put(chunkUrl(2))
        .set(as("customer"))
        .send({ audio: "AAAA" })
        .expect(400);
      expect(code(json)).toBe("SOS_AUDIO_INVALID");
      await upload(-1, pcm(1)).expect(400);
    });

    it("only the person who raised the alert can add audio", async () => {
      await upload(2, pcm(3), "driver").expect(404);
      await upload(2, pcm(3), "stranger").expect(404);
      await api()
        .put(chunkUrl(2))
        .set("Content-Type", "application/octet-stream")
        .send(pcm(3))
        .expect(401);
    });

    it("stops accepting audio at the length limit", async () => {
      // SOS_AUDIO_MAX_SECONDS=10: seconds 3..10 fit, then the cap is reached.
      for (let seq = 2; seq < 10; seq += 1) await upload(seq, pcm(seq + 1)).expect(200);
      const refused = await upload(10, pcm(11)).expect(409);
      expect(refused.body.code).toBe("SOS_AUDIO_LIMIT");
      expect(refused.body.data).toEqual({ stop: true });
    });
  });

  describe("the safety team", () => {
    it("sees the recording on the incident", async () => {
      const detail = await adminDetail();
      expect(detail.audio).toMatchObject({
        enabled: true,
        state: "RECORDING",
        chunks: 10,
        seconds: 10,
        bytes: 10 * SECOND,
        sampleRate: 16_000,
        consentVersion: "sos-audio-v1",
        missingChunks: 0,
      });
      expect(detail.audio.retentionUntil).toBeTruthy();
    });

    it("lists chunks from the live edge and after a position", async () => {
      const tail = (
        await api()
          .get(`/api/v1/admin/sos/${sosId}/audio/chunks?tail=3`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(tail.chunks.map((c: { seq: number }) => c.seq)).toEqual([7, 8, 9]);
      expect(tail.latestSeq).toBe(9);
      const next = (
        await api()
          .get(`/api/v1/admin/sos/${sosId}/audio/chunks?after=7`)
          .set(as("admin"))
          .expect(200)
      ).body.data;
      expect(next.chunks.map((c: { seq: number }) => c.seq)).toEqual([8, 9]);
    });

    it("plays one chunk as a WAV file", async () => {
      const response = await bytes(
        api().get(`/api/v1/admin/sos/${sosId}/audio/chunks/3`).set(as("admin")),
      ).expect(200);
      const wav = response.body as Buffer;
      expect(response.headers["content-type"]).toContain("audio/wav");
      expect(wav).toHaveLength(44 + SECOND);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(40)).toBe(SECOND);
      expect(wav[44]).toBe(4); // chunk 3 was filled with 4
    });

    it("plays the whole recording as one WAV, with Range support", async () => {
      const full = await bytes(
        api().get(`/api/v1/admin/sos/${sosId}/audio/recording`).set(as("admin")),
      ).expect(200);
      const wav = full.body as Buffer;
      expect(wav).toHaveLength(44 + 10 * SECOND);
      expect(wav.readUInt32LE(40)).toBe(10 * SECOND);
      expect(full.headers["accept-ranges"]).toBe("bytes");
      // Second 0 holds 1s, second 1 holds 2s, and so on.
      expect(wav[44]).toBe(1);
      expect(wav[44 + SECOND]).toBe(2);
      expect(wav[44 + 9 * SECOND]).toBe(10);

      // A range that straddles chunks 1 and 2.
      const start = 44 + 2 * SECOND - 2;
      const part = await bytes(
        api()
          .get(`/api/v1/admin/sos/${sosId}/audio/recording`)
          .set(as("admin"))
          .set("Range", `bytes=${start}-${start + 3}`),
      ).expect(206);
      expect(part.headers["content-range"]).toBe(
        `bytes ${start}-${start + 3}/${44 + 10 * SECOND}`,
      );
      expect([...(part.body as Buffer)]).toEqual([2, 2, 3, 3]);

      await api()
        .get(`/api/v1/admin/sos/${sosId}/audio/recording`)
        .set(as("admin"))
        .set("Range", "bytes=99999999-")
        .expect(416);
    });

    it("saves it as a file when asked", async () => {
      const response = await bytes(
        api()
          .get(`/api/v1/admin/sos/${sosId}/audio/recording?download=1`)
          .set(as("admin")),
      ).expect(200);
      expect(response.headers["content-disposition"]).toContain("attachment");
    });

    it("logs who listened (once per two minutes) and audits it", async () => {
      const detail = await adminDetail();
      const mine = detail.audio.access.filter(
        (entry: { actor: string }) => entry.actor === "ADMIN",
      );
      expect(mine.map((entry: { kind: string }) => entry.kind).sort()).toEqual([
        "DOWNLOAD",
        "LIVE",
        "PLAYBACK",
      ]);
      expect(mine[0].admin).toBe("admin");
      expect(
        await db
          .collection("admin_audit_logs")
          .countDocuments({ targetType: "SOS", action: /^SOS_AUDIO_/ }),
      ).toBe(3);
    });

    it("is for admins only", async () => {
      for (const who of ["customer", "driver", "stranger"] as Who[]) {
        await api()
          .get(`/api/v1/admin/sos/${sosId}/audio/recording`)
          .set(as(who))
          .expect(403);
      }
    });
  });

  describe("the emergency contacts' link", () => {
    const base = () => `/api/v1/shared-rides/${trackingToken}`;

    it("shows the audio card and the player script on the page", async () => {
      const page = await api()
        .get(`/api/v1/shared-rides/view/${trackingToken}`)
        .expect(200);
      expect(page.text).toContain('id="sos-audio"');
      expect(page.text).toContain("Listen live");
      expect(page.text).toContain("/api/v1/shared-rides/assets/sos-audio.js");
      expect(page.text).toContain(`${trackingToken}/audio.wav`);
      // The page's own script refreshes it, so no plain meta refresh cuts off a listener.
      expect(page.text.replace(/<noscript>[\s\S]*?<\/noscript>/g, "")).not.toContain(
        'http-equiv="refresh"',
      );

      const script = await api()
        .get("/api/v1/shared-rides/assets/sos-audio.js")
        .expect(200);
      expect(script.headers["content-type"]).toContain("javascript");
      expect(script.text).toContain("decodeAudioData");
    });

    it("reports the recording on the JSON status without chunk details", async () => {
      const view = (await api().get(base()).expect(200)).body.data;
      expect(view.audio).toEqual({ state: "RECORDING", seconds: 10 });
    });

    it("plays live chunks and the recording so far", async () => {
      const tail = (
        await api().get(`${base()}/audio/chunks?tail=2`).expect(200)
      ).body.data;
      expect(tail.chunks.map((c: { seq: number }) => c.seq)).toEqual([8, 9]);
      const chunk = await bytes(api().get(`${base()}/audio/chunks/9`)).expect(200);
      expect((chunk.body as Buffer)[44]).toBe(10);
      const full = await bytes(api().get(`${base()}/audio.wav`)).expect(200);
      expect((full.body as Buffer).length).toBe(44 + 10 * SECOND);
      expect(full.headers["cache-control"]).toBe("no-store, no-transform");
    });

    it("logs the contact's listening on the incident", async () => {
      const detail = await adminDetail();
      const kinds = detail.audio.access
        .filter((entry: { actor: string }) => entry.actor === "CONTACT")
        .map((entry: { kind: string }) => entry.kind)
        .sort();
      expect(kinds).toEqual(["LIVE", "PLAYBACK"]);
    });

    it("never gives audio to an ordinary ride-share link or a made-up token", async () => {
      const share = (
        await api()
          .post(`/api/v1/rides/${rideId}/share`)
          .set(as("customer"))
          .expect(201)
      ).body.data;
      const plain = `/api/v1/shared-rides/${share.token}`;
      await api().get(`${plain}/audio.wav`).expect(404);
      await api().get(`${plain}/audio/chunks?tail=1`).expect(404);
      const view = (await api().get(plain).expect(200)).body.data;
      expect(view.audio).toBeUndefined();
      const page = await api().get(`/api/v1/shared-rides/view/${share.token}`).expect(200);
      expect(page.text).not.toContain("sos-audio");
      await api()
        .get(`/api/v1/shared-rides/${"a".repeat(32)}/audio.wav`)
        .expect(404);
    });
  });

  describe("when the incident closes", () => {
    it("stops accepting audio and ends the contacts' link, but keeps the recording for the safety team", async () => {
      await close(sosId);
      const refused = await upload(10, pcm(1)).expect(409);
      expect(refused.body.code).toBe("SOS_CLOSED");
      expect(refused.body.data).toEqual({ stop: true });
      await api().get(`/api/v1/shared-rides/${trackingToken}/audio.wav`).expect(404);

      const detail = await adminDetail();
      expect(detail.audio).toMatchObject({ chunks: 10, state: "STOPPED" });
      const full = await bytes(
        api().get(`/api/v1/admin/sos/${sosId}/audio/recording`).set(as("admin")),
      ).expect(200);
      expect((full.body as Buffer).length).toBe(44 + 10 * SECOND);
    });
  });

  describe("when the phone cannot record", () => {
    it("still raises the alert and says so honestly", async () => {
      const result = (await press()).body.data;
      const id = result.sos.id as string;
      const reported = (
        await api()
          .post(`/api/v1/rides/${rideId}/sos/${id}/audio/state`)
          .set(as("customer"))
          .send({ state: "PERMISSION_DENIED" })
          .expect(200)
      ).body.data;
      expect(reported).toMatchObject({ state: "UNAVAILABLE", chunks: 0 });
      const detail = (
        await api().get(`/api/v1/admin/sos/${id}`).set(as("admin")).expect(200)
      ).body.data;
      expect(detail.audio).toMatchObject({
        state: "UNAVAILABLE",
        deviceState: "PERMISSION_DENIED",
        chunks: 0,
      });
      await api()
        .get(`/api/v1/admin/sos/${id}/audio/recording`)
        .set(as("admin"))
        .expect(404);
      await close(id);
    });

    it("ends a recording the phone stops itself", async () => {
      const result = (await press()).body.data;
      const id = result.sos.id as string;
      await api().put(chunkUrl(0, id)).set(as("customer")).set("Content-Type", "application/octet-stream").send(pcm(1)).expect(200);
      const stopped = (
        await api()
          .post(`/api/v1/rides/${rideId}/sos/${id}/audio/state`)
          .set(as("customer"))
          .send({ state: "STOPPED" })
          .expect(200)
      ).body.data;
      expect(stopped).toMatchObject({ state: "STOPPED", chunks: 1 });
      await close(id);
    });
  });
});

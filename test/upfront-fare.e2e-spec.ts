import { randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { INestApplication } from "@nestjs/common";
import { getModelToken } from "@nestjs/mongoose";
import { Test } from "@nestjs/testing";
import { MongoMemoryServer } from "mongodb-memory-server";
import type { Model } from "mongoose";
import request from "supertest";
import type { App } from "supertest/types";

/**
 * Upfront fares: the quote is the fare. Covers the ride-type and platform
 * settings, the locked quote on both estimate screens, the PRICE_CHANGED
 * refusal (and old apps that send no expected fare), completion at the quote
 * however long the trip runs, the waiting charge and its cap, the promo on
 * the base fare only, the early drop (and the GPS-glitch safety), admin fare
 * adjustments before and after payment starts, the quote-versus-actual
 * report, and that metered ride types behave exactly as before. Hermetic:
 * in-memory MongoDB, no Redis.
 */

const PASSWORD = "Password@123";
const PREM_MANDIR = {
  address: "Prem Mandir, Vrindavan",
  latitude: 27.5714,
  longitude: 77.6716,
};
const BANKE_BIHARI = {
  address: "Banke Bihari Temple, Vrindavan",
  latitude: 27.5806,
  longitude: 77.7006,
};
const NEAR_PICKUP = { latitude: 27.5725, longitude: 77.677 };
const PHONES = {
  admin: "+919840000000",
  customer: "+919840000001",
  driver: "+919840000011",
};
type Who = keyof typeof PHONES;

type Anything = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

describe("Upfront fares (e2e)", () => {
  const originalCwd = process.cwd();
  let workDir: string;
  let mongo: MongoMemoryServer;
  let app: INestApplication<App>;
  const tokens = {} as Record<Who, string>;
  let rideModel: Model<Record<string, unknown>>;
  let checkpointModel: Model<Record<string, unknown>>;
  let calculateFare: typeof import("../src/modules/pricing/fare-calculator").calculateFare;
  let driverProfileId: string;

  const api = () => request(app.getHttpServer());
  const as = (who: Who) => ({ Authorization: `Bearer ${tokens[who]}` });
  const minutes = (count: number) => count * 60_000;

  const estimate = async (rideType = "AUTO"): Promise<Anything> =>
    (
      await api()
        .post("/api/v1/rides/estimate")
        .set(as("customer"))
        .send({
          rideType,
          pickup: PREM_MANDIR,
          destination: BANKE_BIHARI,
        })
        .expect(200)
    ).body.data;

  const bookBody = (extra: Anything = {}) => ({
    rideType: "AUTO",
    pickup: PREM_MANDIR,
    destination: BANKE_BIHARI,
    ...extra,
  });

  async function placeDriver(at: { latitude: number; longitude: number }) {
    await api()
      .patch("/api/v1/drivers/availability")
      .set(as("driver"))
      .send({ isOnline: true, ...at })
      .expect(200);
  }

  /** Books (echoing the quote like the app does), accepts and arrives. */
  async function arrivedRide(extra: Anything = {}): Promise<string> {
    await placeDriver(NEAR_PICKUP);
    const quote = await estimate();
    const booked = await api()
      .post("/api/v1/rides")
      .set(as("customer"))
      .send(
        bookBody({
          expectedFare: quote.fare.estimatedFare,
          quotedAt: quote.quote?.quotedAt,
          ...extra,
        }),
      )
      .expect(201);
    const id = booked.body.data.id as string;
    await api().post(`/api/v1/rides/${id}/accept`).set(as("driver")).expect(200);
    await api()
      .post(`/api/v1/rides/${id}/arrived`)
      .set(as("driver"))
      .expect(200);
    return id;
  }

  async function startRide(id: string): Promise<void> {
    const otp = (
      await api().get(`/api/v1/rides/${id}`).set(as("customer")).expect(200)
    ).body.data.otp.code as string;
    await api()
      .post(`/api/v1/rides/${id}/start`)
      .set(as("driver"))
      .send({ otp })
      .expect(200);
  }

  /** The driver asks to end it, the rider gives the code, the driver completes. */
  async function endRide(id: string): Promise<Anything> {
    await api()
      .post(`/api/v1/rides/${id}/request-end`)
      .set(as("driver"))
      .expect(200);
    const code = (
      await api().get(`/api/v1/rides/${id}`).set(as("customer")).expect(200)
    ).body.data.otp.code as string;
    return (
      await api()
        .post(`/api/v1/rides/${id}/complete`)
        .set(as("driver"))
        .send({ otp: code })
        .expect(200)
    ).body.data;
  }

  const riderView = async (id: string): Promise<Anything> =>
    (await api().get(`/api/v1/rides/${id}`).set(as("customer")).expect(200))
      .body.data;
  const adminDetail = async (id: string): Promise<Anything> =>
    (await api().get(`/api/v1/admin/rides/${id}`).set(as("admin")).expect(200))
      .body.data.ride ?? {};
  const setUpfront = (body: Anything = {}) =>
    api()
      .patch("/api/v1/admin/ride-types/AUTO")
      .set(as("admin"))
      .send({
        pricingMode: "UPFRONT",
        waitFreeMinutes: 3,
        waitPerMinuteRate: 2,
        waitMaxChargeMinutes: 15,
        ...body,
      });

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create({
      instance: { launchTimeout: 60_000 },
    });
    workDir = await mkdtemp(join(tmpdir(), "tirvona-ride-upfront-"));
    process.chdir(workDir);
    Object.assign(process.env, {
      NODE_ENV: "test",
      FINAL_FARE_MODE: "actual",
      RIDE_END_OTP_ENFORCED: "true",
      RIDE_END_FAR_RADIUS_METERS: "500",
      LOG_LEVEL: "silent",
      SWAGGER_ENABLED: "false",
      MONGODB_URI: mongo.getUri(),
      MONGODB_DB_NAME: "tirvona_ride_upfront",
      REDIS_URL: "",
      THROTTLE_LIMIT: "5000",
      THROTTLE_AUTH_LIMIT: "1000",
      THROTTLE_ADMIN_LOGIN_LIMIT: "1000",
      JWT_ACCESS_SECRET: randomBytes(48).toString("base64url"),
      JWT_REFRESH_SECRET: randomBytes(48).toString("base64url"),
      MATCHING_SWEEP_INTERVAL_MS: "0",
      MATCHING_REACTIVE_DISPATCH: "true",
      PAYMENT_RECONCILE_INTERVAL_MS: "0",
      BROADCAST_WORKER_INTERVAL_MS: "0",
      PLACES_PROVIDER: "none",
      DRIVER_LOCATION_MIN_INTERVAL_MS: "200",
    });

    const { AppModule } = await import("../src/app.module");
    const { configureApp } = await import("../src/app.setup");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false, rawBody: true });
    configureApp(app);
    await app.listen(0, "127.0.0.1");

    ({ calculateFare } = await import("../src/modules/pricing/fare-calculator"));
    const { UsersService } = await import("../src/modules/users/users.service");
    const { DriversService } =
      await import("../src/modules/drivers/drivers.service");
    const { UserRole } = await import("../src/common/types/user-role.enum");
    const { Vehicle, VehicleType } =
      await import("../src/modules/vehicles/schemas/vehicle.schema");
    const { DriverProfile, DriverStatus } =
      await import("../src/modules/drivers/schemas/driver-profile.schema");
    const { Ride } = await import("../src/modules/rides/schemas/ride.schema");
    const { DriverLocationCheckpoint } =
      await import("../src/modules/locations/schemas/driver-location-checkpoint.schema");

    rideModel = app.get(getModelToken(Ride.name), { strict: false });
    checkpointModel = app.get(getModelToken(DriverLocationCheckpoint.name), {
      strict: false,
    });
    const driverModel = app.get<Model<unknown>>(
      getModelToken(DriverProfile.name),
      { strict: false },
    );
    const vehicleModel = app.get<Model<unknown>>(getModelToken(Vehicle.name), {
      strict: false,
    });
    const users = app.get(UsersService, { strict: false });
    const drivers = app.get(DriversService, { strict: false });

    await users.create({
      phone: PHONES.admin,
      password: PASSWORD,
      role: UserRole.ADMIN,
      firstName: "Ops",
    });
    await users.create({
      phone: PHONES.customer,
      password: PASSWORD,
      role: UserRole.CUSTOMER,
      firstName: "Asha",
    });
    const driverUser = await users.create({
      phone: PHONES.driver,
      password: PASSWORD,
      role: UserRole.DRIVER,
      firstName: "Raju",
      lastName: "Driver",
    });
    const profile = await drivers.createProfileForUser(
      driverUser._id.toString(),
    );
    driverProfileId = profile._id.toString();
    await driverModel.updateOne(
      { _id: profile._id },
      { $set: { driverStatus: DriverStatus.APPROVED } },
    );
    await vehicleModel.create({
      driverId: profile._id,
      vehicleType: VehicleType.AUTO,
      registrationNumber: "UP85FF0001",
      make: "Bajaj",
      vehicleModel: "RE",
      color: "Green",
      isActive: true,
    });
    for (const who of Object.keys(PHONES) as Who[]) {
      const response = await api()
        .post("/api/v1/auth/login")
        .send({ phone: PHONES[who], password: PASSWORD })
        .expect(200);
      tokens[who] = response.body.data.accessToken as string;
    }
  }, 180_000);

  afterAll(async () => {
    await app?.close();
    await mongo?.stop();
    process.chdir(originalCwd);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  // ── Defaults: deploying changes nothing ───────────────────────────────

  describe("before an admin switches anything on", () => {
    it("ride types are METERED with the default waiting terms", async () => {
      const list = (
        await api().get("/api/v1/admin/ride-types").set(as("admin")).expect(200)
      ).body.data as Array<{ rideType: Anything }>;
      const auto = list.find((row) => row.rideType.code === "AUTO")!.rideType;
      expect(auto).toMatchObject({
        pricingMode: "METERED",
        waitFreeMinutes: 3,
        waitPerMinuteRate: 0,
        waitMaxChargeMinutes: 15,
      });
    });

    it("platform settings carry the default fare settings", async () => {
      const response = await api()
        .get("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .expect(200);
      expect(response.body.data.settings).toMatchObject({
        quoteValiditySeconds: 300,
        etaBufferPercent: 10,
        earlyDropThresholdPercent: 70,
      });
      expect(response.body.data.limits.etaBufferPercent).toBeDefined();
    });

    it("a metered estimate carries no quote and no waiting terms", async () => {
      const quote = await estimate();
      expect(quote.pricingMode).toBe("METERED");
      expect(quote.quote).toBeUndefined();
      expect(quote.waiting).toBeUndefined();
    });

    it("a metered ride is recalculated at completion, capped, with no upfront fields", async () => {
      await placeDriver(NEAR_PICKUP);
      const quote = await estimate();
      const id = (
        await api()
          .post("/api/v1/rides")
          .set(as("customer"))
          .send(bookBody({ expectedFare: 1 }))
          .expect(201)
      ).body.data.id as string;
      await api().post(`/api/v1/rides/${id}/accept`).set(as("driver")).expect(200);
      await api().post(`/api/v1/rides/${id}/arrived`).set(as("driver")).expect(200);
      await startRide(id);
      await rideModel.updateOne(
        { _id: id },
        { $set: { startedAt: new Date(Date.now() - minutes(180)) } },
      );
      const done = await endRide(id);

      // expectedFare is ignored for metered types (nothing is locked).
      expect(done.fare.pricingMode).toBe("METERED");
      expect(done.fare.quotedFare).toBeUndefined();
      expect(done.waiting).toBeUndefined();
      expect(done.fare.final).toMatchObject({ capApplied: true });
      const metered = (await rideModel.findById(id).lean()) as Anything;
      expect(metered.fare.final.mode).toBe("actual");
      expect(done.fare.final.quotedFare).toBeUndefined();
      expect(done.fare.final.waitingCharge).toBeUndefined();
      expect(done.fare.finalFare).toBe(
        Math.round(quote.fare.estimatedFare * 1.5),
      );
    });
  });

  // ── Admin settings ────────────────────────────────────────────────────

  describe("admin settings", () => {
    it("rejects bad ride-type and platform values", async () => {
      await setUpfront({ pricingMode: "BOGUS" }).expect(400);
      await setUpfront({ waitPerMinuteRate: -1 }).expect(400);
      await setUpfront({ waitFreeMinutes: 99 }).expect(400);
      await setUpfront({ waitMaxChargeMinutes: 1.5 }).expect(400);
      await api()
        .patch("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .send({ etaBufferPercent: 99 })
        .expect(400);
      await api()
        .patch("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .send({ earlyDropThresholdPercent: 5 })
        .expect(400);
      await api()
        .patch("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .send({ quoteValiditySeconds: 5 })
        .expect(400);
    });

    it("only an admin can change them", async () => {
      await api()
        .patch("/api/v1/admin/ride-types/AUTO")
        .set(as("customer"))
        .send({ pricingMode: "UPFRONT" })
        .expect(403);
    });

    it("switches AUTO to UPFRONT with waiting terms, and keeps the radii", async () => {
      const before = (
        await api().get("/api/v1/admin/platform-settings").set(as("admin"))
      ).body.data.settings;
      const response = await setUpfront().expect(200);
      expect(response.body.data).toMatchObject({
        pricingMode: "UPFRONT",
        waitFreeMinutes: 3,
        waitPerMinuteRate: 2,
        waitMaxChargeMinutes: 15,
      });
      const settings = await api()
        .patch("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .send({
          quoteValiditySeconds: 300,
          etaBufferPercent: 10,
          earlyDropThresholdPercent: 70,
        })
        .expect(200);
      expect(settings.body.data.settings).toMatchObject({
        matchingRadiusKm: before.matchingRadiusKm,
        nearbyDriversRadiusKm: before.nearbyDriversRadiusKm,
        etaBufferPercent: 10,
      });
    });
  });

  // ── The quote ─────────────────────────────────────────────────────────

  describe("the locked quote", () => {
    it("prices the route duration plus the ETA buffer and holds it for the validity window", async () => {
      const quote = await estimate();
      expect(quote.pricingMode).toBe("UPFRONT");
      expect(quote.quote).toMatchObject({ locked: true, validForSeconds: 300 });
      expect(
        Date.parse(quote.quote.validUntil) - Date.parse(quote.quote.quotedAt),
      ).toBe(300_000);
      expect(quote.waiting).toEqual({
        freeMinutes: 3,
        perMinuteRate: 2,
        maxChargeMinutes: 15,
      });
      const expected = calculateFare(
        {
          currency: "INR",
          baseFare: quote.fare.baseFare,
          perKmRate: quote.fare.perKmRate,
          perMinuteRate: quote.fare.perMinuteRate,
          minimumFare: quote.fare.minimumFare,
        },
        quote.distanceMeters,
        Math.round(quote.durationSeconds * 1.1),
      );
      expect(quote.fare.estimatedFare).toBe(expected.total);
    });

    it("the all-types estimate quotes the same fare as the single estimate", async () => {
      const all = (
        await api()
          .post("/api/v1/rides/estimate/all")
          .set(as("customer"))
          .send({ pickup: PREM_MANDIR, destination: BANKE_BIHARI })
          .expect(200)
      ).body.data as Anything[];
      const auto = all.find((row) => row.rideType === "AUTO")!;
      expect(auto.pricingMode).toBe("UPFRONT");
      expect(auto.quote.locked).toBe(true);
      expect(auto.fare.estimatedFare).toBe(
        (await estimate()).fare.estimatedFare,
      );
      // Other ride types stay metered.
      expect(all.find((row) => row.rideType === "BIKE")!.pricingMode).toBe(
        "METERED",
      );
    });

    it("a bigger buffer raises the quote", async () => {
      const before = (await estimate()).fare.estimatedFare as number;
      await api()
        .patch("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .send({ etaBufferPercent: 50 })
        .expect(200);
      const raised = (await estimate()).fare.estimatedFare as number;
      expect(raised).toBeGreaterThanOrEqual(before);
      await api()
        .patch("/api/v1/admin/platform-settings")
        .set(as("admin"))
        .send({ etaBufferPercent: 10 })
        .expect(200);
      expect((await estimate()).fare.estimatedFare).toBe(before);
    });
  });

  // ── Booking and PRICE_CHANGED ─────────────────────────────────────────

  describe("booking against a quote", () => {
    beforeAll(async () => {
      await placeDriver(NEAR_PICKUP);
    });

    afterEach(async () => {
      const active = await api()
        .get("/api/v1/rides/active")
        .set(as("customer"))
        .expect(200);
      if (active.body.data)
        await api()
          .post(`/api/v1/rides/${active.body.data.id}/cancel`)
          .set(as("customer"))
          .send({})
          .expect(200);
    });

    it("an older app that sends no expected fare still books, at the locked quote", async () => {
      const quote = await estimate();
      const booked = (
        await api()
          .post("/api/v1/rides")
          .set(as("customer"))
          .send(bookBody())
          .expect(201)
      ).body.data as Anything;
      expect(booked.fare).toMatchObject({
        pricingMode: "UPFRONT",
        estimatedFare: quote.fare.estimatedFare,
        quotedFare: quote.fare.estimatedFare,
      });
      expect(booked.waiting).toMatchObject({
        freeMinutes: 3,
        perMinuteRate: 2,
        maxChargeMinutes: 15,
        running: false,
        currentCharge: 0,
      });
    });

    it("books when the expected fare and the quote time match", async () => {
      const quote = await estimate();
      await api()
        .post("/api/v1/rides")
        .set(as("customer"))
        .send(
          bookBody({
            expectedFare: quote.fare.estimatedFare,
            quotedAt: quote.quote.quotedAt,
          }),
        )
        .expect(201);
    });

    it("refuses with PRICE_CHANGED and the new quote when the fare differs, creating no ride", async () => {
      const quote = await estimate();
      const response = await api()
        .post("/api/v1/rides")
        .set(as("customer"))
        .send(bookBody({ expectedFare: quote.fare.estimatedFare + 25 }))
        .expect(409);
      expect(response.body.code).toBe("PRICE_CHANGED");
      expect(response.body.data).toMatchObject({
        reason: "PRICE_CHANGED",
        previousFare: quote.fare.estimatedFare + 25,
        newFare: quote.fare.estimatedFare,
      });
      expect(response.body.data.estimate.fare.estimatedFare).toBe(
        quote.fare.estimatedFare,
      );
      expect(response.body.data.estimate.quote.locked).toBe(true);
      const active = await api()
        .get("/api/v1/rides/active")
        .set(as("customer"))
        .expect(200);
      expect(active.body.data).toBeNull();
    });

    it("refuses an expired quote even at the same price", async () => {
      const quote = await estimate();
      const response = await api()
        .post("/api/v1/rides")
        .set(as("customer"))
        .send(
          bookBody({
            expectedFare: quote.fare.estimatedFare,
            quotedAt: new Date(Date.now() - minutes(10)).toISOString(),
          }),
        )
        .expect(409);
      expect(response.body.code).toBe("PRICE_CHANGED");
      expect(response.body.data.reason).toBe("QUOTE_EXPIRED");
      expect(response.body.data.newFare).toBe(quote.fare.estimatedFare);
    });

    it("validates the new booking fields", async () => {
      await api()
        .post("/api/v1/rides")
        .set(as("customer"))
        .send(bookBody({ expectedFare: -5 }))
        .expect(400);
      await api()
        .post("/api/v1/rides")
        .set(as("customer"))
        .send(bookBody({ quotedAt: "yesterday" }))
        .expect(400);
    });

    it("the quote freezes on the ride: later admin edits never touch it", async () => {
      const quote = await estimate();
      const id = (
        await api()
          .post("/api/v1/rides")
          .set(as("customer"))
          .send(bookBody({ expectedFare: quote.fare.estimatedFare }))
          .expect(201)
      ).body.data.id as string;
      await setUpfront({ waitPerMinuteRate: 9, waitFreeMinutes: 1 }).expect(200);
      const view = await riderView(id);
      expect(view.waiting).toMatchObject({ freeMinutes: 3, perMinuteRate: 2 });
      expect(view.fare.quotedFare).toBe(quote.fare.estimatedFare);
      await setUpfront().expect(200);
    });
  });

  // ── Completion ────────────────────────────────────────────────────────

  describe("completion", () => {
    it("bills the quote when the trip runs three hours over", async () => {
      const id = await arrivedRide();
      const quoted = (await riderView(id)).fare.quotedFare as number;
      await startRide(id);
      await rideModel.updateOne(
        { _id: id },
        { $set: { startedAt: new Date(Date.now() - minutes(180)) } },
      );
      const done = await endRide(id);

      expect(done.fare.finalFare).toBe(quoted);
      expect(done.fare.final).toMatchObject({
        quotedFare: quoted,
        total: quoted,
        waitingCharge: 0,
        earlyDrop: false,
        capApplied: false,
      });
      // What the meter would have charged is kept for the report: far above the quote.
      const stored = (await rideModel.findById(id).lean()) as Anything;
      expect(stored.fare.final.mode).toBe("upfront");
      expect(stored.fare.final.meteredEquivalent).toBeGreaterThan(quoted);
      expect(done.paymentStatus).toBe("PENDING");
    });

    it("shows the driver the fixed fare and what they earn on it", async () => {
      const id = await arrivedRide();
      const quoted = (await riderView(id)).fare.quotedFare as number;
      const driverView = (
        await api().get(`/api/v1/rides/${id}`).set(as("driver")).expect(200)
      ).body.data as Anything;
      expect(driverView.fare.pricingMode).toBe("UPFRONT");
      expect(driverView.fare.estimatedFare).toBe(quoted);
      expect(driverView.waiting).toMatchObject({ freeMinutes: 3, running: true });
      expect(driverView.earning).toMatchObject({ gross: quoted, final: false });
      expect(driverView.earning.commissionPercent).toBeGreaterThan(0);
      expect(
        Math.round((driverView.earning.net + driverView.earning.commission) * 100),
      ).toBe(Math.round(quoted * 100));
      // Customers never see commission.
      expect((await riderView(id)).earning).toBeUndefined();
      await startRide(id);
      await endRide(id);
    });

    it("shows a live waiting meter while the driver waits at the pickup", async () => {
      const id = await arrivedRide();
      await rideModel.updateOne(
        { _id: id },
        { $set: { arrivedAt: new Date(Date.now() - minutes(5)) } },
      );
      const view = (await riderView(id)).waiting as Anything;
      expect(view).toMatchObject({
        running: true,
        freeMinutes: 3,
        chargeableMinutes: 2,
        currentCharge: 4,
        capped: false,
      });
      expect(view.waitedSeconds).toBeGreaterThanOrEqual(300);
      expect(Date.parse(view.freeUntil)).toBeLessThan(Date.now());
      await startRide(id);
      const started = (await riderView(id)).waiting as Anything;
      expect(started.running).toBe(false);
      await endRide(id);
    });

    it("adds waiting past the free minutes as its own amount", async () => {
      const id = await arrivedRide();
      const quoted = (await riderView(id)).fare.quotedFare as number;
      await rideModel.updateOne(
        { _id: id },
        { $set: { arrivedAt: new Date(Date.now() - minutes(8)) } },
      );
      await startRide(id);
      const done = await endRide(id);

      // 8 min waited − 3 free = 5 chargeable minutes × ₹2
      expect(done.fare.final).toMatchObject({
        quotedFare: quoted,
        waitingCharge: 10,
        waitingChargeableMinutes: 5,
      });
      expect(done.fare.final.waitingSeconds).toBeGreaterThanOrEqual(480);
      expect(done.fare.finalFare).toBe(quoted + 10);
      expect(done.waiting.currentCharge).toBe(10);
    });

    it("does not charge for a wait inside the free minutes", async () => {
      const id = await arrivedRide();
      const quoted = (await riderView(id)).fare.quotedFare as number;
      await rideModel.updateOne(
        { _id: id },
        { $set: { arrivedAt: new Date(Date.now() - minutes(2)) } },
      );
      await startRide(id);
      const done = await endRide(id);
      expect(done.fare.final.waitingCharge).toBe(0);
      expect(done.fare.finalFare).toBe(quoted);
    });

    it("caps a very long wait", async () => {
      const id = await arrivedRide();
      const quoted = (await riderView(id)).fare.quotedFare as number;
      await rideModel.updateOne(
        { _id: id },
        { $set: { arrivedAt: new Date(Date.now() - minutes(90)) } },
      );
      await startRide(id);
      const done = await endRide(id);
      expect(done.fare.final).toMatchObject({
        waitingCharge: 30,
        waitingChargeableMinutes: 15,
      });
      expect(done.fare.finalFare).toBe(quoted + 30);
    });

    it("never charges waiting while the rate is zero", async () => {
      await setUpfront({ waitPerMinuteRate: 0 }).expect(200);
      const id = await arrivedRide();
      const quoted = (await riderView(id)).fare.quotedFare as number;
      await rideModel.updateOne(
        { _id: id },
        { $set: { arrivedAt: new Date(Date.now() - minutes(30)) } },
      );
      await startRide(id);
      const done = await endRide(id);
      expect(done.fare.final.waitingCharge).toBe(0);
      expect(done.fare.finalFare).toBe(quoted);
      await setUpfront().expect(200);
    });

    it("applies the promo to the base fare, not to the waiting charge", async () => {
      const now = Date.now();
      await api()
        .post("/api/v1/admin/promotions")
        .set(as("admin"))
        .send({
          code: "upfront20",
          title: "₹20 off",
          discountType: "FLAT",
          discountValue: 20,
          minRideValue: 30,
          usageLimit: 5,
          perUserLimit: 5,
          startsAt: new Date(now - 3_600_000).toISOString(),
          endsAt: new Date(now + 86_400_000).toISOString(),
          applicableRideTypes: ["AUTO"],
          showInApp: true,
        })
        .expect(201);
      const id = await arrivedRide({ promoCode: "UPFRONT20" });
      const quoted = (await riderView(id)).fare.quotedFare as number;
      await rideModel.updateOne(
        { _id: id },
        { $set: { arrivedAt: new Date(Date.now() - minutes(8)) } },
      );
      await startRide(id);
      const done = await endRide(id);

      expect(done.fare.final).toMatchObject({
        quotedFare: quoted,
        waitingCharge: 10,
        discount: 20,
      });
      expect(done.fare.finalFare).toBe(quoted + 10);
      expect(done.fare.payableFare).toBe(quoted + 10 - 20);
    });

    describe("early drop", () => {
      /** A reliable trail covering `share` of the way, one fix a minute for the 8 minutes it took. */
      async function tripTrailTo(id: string, share: number) {
        const startedAt = new Date(Date.now() - minutes(8));
        await rideModel.updateOne(
          { _id: id },
          { $set: { startedAt } },
        );
        await checkpointModel.deleteMany({ rideId: id });
        const steps = 8;
        const rows = Array.from({ length: steps + 1 }, (_, step) => {
          const progress = (share * step) / steps;
          return {
            rideId: id,
            driverId: driverProfileId,
            kind: step === 0 ? "STARTED" : "TRIP",
            source: "LIVE",
            recordedAt: new Date(startedAt.getTime() + step * 60_000),
            location: {
              type: "Point",
              coordinates: [
                PREM_MANDIR.longitude +
                  (BANKE_BIHARI.longitude - PREM_MANDIR.longitude) * progress,
                PREM_MANDIR.latitude +
                  (BANKE_BIHARI.latitude - PREM_MANDIR.latitude) * progress,
              ],
            },
          };
        });
        await checkpointModel.insertMany(rows);
        const last = rows[rows.length - 1].location.coordinates;
        await placeDriver({ latitude: last[1], longitude: last[0] });
      }

      it("bills the distance travelled when the rider is dropped well short of the destination", async () => {
        const id = await arrivedRide();
        const quoted = (await riderView(id)).fare.quotedFare as number;
        await startRide(id);
        await tripTrailTo(id, 0.35);
        const done = await endRide(id);

        expect(done.fare.final.earlyDrop).toBe(true);
        expect(done.fare.final.quotedFare).toBe(quoted);
        expect(done.fare.finalFare).toBeLessThan(quoted);
        const stored = (await rideModel.findById(id).lean()) as Anything;
        expect(done.fare.finalFare).toBe(stored.fare.final.meteredEquivalent);
        expect(done.fare.finalFare).toBeGreaterThanOrEqual(
          stored.fare.minimumFare,
        );
        await placeDriver(NEAR_PICKUP);
      });

      it("keeps the full quote when the trail covered most of the way", async () => {
        const id = await arrivedRide();
        const quoted = (await riderView(id)).fare.quotedFare as number;
        await startRide(id);
        await tripTrailTo(id, 0.9);
        const done = await endRide(id);
        expect(done.fare.final.earlyDrop).toBe(false);
        expect(done.fare.finalFare).toBe(quoted);
        await placeDriver(NEAR_PICKUP);
      });

      it("a missing trail (GPS fault) never lowers the fare", async () => {
        const id = await arrivedRide();
        const quoted = (await riderView(id)).fare.quotedFare as number;
        await startRide(id);
        await checkpointModel.deleteMany({
          rideId: id,
          kind: { $ne: "STARTED" },
        });
        // The driver ends the trip far from the drop-off with only the start fix on record.
        const done = await endRide(id);
        expect(done.fare.final.earlyDrop).toBe(false);
        expect(done.fare.finalFare).toBe(quoted);
      });
    });
  });

  // ── Admin fare adjustments ────────────────────────────────────────────

  describe("admin fare adjustments", () => {
    let rideId: string;
    let quoted: number;

    beforeAll(async () => {
      rideId = await arrivedRide();
      quoted = (await riderView(rideId)).fare.quotedFare as number;
      await startRide(rideId);
    });

    const adjust = (id: string, body: Anything, who: Who = "admin") =>
      api()
        .post(`/api/v1/admin/rides/${id}/fare-adjustments`)
        .set(as(who))
        .send(body);

    it("refuses a ride that is not completed", async () => {
      const response = await adjust(rideId, {
        type: "CREDIT",
        amount: 10,
        reason: "Goodwill for the long wait",
      }).expect(409);
      expect(response.body.code).toBe("FARE_ADJUSTMENT_NOT_ALLOWED");
    });

    it("only an admin can adjust", async () => {
      await adjust(
        rideId,
        { type: "CREDIT", amount: 10, reason: "Not allowed" },
        "customer",
      ).expect(403);
    });

    it("validates the body", async () => {
      await adjust(rideId, { type: "CREDIT", amount: 0, reason: "Zero" }).expect(
        400,
      );
      await adjust(rideId, {
        type: "REFUND",
        amount: 5,
        reason: "Wrong type",
      }).expect(400);
      await adjust(rideId, { type: "CREDIT", amount: 5, reason: "x" }).expect(
        400,
      );
    });

    it("credits a completed, unpaid ride and records who, why and when", async () => {
      await endRide(rideId);
      const response = await adjust(rideId, {
        type: "CREDIT",
        amount: 10,
        reason: "Goodwill for a slow trip",
      }).expect(200);
      const fare = response.body.data.ride.fare as Anything;
      expect(fare.finalFare).toBe(quoted - 10);
      expect(fare.payableFare).toBe(quoted - 10);
      expect(fare.final).toMatchObject({
        total: quoted - 10,
        payable: quoted - 10,
        adjustmentsTotal: -10,
      });
      expect(fare.adjustments).toHaveLength(1);
      expect(fare.adjustments[0]).toMatchObject({
        type: "CREDIT",
        amount: -10,
        reason: "Goodwill for a slow trip",
      });
      // The customer sees it too.
      expect((await riderView(rideId)).fare.payableFare).toBe(quoted - 10);
    });

    it("a charge needs the customer's consent", async () => {
      const refused = await adjust(rideId, {
        type: "CHARGE",
        amount: 30,
        reason: "Toll paid by the driver",
      }).expect(409);
      expect(refused.body.code).toBe("FARE_ADJUSTMENT_NOT_ALLOWED");
      const accepted = await adjust(rideId, {
        type: "CHARGE",
        amount: 30,
        reason: "Toll paid by the driver",
        customerConsent: true,
      }).expect(200);
      expect(accepted.body.data.ride.fare.finalFare).toBe(quoted + 20);
      expect(accepted.body.data.ride.fare.final.adjustmentsTotal).toBe(20);
      expect(accepted.body.data.ride.fare.adjustments).toHaveLength(2);
    });

    it("never brings the amount payable to nothing", async () => {
      const response = await adjust(rideId, {
        type: "CREDIT",
        amount: 9_999,
        reason: "Too generous",
      }).expect(409);
      expect(response.body.code).toBe("FARE_ADJUSTMENT_NOT_ALLOWED");
    });

    it("is audited", async () => {
      const logs = await api()
        .get("/api/v1/admin/audit-logs")
        .set(as("admin"))
        .query({ limit: 50 })
        .expect(200);
      const actions = JSON.stringify(logs.body.data);
      expect(actions).toContain("ride.fare_adjust");
    });

    it("is refused once a payment has started", async () => {
      await rideModel.updateOne(
        { _id: rideId },
        { $set: { paymentStatus: "ORDER_CREATED" } },
      );
      const response = await adjust(rideId, {
        type: "CREDIT",
        amount: 5,
        reason: "Too late for this",
      }).expect(409);
      expect(response.body.code).toBe("FARE_ADJUSTMENT_NOT_ALLOWED");
      expect(response.body.data.paymentStatus).toBe("ORDER_CREATED");
    });

    it("is refused once the ride is paid (use a refund)", async () => {
      await rideModel.updateOne(
        { _id: rideId },
        { $set: { paymentStatus: "SUCCESS" } },
      );
      await adjust(rideId, {
        type: "CREDIT",
        amount: 5,
        reason: "Paid already",
      }).expect(409);
    });

    it("the adjustment is reflected in what the customer must pay", async () => {
      const paying = await arrivedRide();
      await startRide(paying);
      const done = await endRide(paying);
      await adjust(paying, {
        type: "CREDIT",
        amount: 7,
        reason: "Dispute settled in the customer's favour",
      }).expect(200);
      const view = await riderView(paying);
      expect(view.fare.payableFare).toBe(done.fare.finalFare - 7);
    });
  });

  // ── Report ────────────────────────────────────────────────────────────

  describe("quote versus actual report", () => {
    it("summarises the upfront rides: quote, meter, what Tirvona absorbed, early drops and waiting", async () => {
      const response = await api()
        .get("/api/v1/admin/reports/fare-quotes")
        .query({ preset: "TODAY" })
        .set(as("admin"))
        .expect(200);
      const report = response.body.data as Anything;
      expect(report.totals.rides).toBeGreaterThanOrEqual(6);
      expect(report.totals.earlyDrops).toBeGreaterThanOrEqual(1);
      expect(report.totals.waitingRides).toBeGreaterThanOrEqual(3);
      expect(report.totals.waitingCharges).toBeGreaterThanOrEqual(40);
      // The three-hour ride was billed far below the meter: Tirvona absorbed it.
      expect(report.totals.absorbedRides).toBeGreaterThanOrEqual(1);
      expect(report.totals.absorbed).toBeLessThan(0);
      expect(report.totals.variance).toBe(
        Math.round((report.totals.billed - report.totals.metered) * 100) / 100,
      );
      expect(report.byRideType).toHaveLength(1);
      expect(report.byRideType[0].rideType).toBe("AUTO");
      expect(report.byRoute.length).toBeGreaterThanOrEqual(1);
      expect(report.byRoute[0]).toMatchObject({
        rideType: "AUTO",
        pickup: { address: PREM_MANDIR.address },
        destination: { address: BANKE_BIHARI.address },
      });
      // Worst route first.
      const variances = (report.byRoute as Anything[]).map((row) => row.variance);
      expect([...variances].sort((a, b) => a - b)).toEqual(variances);
    });

    it("filters by ride type, excludes metered rides, and is admin-only", async () => {
      const bike = await api()
        .get("/api/v1/admin/reports/fare-quotes")
        .query({ preset: "TODAY", rideType: "BIKE" })
        .set(as("admin"))
        .expect(200);
      expect(bike.body.data.totals.rides).toBe(0);
      await api()
        .get("/api/v1/admin/reports/fare-quotes")
        .set(as("customer"))
        .expect(403);
      await api()
        .get("/api/v1/admin/reports/fare-quotes")
        .query({ rideType: "not-a-code" })
        .set(as("admin"))
        .expect(400);
    });
  });
});

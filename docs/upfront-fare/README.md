# Upfront fares

The price quoted at booking is the price the customer pays. Exceptions are
explicit and small: a wait at the pickup adds to it, a trip ended well short
of the drop-off costs less, and support can correct it before payment.

Charging is chosen **per ride type**. Deploying this changes nothing: every ride
type starts **METERED** (the fare is recalculated from the actual trip at
completion, capped at `FINAL_FARE_MAX_ESTIMATE_MULTIPLIER` × the estimate, as
before). An admin switches a ride type to **UPFRONT** on the *Ride types* page.

## Settings

Per ride type (admin → Ride types → Edit, `PATCH /admin/ride-types/:code`):

| Field | Meaning | Default |
|---|---|---|
| `pricingMode` | `UPFRONT` or `METERED` | `METERED` |
| `waitFreeMinutes` | Free wait at the pickup | 3 |
| `waitPerMinuteRate` | ₹ per chargeable minute (0 = waiting is free) | 0 |
| `waitMaxChargeMinutes` | Most minutes that can be billed | 15 |

Platform-wide (admin → Ride limits → *Upfront fares*, `PATCH /admin/platform-settings`,
stored on the same `platform_settings` document as the radii; absent = default):

| Field | Meaning | Default | Range |
|---|---|---|---|
| `quoteValiditySeconds` | How long a quote can be confirmed | 300 | 30–3600 |
| `etaBufferPercent` | Slack added to the route ETA when quoting | 10 | 0–50 |

Every edit is audited with the previous values.

## How it works

### Quote (estimate screens and booking agree)

For an UPFRONT ride type the fare is
`calculateFare(rates, distance, duration × (1 + etaBuffer%))`, for both
`POST /rides/estimate`, `POST /rides/estimate/all` and `POST /rides`.
The estimate carries `pricingMode: "UPFRONT"`, `quote { locked, quotedAt,
validUntil, validForSeconds }` and `waiting { freeMinutes, perMinuteRate,
maxChargeMinutes }`. Peak pricing still applies (it is part of the rates the
quote is priced on and is frozen on the ride).

### Booking: `expectedFare` and `PRICE_CHANGED`

`POST /rides` accepts optional `expectedFare` and `quotedAt` (the quote's
`quotedAt`). For an upfront ride type the server **always re-prices**; if its
price differs from `expectedFare`, or the quote is older than
`quoteValiditySeconds`, it answers `409 PRICE_CHANGED`:

```json
{ "code": "PRICE_CHANGED",
  "data": { "reason": "PRICE_CHANGED | QUOTE_EXPIRED",
            "previousFare": 75, "newFare": 82, "estimate": { …fresh estimate… } } }
```

No ride is created. Old apps that send neither field book at the locked
quote with no check. The fields can only make the server refuse, never change
the price. Metered ride types ignore them.

### Ride snapshot (`ride.fare`)

Copied onto the ride at booking, so it finishes under the rules it was booked
with whatever an admin edits later: `pricingMode`, `quotedFare`, `quotedAt`,
`bufferPercent` and `waiting { freeMinutes, perMinuteRate, maxChargeMinutes }`.
Rides booked before this feature have none of these
and are METERED.

### Completion (`RideLifecycleService.finish`)

Upfront rides (`pricing/upfront-fare.ts`, pure and unit-tested):

1. **Base** = `quotedFare`. Nothing is recalculated from time, distance or where
   the rider got off: the price shown at booking is the final price. (An earlier
   version billed a trip ended below 70% of the distance on the distance travelled;
   that rule was removed.)
2. **Waiting**: `max(0, startedAt − arrivedAt − freeMinutes)`, rounded **up** to
   whole minutes, capped at `maxChargeMinutes`, × rate, to whole rupees. It is its
   own line on the bill.
3. The **promo** discounts the base fare, not the waiting charge.
4. `finalFare = base + waiting`; `payableFare = finalFare − discount`. Payments,
   the driver's earning and commission follow from these through the existing
   code (the driver earns, and commission applies, on the waiting charge too).

`ride.fare.final` gains `quotedFare`, `waitingCharge`, `waitingSeconds`,
`waitingChargeableMinutes`, `meteredEquivalent` (what the meter
would have charged: reporting) and `adjustmentsTotal`.

Circuits are not affected (they have their own pricing and completion).

### Live waiting meter

`ride.waiting` (customer and driver views, upfront rides) carries the terms,
`waitedSeconds`, `chargeableMinutes`, `currentCharge`, `freeUntil`, `running`
(driver arrived, trip not started) and `serverTime`. Apps count on locally from
the server's reading, so a wrong phone clock does not matter.

### Driver earning

Driver views carry `earning { gross, commissionPercent, commission, net, final }`:
the fare less Tirvona's commission at the rate in force (the booked fare until
the ride completes). Customers never see it.

### Admin fare adjustments

`POST /admin/rides/:id/fare-adjustments { type: CREDIT|CHARGE, amount, reason, customerConsent? }`

* Only a **completed** ride whose payment status is still **PENDING** (no gateway
  order exists). Once a payment has started the amount is fixed; after payment use
  the refund flow.
* A CHARGE needs `customerConsent: true`. The payable amount cannot drop below ₹1.
* One compare-and-set on the stored final fare: two admins cannot both win.
  Adjustments are appended to `fare.adjustments` (never edited), change
  `finalFare`, `payableFare`, `final.total/payable/adjustmentsTotal`, bump
  `stateVersion` and push `ride.payment_updated` to both apps. Audited as
  `ride.fare_adjust`.

### Report

`GET /admin/reports/fare-quotes?preset=…&rideType=…` (admin Reports → *Fare quotes*):
for completed upfront rides — locked quotes, what was billed for the trip,
what the meter would have charged, the difference (negative = Tirvona
absorbed it), rides billed below the meter and waiting charges,
by ride type and by route (pickup and drop-off grouped into ~1 km cells, worst
first). Use it to tune the ETA buffer and spot under-priced routes.

## Rollout

1. Deploy the API and the admin panel. Everything is METERED: nothing changes.
2. Release the apps (Play Store). Old versions keep working: the server only adds
   fields and skips the `expectedFare` check when it is missing.
3. In *Ride types*, switch one type (e.g. Auto) to **Upfront**, set its waiting
   terms, watch *Reports → Fare quotes* for a week, then enable the others.
4. A quote's ETA uses Google Routes. `ROUTES_TRAFFIC_AWARE=true` makes ETAs
   traffic-aware (more accurate, Google's higher-priced SKU); it is left **off**
   until the business approves the cost. The ETA buffer is the cheap alternative.

## Tests

* `src/modules/pricing/upfront-fare.spec.ts`: buffer, waiting (exactly at the free
  minutes, cap, zero rate, rounding), the quote holding for a slow, short or
  GPS-less trip.
* `test/upfront-fare.e2e-spec.ts`: defaults and metered unchanged, settings
  validation, quote on both estimate screens, `PRICE_CHANGED` (price / expiry / old
  apps), completion at the quote after a 3-hour trip, waiting (live meter, charge,
  cap, free window, zero rate), promo on the base only, the quote holding wherever
  the rider gets off, driver earning, admin adjustments (credit, consented charge, floor,
  audit, refused after payment starts) and the report.
* Flutter `test/features/rides/upfront_fare_test.dart`: models, meter maths, fare
  breakdown, booking controller and the Choose-a-ride screen (lock, price-change
  dialog).

## Decisions left to the business

* **Platform absorbs variance.** If trips regularly run slower than the buffer,
  Tirvona loses the difference. The report and the buffer are the controls.
* **Commission on waiting charge**: currently the driver earns it and commission
  applies as on the fare. Driver-only would be a small change in
  `earnings/commission` input (`grossFarePaise`).
* **Traffic-aware routing cost** (see Rollout).
* **Cancel after waiting**: cancellation-fee rules are unchanged; waiting does not
  count towards them.
* **Customer-facing terms text** for waiting must be written.

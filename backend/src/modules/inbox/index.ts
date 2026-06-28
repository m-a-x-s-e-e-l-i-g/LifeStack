import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import type { Connector, ConnectorContext, LifeStackModule } from "../../core/types";

const EUR_PER_UNIT: Record<string, number> = {
  EUR: 1,
  CZK: 0.0402,
  USD: 0.93,
  GBP: 1.18,
  PLN: 0.235,
  CHF: 1.04,
  SEK: 0.086,
  NOK: 0.086,
  DKK: 0.134,
  HUF: 0.0025,
};

type ProviderKind =
  | "mobility"
  | "mobility_pass"
  | "food"
  | "groceries"
  | "parking"
  | "flights"
  | "reservations";

interface Candidate {
  kind: ProviderKind;
  provider: string;
  messageId: string;
  day: string;
  startedAt: string;
  amount: number;
  currency: string;
  distanceKm: number;
  durationMin: number;
  type: string;
  merchant: string;
  itemsCount?: number;
  pickupLocation?: string;
  dropoffLocation?: string;
  flightNumber?: string;
  bookingRef?: string;
  originIata?: string;
  destinationIata?: string;
  passenger?: string;
  seat?: string;
  reservationCategory?: string;
  reservationRef?: string;
  guests?: number;
  venue?: string;
}

interface LearningCounts {
  approved: number;
  declined: number;
}

function toNum(v: string): number {
  const n = Number(v.replace(",", "."));
  return Number.isFinite(n) ? n : 0;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

function normCurrency(raw: string): string {
  const v = raw.trim().toUpperCase();
  if (!v) return "EUR";
  if (v === "€" || v === "EUR") return "EUR";
  if (v === "KČ" || v === "KC" || v === "CZK") return "CZK";
  if (v === "$" || v === "USD") return "USD";
  if (v === "£" || v === "GBP") return "GBP";
  if (v === "ZŁ" || v === "PLN") return "PLN";
  return /^[A-Z]{3}$/.test(v) ? v : "EUR";
}

function toEur(amount: number, currency: string): number {
  const rate = EUR_PER_UNIT[currency] ?? 1;
  return round2(amount * rate);
}

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoStamp(d: Date): string {
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function normalizeMessageId(raw: unknown): string {
  const value = String(raw ?? "").trim();
  if (!value) return "";
  return value.replace(/^<|>$/g, "").trim();
}

function fallbackMessageId(parts: unknown[]): string {
  const seed = parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return `hash:${createHash("sha1").update(seed).digest("hex")}`;
}

function compactEmailText(raw: unknown): string {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

function buildEmailExcerpt(subject: unknown, text: unknown): string {
  const parts = [];
  const subjectText = compactEmailText(subject);
  if (subjectText) parts.push(`Subject: ${subjectText}`);
  const bodyText = compactEmailText(text);
  if (bodyText) parts.push(bodyText);
  const excerpt = parts.join(" | ");
  if (!excerpt) return "";
  const maxLen = 700;
  return excerpt.length <= maxLen ? excerpt : `${excerpt.slice(0, maxLen - 3)}...`;
}

function dedupeKey(candidate: Candidate): string {
  const amount = round2(candidate.amount);
  const currency = normCurrency(candidate.currency);
  const distance = round2(candidate.distanceKm);
  const duration = Math.round(candidate.durationMin);
  const merchant = String(candidate.merchant ?? "").trim().toLowerCase();
  const type = String(candidate.type ?? "").trim().toLowerCase();
  return [
    candidate.kind,
    candidate.provider,
    candidate.messageId,
    candidate.day,
    type,
    amount,
    currency,
    distance,
    duration,
    merchant,
  ].join("|");
}

function normalizeLearningToken(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function learningProviderKey(kind: unknown, provider: unknown): string {
  return [normalizeLearningToken(kind), normalizeLearningToken(provider)].join("|");
}

function learningKeyFromParts(
  kind: unknown,
  provider: unknown,
  type: unknown,
  merchant: unknown,
  amount: unknown,
  currency: unknown,
): string {
  return [
    normalizeLearningToken(kind),
    normalizeLearningToken(provider),
    normalizeLearningToken(type),
    normalizeLearningToken(merchant),
    round2(Number(amount ?? 0)).toFixed(2),
    normCurrency(String(currency ?? "EUR")),
  ].join("|");
}

function learningKey(candidate: Candidate): string {
  return learningKeyFromParts(
    candidate.kind,
    candidate.provider,
    candidate.type,
    candidate.merchant,
    candidate.amount,
    candidate.currency,
  );
}

function tallyLearning(
  map: Map<string, LearningCounts>,
  key: string,
  status: string,
): void {
  if (!key) return;
  const next = map.get(key) ?? { approved: 0, declined: 0 };
  if (status === "approved") next.approved += 1;
  else if (status === "declined") next.declined += 1;
  map.set(key, next);
}

function candidateToPendingRow(
  candidate: Candidate,
  key: string,
  sourceConnector: string,
  source: "mailbox" | "backfill",
  reviewNote: string,
  emailExcerpt: string,
): Record<string, unknown> {
  const amount = round2(candidate.amount);
  const currency = normCurrency(candidate.currency);
  return {
    id: createHash("sha1").update(key).digest("hex"),
    day: candidate.day,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    dedupe_key: key,
    status: "pending",
    kind: candidate.kind,
    provider: candidate.provider,
    message_id: candidate.messageId,
    email_excerpt: emailExcerpt,
    started_at: candidate.startedAt,
    type: candidate.type,
    merchant: candidate.merchant ?? "",
    amount,
    currency,
    amount_eur: toEur(amount, currency),
    distance_km: round2(candidate.distanceKm),
    duration_min: Math.round(candidate.durationMin),
    items_count: candidate.itemsCount ?? 0,
    pickup_location: candidate.pickupLocation ?? "",
    dropoff_location: candidate.dropoffLocation ?? "",
    flight_number: candidate.flightNumber ?? "",
    booking_ref: candidate.bookingRef ?? "",
    origin_iata: (candidate.originIata ?? "").toUpperCase(),
    destination_iata: (candidate.destinationIata ?? "").toUpperCase(),
    passenger: candidate.passenger ?? "",
    seat: candidate.seat ?? "",
    reservation_category: candidate.reservationCategory ?? "",
    reservation_ref: candidate.reservationRef ?? "",
    guests: Math.max(0, Math.round(candidate.guests ?? 0)),
    venue: candidate.venue ?? "",
    source,
    source_connector: sourceConnector,
    review_note: reviewNote,
  };
}

function candidateToSeenRow(
  candidate: Candidate,
  key: string,
): Record<string, unknown> {
  return {
    day: candidate.day,
    dedupe_key: key,
    provider: candidate.provider,
    kind: candidate.kind,
    message_id: candidate.messageId,
    created_at: new Date().toISOString(),
  };
}

function pickAmount(text: string): { amount: number; currency: string } {
  const t = text.replace(/\s+/g, " ");
  const symbolFirst = t.match(/(?:€|\$|£)\s*([0-9]+(?:[.,][0-9]{1,2})?)/i);
  if (symbolFirst) {
    const symbol = t[symbolFirst.index ?? 0];
    return {
      amount: toNum(symbolFirst[1]),
      currency: normCurrency(symbol),
    };
  }
  const codeAfter = t.match(/([0-9]+(?:[.,][0-9]{1,2})?)\s*(EUR|CZK|USD|GBP|PLN|CHF|SEK|NOK|DKK|HUF|KČ|KC|€|\$|£)\b/i);
  if (codeAfter) {
    return {
      amount: toNum(codeAfter[1]),
      currency: normCurrency(codeAfter[2]),
    };
  }
  return { amount: 0, currency: "EUR" };
}

function pickDistanceKm(text: string): number {
  const m = text.match(/([0-9]+(?:[.,][0-9]+)?)\s*km\b/i);
  return m ? toNum(m[1]) : 0;
}

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return round2(R * c);
}

function pickUberLocations(text: string): { pickup?: string; dropoff?: string; distanceKm: number } {
  let pickup: string | undefined;
  let dropoff: string | undefined;
  let distanceKm = 0;

  // Try to extract pickup location
  const pickupMatch = text.match(/pick(?:ed)?\s+up\s+(?:at|from)?\s*([^\n\r,]+?)(?:\n|,|$)/i);
  if (pickupMatch?.[1]) pickup = pickupMatch[1].trim().slice(0, 100);

  // Try to extract dropoff location
  const dropoffMatch = text.match(/drop(?:ped)?\s+off\s+(?:at|to)?\s*([^\n\r,]+?)(?:\n|,|$)/i);
  if (dropoffMatch?.[1]) dropoff = dropoffMatch[1].trim().slice(0, 100);

  // Try to extract coordinates from either location (format: "52.3676° N, 4.9041° E" or "52.3676, 4.9041")
  const coordPattern = /(\d+(?:\.\d+)?)[°]?\s*([NS])?[,\s]+(\d+(?:\.\d+)?)[°]?\s*([EW])?/gi;
  const coords: Array<{ lat: number; lon: number }> = [];

  let match;
  while ((match = coordPattern.exec(text))) {
    let lat = parseFloat(match[1]);
    let lon = parseFloat(match[3]);

    if (match[2]?.toUpperCase() === "S") lat = -lat;
    if (match[4]?.toUpperCase() === "W") lon = -lon;

    if (lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180) {
      coords.push({ lat, lon });
    }
  }

  // If we found 2 coordinates, calculate distance
  if (coords.length >= 2) {
    distanceKm = haversineDistance(coords[0].lat, coords[0].lon, coords[1].lat, coords[1].lon);
  }

  return { pickup, dropoff, distanceKm };
}

function pickDurationMin(text: string): number {
  const m = text.match(/([0-9]{1,3})\s*(?:min|mins|minutes)\b/i);
  return m ? Math.round(toNum(m[1])) : 0;
}

function pickMerchant(text: string): string {
  const patterns = [
    /order from\s+([^\n\r,]+)/i,
    /bestelling bij\s+([^\n\r,]+)/i,
    /restaurant[:\s]+([^\n\r,]+)/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim().slice(0, 120);
  }
  return "";
}

const KNOWN_AIRLINES: Array<{ needle: string; name: string }> = [
  { needle: "klm", name: "KLM" },
  { needle: "transavia", name: "Transavia" },
  { needle: "ryanair", name: "Ryanair" },
  { needle: "easyjet", name: "easyJet" },
  { needle: "lufthansa", name: "Lufthansa" },
  { needle: "british airways", name: "British Airways" },
  { needle: "air france", name: "Air France" },
  { needle: "wizz air", name: "Wizz Air" },
  { needle: "vueling", name: "Vueling" },
  { needle: "delta", name: "Delta" },
  { needle: "united", name: "United" },
  { needle: "emirates", name: "Emirates" },
  { needle: "qatar airways", name: "Qatar Airways" },
  { needle: "turkish airlines", name: "Turkish Airlines" },
  { needle: "norwegian", name: "Norwegian" },
  { needle: "iberia", name: "Iberia" },
  { needle: "ita airways", name: "ITA Airways" },
  { needle: "lot polish", name: "LOT" },
];

const KNOWN_RESERVATION_PROVIDERS: Array<{ needle: string; provider: string; category: string }> = [
  { needle: "opentable", provider: "OpenTable", category: "restaurant" },
  { needle: "thefork", provider: "TheFork", category: "restaurant" },
  { needle: "resy", provider: "Resy", category: "restaurant" },
  { needle: "bookatable", provider: "Bookatable", category: "restaurant" },
  { needle: "cinema", provider: "Cinema", category: "cinema" },
  { needle: "movie ticket", provider: "Cinema", category: "cinema" },
  { needle: "vue", provider: "Vue", category: "cinema" },
  { needle: "pathe", provider: "Pathe", category: "cinema" },
  { needle: "cineworld", provider: "Cineworld", category: "cinema" },
  { needle: "kinepolis", provider: "Kinepolis", category: "cinema" },
  { needle: "spa", provider: "Spa", category: "spa" },
  { needle: "wellness", provider: "Wellness", category: "spa" },
  { needle: "swimming pool", provider: "Swimming pool", category: "swimming-pool" },
  { needle: "pool pass", provider: "Swimming pool", category: "swimming-pool" },
  { needle: "booking.com", provider: "Booking.com", category: "reservation" },
  { needle: "ticketmaster", provider: "Ticketmaster", category: "reservation" },
  { needle: "eventbrite", provider: "Eventbrite", category: "reservation" },
];

const KNOWN_PARKING_PROVIDERS: Array<{ needle: string; provider: string }> = [
  { needle: "q-park", provider: "Q-Park" },
  { needle: "qpark", provider: "Q-Park" },
  { needle: "parkbee", provider: "ParkBee" },
  { needle: "easypark", provider: "EasyPark" },
  { needle: "parkmobile", provider: "Parkmobile" },
  { needle: "yellowbrick", provider: "Yellowbrick" },
  { needle: "interparking", provider: "Interparking" },
  { needle: "apcoa", provider: "APCOA" },
];

function pickParkingProvider(text: string): string {
  const lower = text.toLowerCase();
  for (const provider of KNOWN_PARKING_PROVIDERS) {
    if (lower.includes(provider.needle)) return provider.provider;
  }
  return "";
}

function pickParkingLocation(text: string): string {
  const patterns = [
    /\b(?:parking|parkeer(?:garage)?)\s*(?:location|locatie|garage)?\s*[:\-]\s*([^\n\r,]{3,80})/i,
    /\b(?:parked at|parking at|geparkeerd bij|parkeerde bij)\s+([^\n\r,]{3,80})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ").slice(0, 120);
  }
  return "";
}

function pickAirline(text: string): string {
  const lower = text.toLowerCase();
  for (const airline of KNOWN_AIRLINES) {
    if (lower.includes(airline.needle)) return airline.name;
  }
  const m = text.match(/\b([A-Z][A-Za-z]+\s+(?:Airlines?|Airways?|Air))\b/);
  return m?.[1]?.trim() ?? "";
}

function pickFlightNumber(text: string): string {
  const patterns = [
    /\bflight\s*(?:no\.?|number)?\s*[:#-]?\s*([A-Z]{2}\s?\d{1,4})\b/i,
    /\b([A-Z]{2}\s?\d{2,4})\b/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].replace(/\s+/g, "").toUpperCase();
  }
  return "";
}

function pickBookingRef(text: string): string {
  const m = text.match(
    /\b(?:booking\s*(?:ref|reference)|reservation\s*code|confirmation\s*code|pnr)\s*[:#-]?\s*([A-Z0-9]{5,8})\b/i,
  );
  return m?.[1]?.toUpperCase() ?? "";
}

function pickRouteIata(text: string): { originIata: string; destinationIata: string } {
  const upper = text.toUpperCase();
  const patterns = [
    /\b([A-Z]{3})\s*(?:->|→|–|—|-|TO)\s*([A-Z]{3})\b/,
    /\bFROM\s+([A-Z]{3})\b[\s\S]{0,80}\bTO\s+([A-Z]{3})\b/,
    /\b([A-Z]{3})\s*\/\s*([A-Z]{3})\b/,
  ];
  for (const p of patterns) {
    const m = upper.match(p);
    if (m?.[1] && m[2] && m[1] !== m[2]) {
      return { originIata: m[1], destinationIata: m[2] };
    }
  }
  return { originIata: "", destinationIata: "" };
}

function pickPassenger(text: string): string {
  const m = text.match(/\b(?:passenger|traveller|traveler|name)\s*[:\-]\s*([^\n\r]{3,80})/i);
  return m?.[1]?.trim().slice(0, 80) ?? "";
}

function pickSeat(text: string): string {
  const m = text.match(/\bseat\s*[:#-]?\s*([0-9]{1,2}[A-Z])\b/i);
  return m?.[1]?.toUpperCase() ?? "";
}

function pickReservationRef(text: string): string {
  const m = text.match(
    /\b(?:reservation|booking|confirmation|ticket)\s*(?:ref(?:erence)?|number|no\.?|code|#)?\s*[:#-]?\s*([A-Z0-9-]{4,16})\b/i,
  );
  const token = m?.[1]?.toUpperCase() ?? "";
  if (token.length < 6 || token.length > 16) return "";
  if (!/[A-Z]/.test(token) || !/[0-9]/.test(token)) return "";
  return token;
}

function pickGuestCount(text: string): number {
  const patterns = [
    /\btable\s+for\s+([0-9]{1,2})\b/i,
    /\b([0-9]{1,2})\s*(?:guests|people|persons|tickets|seats)\b/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return Math.max(0, Math.round(toNum(m[1])));
  }
  return 0;
}

function pickReservationVenue(text: string): string {
  const patterns = [
    /\b(?:venue|restaurant|cinema|spa|pool)\s*[:\-]\s*([^\n\r]{3,80})/i,
    /\b(?:reservation|booking)\s+(?:at|for)\s+([^\n\r,]{3,80})/i,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m?.[1]) return m[1].trim().replace(/\s+/g, " ").slice(0, 120);
  }
  return "";
}

function classifyReservation(text: string): { provider: string; category: string } {
  const lower = text.toLowerCase();
  for (const known of KNOWN_RESERVATION_PROVIDERS) {
    if (lower.includes(known.needle)) {
      return { provider: known.provider, category: known.category };
    }
  }
  if (
    lower.includes("restaurant") ||
    lower.includes("table for") ||
    lower.includes("dinner reservation")
  ) {
    return { provider: "Restaurant", category: "restaurant" };
  }
  if (
    lower.includes("cinema") ||
    lower.includes("movie") ||
    lower.includes("screening")
  ) {
    return { provider: "Cinema", category: "cinema" };
  }
  if (lower.includes("spa") || lower.includes("wellness")) {
    return { provider: "Spa", category: "spa" };
  }
  if (
    lower.includes("swimming pool") ||
    lower.includes("pool entry") ||
    lower.includes("pool pass")
  ) {
    return { provider: "Swimming pool", category: "swimming-pool" };
  }
  return { provider: "Reservation", category: "reservation" };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function enabled(cfg: Record<string, unknown>, key: string, fallback = true): boolean {
  const v = cfg[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v === "boolean") return v;
  return String(v).toLowerCase() === "true";
}

function imapErrorMessage(err: unknown): string {
  const base = err instanceof Error ? err.message : String(err);
  if (!err || typeof err !== "object") return base;

  const raw = err as Record<string, unknown>;
  const extras = [raw.responseText, raw.serverResponse, raw.response, raw.code, raw.command]
    .map((v) => (typeof v === "string" ? v.trim() : ""))
    .filter(Boolean);

  const uniqueExtras = Array.from(new Set(extras)).filter((part) => !base.includes(part));
  const composed =
    uniqueExtras.length === 0 ? base : `${base} (${uniqueExtras.join(" | ")})`;
  if (/application-specific password required/i.test(composed)) {
    return "Gmail rejected IMAP login. Use a Google App Password (not your normal account password): https://support.google.com/accounts/answer/185833";
  }
  return composed;
}

function detectCandidates(
  text: string,
  messageId: string,
  date: Date,
  cfg: Record<string, unknown>,
): Candidate[] {
  const lower = text.toLowerCase();
  const amount = pickAmount(text);
  const day = isoDay(date);
  const startedAt = isoStamp(date);
  let distanceKm = pickDistanceKm(text);
  const durationMin = pickDurationMin(text);
  const merchant = pickMerchant(text);
  const hasCharge = amount.amount > 0.009;
  const out: Candidate[] = [];
  const hasAny = (needles: string[]) => needles.some((needle) => lower.includes(needle));

  const maybeRide = (provider: string, type: string, pickupLoc?: string, dropoffLoc?: string, calculatedDist?: number) =>
    out.push({
      kind: "mobility",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: calculatedDist ?? distanceKm,
      durationMin,
      type,
      merchant: "",
      pickupLocation: pickupLoc,
      dropoffLocation: dropoffLoc,
    });

  const maybePass = (provider: string, description: string) =>
    out.push({
      kind: "mobility_pass",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "pass",
      merchant: description,
    });

  const maybeFood = (provider: string) =>
    out.push({
      kind: "food",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "",
      merchant,
    });

  const maybeGroceries = (provider: string) => {
    const itemsMatch = text.match(/(\d+)\s*(?:item|artikel|product|artikel)/i);
    out.push({
      kind: "groceries",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "",
      merchant: provider,
      itemsCount: itemsMatch ? Math.round(toNum(itemsMatch[1])) : 0,
    });
  };

  const maybeParking = (provider: string, location: string) =>
    out.push({
      kind: "parking",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "parking",
      merchant: location || provider,
    });

  const maybeFlight = (
    airline: string,
    flightNumber: string,
    bookingRef: string,
    originIata: string,
    destinationIata: string,
    passenger: string,
    seat: string,
  ) => {
    out.push({
      kind: "flights",
      provider: airline || "Unknown airline",
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: "flight",
      merchant: "",
      flightNumber,
      bookingRef,
      originIata,
      destinationIata,
      passenger,
      seat,
    });
  };

  const maybeReservation = (
    provider: string,
    category: string,
    venue: string,
    reservationRef: string,
    guests: number,
  ) => {
    out.push({
      kind: "reservations",
      provider,
      messageId,
      day,
      startedAt,
      amount: amount.amount,
      currency: amount.currency,
      distanceKm: 0,
      durationMin: 0,
      type: category,
      merchant: venue || provider,
      reservationCategory: category,
      reservationRef,
      guests,
      venue,
    });
  };

  if (enabled(cfg, "scanFood", true) && hasCharge && (lower.includes("uber eats") || lower.includes("ubereats"))) {
    maybeFood("Uber Eats");
  }
  if (enabled(cfg, "scanFood", true) && hasCharge && (lower.includes("thuisbezorgd") || lower.includes("takeaway.com"))) {
    maybeFood("Thuisbezorgd");
  }
  if (enabled(cfg, "scanGroceries", true) && hasCharge && (lower.includes("albert heijn") || lower.includes("ah.nl"))) {
    maybeGroceries("Albert Heijn");
  }
  if (enabled(cfg, "scanGroceries", true) && hasCharge && lower.includes("jumbo")) {
    maybeGroceries("Jumbo");
  }
  if (enabled(cfg, "scanMobility", true) && hasCharge && lower.includes("lime")) {
    const hasPassSignal = hasAny(["limepass", "lime pass", "minute bundle", "subscription", "ride pass", "pass"]);
    const hasRideSignal = hasAny(["scooter", "bike", "ride", "trip", "journey", "unlock", "drop off", "pick up"]);
    if (hasPassSignal) {
      const passDescription = hasAny(["minute bundle"]) ? "LimePass – Minute bundle" : "LimePass";
      maybePass("Lime", passDescription);
    } else if (hasRideSignal) {
      const type = lower.includes("bike") ? "bike" : "scooter";
      maybeRide("Lime", type);
    }
  }
  if (enabled(cfg, "scanMobility", true) && hasCharge && lower.includes("bolt")) {
    const hasRideSignal = hasAny(["ride", "trip", "taxi", "driver", "scooter", "bike", "drop off", "pick up", "receipt"]);
    if (hasRideSignal) {
      const type = lower.includes("scooter") ? "scooter" : lower.includes("bike") ? "bike" : "taxi";
      maybeRide("Bolt", type);
    }
  }
  if (enabled(cfg, "scanMobility", true) && hasCharge && lower.includes("uber") && !lower.includes("uber eats") && !lower.includes("ubereats")) {
    const hasRideSignal = hasAny([
      "ride",
      "trip",
      "taxi",
      "driver",
      "drop off",
      "pick up",
      "uberx",
      "uber xl",
      "receipt",
      "scooter",
      "bike",
    ]);
    const type = lower.includes("scooter") ? "scooter" : lower.includes("bike") ? "bike" : "taxi";
    
    // For Uber taxi rides, try to extract distance from locations
    if (type === "taxi" && hasRideSignal) {
      const locations = pickUberLocations(text);
      if (locations.distanceKm > 0) {
        maybeRide("Uber", type, locations.pickup, locations.dropoff, locations.distanceKm);
      } else {
        maybeRide("Uber", type, locations.pickup, locations.dropoff);
      }
    } else if (hasRideSignal) {
      maybeRide("Uber", type);
    }
  }
  if (enabled(cfg, "scanFlights", true) && hasCharge) {
    const airline = pickAirline(text);
    const flightNumber = pickFlightNumber(text);
    const bookingRef = pickBookingRef(text);
    const route = pickRouteIata(text);
    const passenger = pickPassenger(text);
    const seat = pickSeat(text);

    const hasTravelKeywords =
      lower.includes("boarding pass") ||
      lower.includes("flight") ||
      lower.includes("itinerary") ||
      lower.includes("e-ticket") ||
      lower.includes("eticket") ||
      lower.includes("check-in") ||
      lower.includes("check in") ||
      lower.includes("terminal") ||
      lower.includes("gate");

    const hasStrongFlightSignal =
      !!flightNumber ||
      (route.originIata !== "" && route.destinationIata !== "") ||
      (!!airline && !!bookingRef);

    if (hasTravelKeywords && hasStrongFlightSignal) {
      maybeFlight(
        airline,
        flightNumber,
        bookingRef,
        route.originIata,
        route.destinationIata,
        passenger,
        seat,
      );
    }
  }
  const parkingProvider = pickParkingProvider(text);
  const parkingLocation = pickParkingLocation(text) || merchant;
  const hasParkingKeywords = hasAny([
    "parking",
    "parking fee",
    "parking receipt",
    "parking session",
    "car park",
    "parkeer",
    "parkeergarage",
    "parkeren",
  ]);
  const hasParkingPaymentSignal = hasAny([
    "receipt",
    "payment",
    "paid",
    "invoice",
    "factuur",
    "betaald",
    "ticket",
    "session",
    "entry",
    "exit",
  ]);
  const hasParkingSignal =
    parkingProvider !== "" || (hasParkingKeywords && hasParkingPaymentSignal);

  if (enabled(cfg, "scanParking", true) && hasCharge && hasParkingSignal) {
    maybeParking(parkingProvider || "Parking", parkingLocation);
  }

  if (enabled(cfg, "scanReservations", true) && hasCharge && !hasParkingSignal) {
    const reservationMeta = classifyReservation(text);
    const reservationRef = pickReservationRef(text);
    const reservationGuests = pickGuestCount(text);
    const reservationVenue = pickReservationVenue(text);

    const hasReservationKeywords =
      lower.includes("reservation") ||
      lower.includes("booking") ||
      lower.includes("booked") ||
      lower.includes("confirmation") ||
      lower.includes("ticket") ||
      lower.includes("table for") ||
      lower.includes("check-in") ||
      lower.includes("check in");

    const hasKnownReservationProvider = reservationMeta.provider !== "Reservation";
    const hasReservationSignal =
      reservationRef !== "" ||
      reservationGuests > 0 ||
      (hasKnownReservationProvider && (hasReservationKeywords || reservationVenue !== "")) ||
      (hasReservationKeywords && reservationVenue !== "");

    const looksLikeFlightOnly =
      lower.includes("boarding pass") ||
      lower.includes("flight") ||
      lower.includes("itinerary") ||
      lower.includes("gate") ||
      lower.includes("departure");

    if (hasReservationSignal && !looksLikeFlightOnly) {
      maybeReservation(
        reservationMeta.provider,
        reservationMeta.category,
        reservationVenue,
        reservationRef,
        reservationGuests,
      );
    }
  }
  return out;
}

async function existingDedupe(ctx: ConnectorContext, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set<string>();
  const seen = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const [seenRows, candidateRows] = await Promise.all([
      ctx.db.query<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM inbox_receipt_seen FINAL WHERE dedupe_key IN {keys:Array(String)}`,
        { keys: chunk },
      ),
      ctx.db.query<{ dedupe_key: string }>(
        `SELECT dedupe_key FROM inbox_receipt_candidate FINAL WHERE dedupe_key IN {keys:Array(String)}`,
        { keys: chunk },
      ),
    ]);
    for (const row of [...seenRows, ...candidateRows]) seen.add(String(row.dedupe_key));
  }
  return seen;
}

async function loadLearningSignals(
  ctx: ConnectorContext,
  candidates: Candidate[],
): Promise<{ exact: Map<string, LearningCounts>; provider: Map<string, LearningCounts> }> {
  const exact = new Map<string, LearningCounts>();
  const provider = new Map<string, LearningCounts>();
  if (candidates.length === 0) return { exact, provider };

  const kinds = Array.from(new Set(candidates.map((c) => c.kind)));
  const rows = await ctx.db.query<{
    kind: string;
    provider: string;
    type: string;
    merchant: string;
    amount: number;
    currency: string;
    status: string;
  }>(
    `SELECT
       kind,
       provider,
       type,
       merchant,
       amount,
       currency,
       status
     FROM inbox_receipt_candidate FINAL
     WHERE status IN ('approved', 'declined')
       AND kind IN {kinds:Array(String)}`,
    { kinds },
  );

  for (const row of rows) {
    const status = String(row.status ?? "");
    if (status !== "approved" && status !== "declined") continue;
    tallyLearning(
      exact,
      learningKeyFromParts(
        row.kind,
        row.provider,
        row.type,
        row.merchant,
        row.amount,
        row.currency,
      ),
      status,
    );
    tallyLearning(provider, learningProviderKey(row.kind, row.provider), status);
  }

  return { exact, provider };
}

function isSuppressedByLearning(
  candidate: Candidate,
  learning: { exact: Map<string, LearningCounts>; provider: Map<string, LearningCounts> },
): boolean {
  const exact = learning.exact.get(learningKey(candidate));
  if (exact && exact.declined >= 1 && exact.approved === 0) return true;
  if (exact && exact.declined >= exact.approved + 3 && exact.declined >= 4) return true;

  const provider = learning.provider.get(
    learningProviderKey(candidate.kind, candidate.provider),
  );
  if (provider && provider.declined >= 12 && provider.approved === 0) return true;
  if (provider && provider.declined >= provider.approved + 20) return true;
  return false;
}

const MOBILITY_SCAN_MODULE_ID = "mobility";
const FOOD_SCAN_MODULE_ID = "food";
const GROCERIES_SCAN_MODULE_ID = "groceries";
const FUEL_SCAN_MODULE_ID = "fuel";
const FLIGHTS_SCAN_MODULE_ID = "flights";
const RESERVATIONS_SCAN_MODULE_ID = "reservations";
const MOBILITY_SCAN_CONNECTOR_ID = "inbox-mobility";
const FOOD_SCAN_CONNECTOR_ID = "inbox-food";
const GROCERIES_SCAN_CONNECTOR_ID = "inbox-groceries";
const FUEL_SCAN_CONNECTOR_ID = "inbox-fuel";
const FLIGHTS_SCAN_CONNECTOR_ID = "inbox-flights";
const RESERVATIONS_SCAN_CONNECTOR_ID = "inbox-reservations";

async function loadConnectorConfig(
  ctx: ConnectorContext,
  moduleId: string,
  connectorId: string,
): Promise<Record<string, unknown>> {
  const rows = await ctx.db.query<{ config: string }>(
    `SELECT config FROM connector_state FINAL
     WHERE module_id = {moduleId:String} AND connector_id = {connectorId:String}
     LIMIT 1`,
    { moduleId, connectorId },
  );

  const raw = rows[0]?.config;
  if (typeof raw !== "string" || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch (err) {
    ctx.logger.warn(
      `inbox:${moduleId}/${connectorId} config is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
    return {};
  }
}

async function resolveScanConfig(ctx: ConnectorContext): Promise<Record<string, unknown>> {
  const [mobilityCfg, foodCfg, groceriesCfg, fuelCfg, flightsCfg, reservationsCfg] = await Promise.all([
    loadConnectorConfig(ctx, MOBILITY_SCAN_MODULE_ID, MOBILITY_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, FOOD_SCAN_MODULE_ID, FOOD_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, GROCERIES_SCAN_MODULE_ID, GROCERIES_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, FUEL_SCAN_MODULE_ID, FUEL_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, FLIGHTS_SCAN_MODULE_ID, FLIGHTS_SCAN_CONNECTOR_ID),
    loadConnectorConfig(ctx, RESERVATIONS_SCAN_MODULE_ID, RESERVATIONS_SCAN_CONNECTOR_ID),
  ]);

  return {
    ...ctx.config,
    ...mobilityCfg,
    ...foodCfg,
    ...groceriesCfg,
    ...fuelCfg,
    ...flightsCfg,
    ...reservationsCfg,
  };
}

export const INBOX_MAILBOX_BASE_CONNECTOR_ID = "mail-receipts";
const INBOX_MAILBOX_ID_PATTERN = /^mail-receipts-(\d+)$/;

function inboxMailboxSlotNumber(connectorId: string): number | null {
  if (connectorId === INBOX_MAILBOX_BASE_CONNECTOR_ID) return 1;
  const match = connectorId.match(INBOX_MAILBOX_ID_PATTERN);
  if (!match) return null;
  const slot = Math.floor(Number(match[1]));
  return Number.isFinite(slot) && slot >= 2 ? slot : null;
}

export function isInboxMailboxConnectorId(connectorId: string): boolean {
  return inboxMailboxSlotNumber(connectorId) !== null;
}

export function nextInboxMailboxConnectorId(existingIds: string[]): string {
  let maxSlot = 1;
  for (const id of existingIds) {
    const slot = inboxMailboxSlotNumber(id);
    if (slot !== null && slot > maxSlot) maxSlot = slot;
  }
  return `mail-receipts-${maxSlot + 1}`;
}

function inboxMailboxConnectorName(slot: number): string {
  return slot === 1 ? "Mailbox (advanced)" : `Mailbox ${slot} (advanced)`;
}

export function inboxMailboxConnector(connectorId: string): Connector | null {
  const slot = inboxMailboxSlotNumber(connectorId);
  if (slot === null) return null;
  return buildMailReceiptsConnector(connectorId, inboxMailboxConnectorName(slot));
}

function buildMailReceiptsConnector(id: string, name: string): Connector {
  return {
    id,
    name,
    description:
      "Connect an IMAP mailbox and stage detected receipt candidates for manual approval.",
    kind: "api",
    syncIntervalMinutes: 30,
    configSchema: [
      { key: "section_advanced", label: "IMAP Connection", type: "section" as const },
      { key: "imapHost", label: "IMAP host", type: "text", default: "imap.gmail.com" },
      { key: "imapPort", label: "IMAP port", type: "number", default: 993 },
      { key: "imapSecure", label: "Use TLS", type: "boolean", default: true },
      { key: "imapUser", label: "Mailbox username", type: "text" },
      {
        key: "imapMailbox",
        label: "Mailbox folder",
        type: "text",
        default: "INBOX",
        optional: true,
        help: "Folder to scan when 'Scan all folders' is off (default: INBOX).",
      },
      {
        key: "imapScanAllFolders",
        label: "Scan all folders",
        type: "boolean",
        default: false,
        optional: true,
        help: "Off by default to avoid scanning promotions/sent/archive folders.",
      },
      {
        key: "imapLookbackDays",
        label: "Look back days",
        type: "number",
        default: 30,
        optional: true,
        help: "Only scan messages from the last N days (0 = full mailbox history).",
      },
      {
        key: "imapPassword",
        label: "Mailbox password / app password",
        type: "password",
        secret: true,
        optional: true,
        help: "For Gmail, use a Google App Password (requires 2-Step Verification), not your normal account password.",
      },
    ],
    async sync(ctx) {
      const host = String(ctx.config.imapHost ?? "").trim();
      const port = Math.round(Number(ctx.config.imapPort ?? 993));
      const secure = enabled(ctx.config, "imapSecure", true);
      const user = String(ctx.config.imapUser ?? "").trim();
      const pass = String(ctx.config.imapPassword ?? "").trim();
      const preferredMailboxRaw = String(ctx.config.imapMailbox ?? "INBOX").trim();
      const preferredMailbox = preferredMailboxRaw || "INBOX";
      const scanAllFolders = enabled(ctx.config, "imapScanAllFolders", false);
      const lookbackDays = Math.max(0, Math.round(Number(ctx.config.imapLookbackDays ?? 30)));
      const scanCfg = await resolveScanConfig(ctx);

      if (!host || !user || !pass) throw new Error("Set IMAP host, username, and password/app password.");

      const client = new ImapFlow({
        host,
        port,
        secure,
        auth: { user, pass },
        logger: false,
      });

      const pendingRows: Record<string, unknown>[] = [];
      const seenRows: Record<string, unknown>[] = [];
      const queuedByKind: Record<ProviderKind, number> = {
        mobility: 0,
        mobility_pass: 0,
        food: 0,
        groceries: 0,
        parking: 0,
        flights: 0,
        reservations: 0,
      };
      const suppressedByLearning: Record<ProviderKind, number> = {
        mobility: 0,
        mobility_pass: 0,
        food: 0,
        groceries: 0,
        parking: 0,
        flights: 0,
        reservations: 0,
      };
      let totalSuppressedByLearning = 0;
      let scanned = 0;
      let scannedMailboxes = 0;
      let successfulMailboxes = 0;
      const folderErrors: string[] = [];

      try {
        await client.connect();
        const listed = await client.list();
        const allMailboxes = Array.from(
          new Set(
            listed
              .filter((box) => !Array.from(box.flags ?? []).some((flag) => flag.toLowerCase() === "\\noselect"))
              .map((box) => String(box.path ?? "").trim())
              .filter(Boolean),
          ),
        );

        const preferredMatched =
          allMailboxes.find((name) => name.toLowerCase() === preferredMailbox.toLowerCase()) ??
          preferredMailbox;
        const mailboxes =
          scanAllFolders && allMailboxes.length > 0
            ? allMailboxes
            : [preferredMatched];

        const searchCriteria =
          lookbackDays > 0
            ? { since: new Date(Date.now() - lookbackDays * 86_400_000) }
            : { all: true };

        for (const mailboxPath of mailboxes) {
          scannedMailboxes++;
          let lock: { release(): void } | null = null;
          try {
            lock = await client.getMailboxLock(mailboxPath);
            const found = await client.search(searchCriteria);
            const uids = Array.isArray(found) ? found : [];
            const parsedCandidates: Array<{ dedupeKey: string; data: Candidate; emailExcerpt: string }> = [];

            for await (const msg of client.fetch(uids, { uid: true, envelope: true, source: true })) {
              scanned++;
              const envelopeDate = msg.envelope?.date ?? new Date();
              const sourceBuffer =
                msg.source instanceof Readable
                  ? await streamToBuffer(msg.source)
                  : Buffer.isBuffer(msg.source)
                    ? msg.source
                    : Buffer.from([]);
              const parsed = await simpleParser(sourceBuffer);
              const body = [parsed.subject ?? "", parsed.text ?? "", parsed.html ? String(parsed.html) : ""].join("\n");
              const emailExcerpt = buildEmailExcerpt(parsed.subject ?? "", parsed.text ?? "");
              const messageId =
                normalizeMessageId(parsed.messageId ?? msg.envelope?.messageId) ||
                fallbackMessageId([mailboxPath, msg.uid, parsed.subject ?? "", parsed.text ?? "", envelopeDate.toISOString()]);
              const candidates = detectCandidates(body, messageId, parsed.date ?? envelopeDate, scanCfg);
              for (const c of candidates) {
                parsedCandidates.push({ dedupeKey: dedupeKey(c), data: c, emailExcerpt });
              }
            }

            const existing = await existingDedupe(ctx, parsedCandidates.map((x) => x.dedupeKey));
            const learning = await loadLearningSignals(
              ctx,
              parsedCandidates.map((x) => x.data),
            );
            for (const item of parsedCandidates) {
              if (existing.has(item.dedupeKey)) continue;
              existing.add(item.dedupeKey);
              const c = item.data;
              if (isSuppressedByLearning(c, learning)) {
                suppressedByLearning[c.kind] = (suppressedByLearning[c.kind] ?? 0) + 1;
                totalSuppressedByLearning += 1;
                seenRows.push(candidateToSeenRow(c, item.dedupeKey));
                continue;
              }
              pendingRows.push(candidateToPendingRow(c, item.dedupeKey, id, "mailbox", "", item.emailExcerpt));
              queuedByKind[c.kind] = (queuedByKind[c.kind] ?? 0) + 1;
              seenRows.push(candidateToSeenRow(c, item.dedupeKey));
            }
            successfulMailboxes++;
          } catch (err) {
            const detail = imapErrorMessage(err);
            folderErrors.push(`${mailboxPath}: ${detail}`);
            ctx.logger.warn(`inbox mailbox '${mailboxPath}' sync failed: ${detail}`);
          } finally {
            lock?.release();
          }
        }
      } catch (err) {
        throw new Error(imapErrorMessage(err));
      } finally {
        await client.logout().catch(() => undefined);
      }

      if (successfulMailboxes === 0 && folderErrors.length > 0) {
        throw new Error(
          `Mailbox sync failed for all folders. ${folderErrors.slice(0, 3).join("; ")}`,
        );
      }

      if (pendingRows.length > 0) await ctx.db.insert("inbox_receipt_candidate", pendingRows);
      if (seenRows.length > 0) await ctx.db.insert("inbox_receipt_seen", seenRows);

      return {
        inserted: pendingRows.length,
        message: `Scanned ${scanned} email(s) across ${scannedMailboxes} folder(s), queued ${pendingRows.length} pending receipts for review (${queuedByKind.mobility} mobility rides, ${queuedByKind.mobility_pass} mobility passes, ${queuedByKind.food} food, ${queuedByKind.groceries} grocery, ${queuedByKind.parking} parking, ${queuedByKind.flights} flights, ${queuedByKind.reservations} reservations).${totalSuppressedByLearning > 0 ? ` Auto-suppressed ${totalSuppressedByLearning} likely false positive(s) from prior declines (${suppressedByLearning.mobility} mobility rides, ${suppressedByLearning.mobility_pass} mobility passes, ${suppressedByLearning.food} food, ${suppressedByLearning.groceries} grocery, ${suppressedByLearning.parking} parking, ${suppressedByLearning.flights} flights, ${suppressedByLearning.reservations} reservations).` : ""}${folderErrors.length > 0 ? ` Skipped ${folderErrors.length} folder(s) due to errors.` : ""}`,
      };
    },
  };
}

const primaryMailboxConnector = inboxMailboxConnector(INBOX_MAILBOX_BASE_CONNECTOR_ID);
if (!primaryMailboxConnector) {
  throw new Error("Inbox mailbox base connector id is invalid.");
}
const mailReceiptsConnectors: Connector[] = [primaryMailboxConnector];

const inbox: LifeStackModule = {
  id: "inbox",
  name: "Inbox receipts",
  description:
    "Auto-scan mailbox receipts and route parsed entries into Mobility, Food, Groceries, Flights, and Reservations modules.",
  icon: "📧",
  accent: "oklch(0.73 0.13 255)",
  migrations: [
    `CREATE TABLE IF NOT EXISTS inbox_receipt_seen (
       day Date,
       dedupe_key String,
       provider String,
       kind String,
       message_id String,
       created_at DateTime
     ) ENGINE = ReplacingMergeTree ORDER BY (provider, dedupe_key)`,
    `CREATE TABLE IF NOT EXISTS inbox_receipt_candidate (
       id String,
       day Date,
       created_at DateTime64(3),
       updated_at DateTime64(3),
       dedupe_key String,
       status String DEFAULT 'pending',
       kind String,
       provider String,
       message_id String,
       email_excerpt String DEFAULT '',
       started_at DateTime64(3),
       type String,
       merchant String,
       amount Float64,
       currency String,
       amount_eur Float64,
       distance_km Float64,
       duration_min Int32,
       items_count UInt32 DEFAULT 0,
       pickup_location String DEFAULT '',
       dropoff_location String DEFAULT '',
       flight_number String DEFAULT '',
       booking_ref String DEFAULT '',
       origin_iata String DEFAULT '',
       destination_iata String DEFAULT '',
       passenger String DEFAULT '',
       seat String DEFAULT '',
       reservation_category String DEFAULT '',
       reservation_ref String DEFAULT '',
       guests Int32 DEFAULT 0,
       venue String DEFAULT '',
       source String DEFAULT 'mailbox',
       source_connector String DEFAULT '',
       review_note String DEFAULT ''
     ) ENGINE = ReplacingMergeTree(updated_at) ORDER BY (status, created_at, id)`,
    `ALTER TABLE inbox_receipt_candidate
      ADD COLUMN IF NOT EXISTS email_excerpt String DEFAULT ''`,
  ],
  connectors: mailReceiptsConnectors,
  widgets: [
    {
      id: "pending-review",
      title: "Pending review",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v
           FROM inbox_receipt_candidate FINAL
           WHERE status = 'pending'`,
        );
        return { value: rows[0]?.v ?? 0, unit: "receipts" };
      },
    },
    {
      id: "scanned-total",
      title: "Receipts processed",
      type: "metric",
      size: "sm",
      featured: true,
      async query(ctx) {
        const rows = await ctx.db.query<{ v: number }>(
          `SELECT toInt32(count()) AS v FROM inbox_receipt_seen FINAL`,
        );
        return { value: rows[0]?.v ?? 0, unit: "receipts" };
      },
    },
    {
      id: "providers",
      title: "Receipts by provider",
      type: "donut",
      size: "md",
      async query(ctx) {
        const rows = await ctx.db.query(
          `SELECT provider AS label, toInt32(count()) AS value
           FROM inbox_receipt_seen FINAL
           GROUP BY provider
           ORDER BY value DESC`,
        );
        return { slices: rows, unit: "receipts" };
      },
    },
  ],
};

export default inbox;

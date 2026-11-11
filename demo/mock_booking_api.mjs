// A tiny fake hospital booking API for demonstrating API actions (no dependencies).
//
//   node demo/mock_booking_api.mjs            (listens on http://127.0.0.1:8100)
//
// Cloudflare can only call public HTTPS addresses, so to try it with the deployed Worker, expose it
// with a tunnel (e.g. `cloudflared tunnel --url http://localhost:8100`) and use the https URL it
// prints as the client's API URL. With `wrangler dev` on this computer, http://127.0.0.1:8100 works
// in single-client (on-premise) mode. Authentication: header X-API-Key = demo-key (or MOCK_API_KEY),
// then add the "appointment booking" template. Data lives in memory and resets on restart.
import { randomInt, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const API_KEY = process.env.MOCK_API_KEY || "demo-key";
const PORT = Number(process.env.PORT || 8100);

const DEPARTMENTS = [
  { id: 1, name: "Cardiology" },
  { id: 2, name: "Orthopaedics" },
  { id: 3, name: "ENT" },
];
const DOCTORS = [
  { id: 1, name: "Dr. Anil Kumar", department_id: 1 },
  { id: 2, name: "Dr. Meera Nair", department_id: 1 },
  { id: 3, name: "Dr. Joseph Mathew", department_id: 2 },
  { id: 4, name: "Dr. Fathima Rahman", department_id: 3 },
];
const TIMES = ["09:00", "09:30", "10:00", "10:30", "11:00", "14:00", "14:30", "15:00"];
const APPOINTMENTS = new Map();

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
  }
}

function keyOk(header) {
  if (!header) return false;
  const a = Buffer.from(String(header));
  const b = Buffer.from(API_KEY);
  return a.length === b.length && timingSafeEqual(a, b);
}

function doctor(id) {
  const found = DOCTORS.find((d) => d.id === id);
  if (!found) throw new HttpError(404, `No doctor with id ${id}.`);
  return found;
}

function isoDate(value, field = "date") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value)) || Number.isNaN(Date.parse(value))) throw new HttpError(422, `${field}: Input should be a valid date`);
  return String(value);
}

function intParam(value, field) {
  if (value === undefined || value === null || !/^-?\d+$/.test(String(value))) throw new HttpError(422, `${field}: Input should be a valid integer`);
  return Number(value);
}

function free(doctorId, day) {
  const taken = new Set([...APPOINTMENTS.values()].filter((a) => a.doctor_id === doctorId && a.date === day).map((a) => a.time));
  // Doctors don't work on Sundays.
  return new Date(day + "T00:00:00Z").getUTCDay() === 0 ? [] : TIMES.filter((t) => !taken.has(t));
}

async function route(req, url, body) {
  const path = url.pathname;
  if (req.method === "GET" && path === "/health") return [200, { status: "ok" }];
  if (!keyOk(req.headers["x-api-key"])) throw new HttpError(401, "Missing or wrong X-API-Key.");
  if (req.method === "GET" && path === "/departments") return [200, DEPARTMENTS];
  if (req.method === "GET" && path === "/doctors") {
    const dep = url.searchParams.get("department_id");
    const id = dep === null ? null : intParam(dep, "department_id");
    return [200, DOCTORS.filter((d) => id === null || d.department_id === id)];
  }
  if (req.method === "GET" && path === "/slots") {
    const id = intParam(url.searchParams.get("doctor_id"), "doctor_id");
    const day = isoDate(url.searchParams.get("date"));
    return [200, { doctor: doctor(id).name, date: day, free: free(id, day) }];
  }
  if (req.method === "POST" && path === "/appointments") {
    const b = body || {};
    const id = intParam(b.doctor_id, "doctor_id");
    const day = isoDate(b.date);
    if (!/^\d{2}:\d{2}$/.test(String(b.time ?? ""))) throw new HttpError(422, "time: String should match pattern '^\\d{2}:\\d{2}$'");
    if (!b.patient_name || String(b.patient_name).length > 200) throw new HttpError(422, "patient_name: Field required");
    if (!/^\+?\d{6,15}$/.test(String(b.phone ?? ""))) throw new HttpError(422, "phone: String should match pattern '^\\+?\\d{6,15}$'");
    const doc = doctor(id);
    if (!free(id, day).includes(b.time)) throw new HttpError(409, `${b.time} on ${day} is not free for ${doc.name}.`);
    const bookingId = `BK-${randomInt(100000, 1000000)}`;
    APPOINTMENTS.set(bookingId, { doctor_id: id, date: day, time: b.time, patient_name: b.patient_name });
    return [201, { booking_id: bookingId, doctor: doc.name, date: day, time: b.time, patient_name: b.patient_name }];
  }
  const cancel = /^\/appointments\/([^/]+)$/.exec(path);
  if (req.method === "DELETE" && cancel) {
    const id = decodeURIComponent(cancel[1]);
    if (!APPOINTMENTS.delete(id)) throw new HttpError(404, `No appointment ${id}.`);
    return [200, { cancelled: id }];
  }
  throw new HttpError(404, "Not Found");
}

createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let status;
  let data;
  try {
    let body = null;
    if (raw) {
      try {
        body = JSON.parse(raw);
      } catch {
        throw new HttpError(422, "Invalid JSON body.");
      }
    }
    [status, data] = await route(req, new URL(req.url, `http://${req.headers.host}`), body);
  } catch (exc) {
    status = exc instanceof HttpError ? exc.status : 500;
    data = { detail: exc instanceof HttpError ? exc.message : "Internal Server Error" };
  }
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}).listen(PORT, "0.0.0.0", () => console.log(`Mock booking API on http://127.0.0.1:${PORT} (X-API-Key: ${API_KEY})`));

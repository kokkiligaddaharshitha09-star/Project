require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const mysql = require("mysql2/promise");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || "http://localhost:5173", methods: ["GET", "POST", "PATCH", "DELETE"] }
});
app.use(cors({ origin: process.env.CLIENT_URL || "http://localhost:5173" }));
app.use(express.json({ limit: "20kb" }));

const SECRET = process.env.JWT_SECRET;
if (!SECRET || SECRET.length < 24) {
  console.error("Set JWT_SECRET in backend/.env (at least 24 characters).");
  process.exit(1);
}

let db;
const VEHICLES = ["Car", "Bike", "Auto", "Truck"];
const ISSUES = ["tyre", "battery", "towing", "fuel", "engine", "emergency"];
const BASE_FARE = { tyre: 200, battery: 300, fuel: 150, engine: 400, towing: 600, emergency: 500 };
const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

io.on("connection", (socket) => {
  socket.on("authenticate", (token) => {
    try {
      const user = jwt.verify(token, SECRET);
      socket.join(`user:${user.id}`);
      if (user.role === "mechanic") socket.join("mechanics");
      if (user.role === "admin") socket.join("admins");
    } catch { socket.disconnect(true); }
  });
});
const notifyMechanics = (message, payload = {}) => io.to("mechanics").emit("notification", { message, ...payload });
const notifyUser = (id, message, payload = {}) => io.to(`user:${id}`).emit("notification", { message, ...payload });
const refresh = () => io.emit("refresh");

function auth(role) {
  return (req, res, next) => {
    try {
      const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
      req.user = jwt.verify(token, SECRET);
      if (role && req.user.role !== role) return res.status(403).json({ error: "Not allowed for your role" });
      next();
    } catch {
      return res.status(401).json({ error: "Please log in again" });
    }
  };
}
function publicUser(row) {
  return { id: row.id, name: row.name, phone: row.phone, email: row.email, role: row.role,
    services: row.services || "", lng: row.lng, lat: row.lat, available: !!row.available };
}
function distanceSql(alias) {
  return `(6371 * ACOS(LEAST(1, COS(RADIANS(?)) * COS(RADIANS(${alias}.lat)) *
    COS(RADIANS(${alias}.lng) - RADIANS(?)) + SIN(RADIANS(?)) * SIN(RADIANS(${alias}.lat)))))`;
}
function estimate(issue, km) {
  return Math.round((BASE_FARE[issue] || 200) + km * 10);
}
const validCoordinates = (lat, lng) => Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))
  && Math.abs(Number(lat)) <= 90 && Math.abs(Number(lng)) <= 180;

app.get("/api/health", (req, res) => res.json({ status: "ok", app: "RoadAid" }));

app.post("/api/register", asyncRoute(async (req, res) => {
  const { name, phone, email, password, role, services = [], lat = 16.5, lng = 80.64 } = req.body;
  if (!name?.trim() || !/^\d{10}$/.test(phone || "") || !/^\S+@\S+\.\S+$/.test(email || "")
      || (password || "").length < 8 || !["driver", "mechanic"].includes(role)) {
    return res.status(400).json({ error: "Enter a name, 10-digit phone, valid email and password (8+ characters)." });
  }
  if (!validCoordinates(lat, lng)) return res.status(400).json({ error: "Invalid location coordinates." });
  const serviceList = Array.isArray(services) ? services.filter(s => ISSUES.includes(s) && s !== "emergency") : [];
  if (role === "mechanic" && serviceList.length === 0) return res.status(400).json({ error: "Select at least one service." });
  const hash = await bcrypt.hash(password, 10);
  const [result] = await db.execute(
    "INSERT INTO users(name,phone,email,password,role,services,lng,lat,available) VALUES(?,?,?,?,?,?,?,?,?)",
    [name.trim(), phone, email.toLowerCase(), hash, role, serviceList.join(","), Number(lng), Number(lat), role === "mechanic" ? 1 : 0]
  );
  const user = { id: result.insertId, name: name.trim(), role };
  const token = jwt.sign(user, SECRET, { expiresIn: "2d" });
  res.status(201).json({ token, user });
}));

app.post("/api/login", asyncRoute(async (req, res) => {
  const email = String(req.body.email || "").toLowerCase();
  const [rows] = await db.execute("SELECT * FROM users WHERE email=?", [email]);
  const user = rows[0];
  if (!user || !(await bcrypt.compare(req.body.password || "", user.password))) {
    return res.status(400).json({ error: "Wrong email or password." });
  }
  const safeUser = { id: user.id, name: user.name, role: user.role };
  res.json({ token: jwt.sign(safeUser, SECRET, { expiresIn: "2d" }), user: safeUser });
});

app.get("/api/me", auth(), asyncRoute(async (req, res) => {
  const [rows] = await db.execute("SELECT * FROM users WHERE id=?", [req.user.id]);
  if (!rows[0]) return res.status(404).json({ error: "User not found." });
  res.json(publicUser(rows[0]));
}));

app.get("/api/mechanics", auth("driver"), asyncRoute(async (req, res) => {
  const { lat, lng, service, km = 20 } = req.query;
  if (!validCoordinates(lat, lng)) return res.status(400).json({ error: "Valid latitude and longitude are required." });
  const radius = Math.min(Math.max(Number(km) || 20, 1), 100);
  const filter = service && service !== "emergency" && ISSUES.includes(service);
  const sql = `SELECT u.id,u.name,u.phone,u.services,u.lat,u.lng,
      ${distanceSql("u")} AS distance_km,
      (SELECT ROUND(AVG(r.rating),1) FROM requests r WHERE r.mechanic_id=u.id AND r.rating IS NOT NULL) AS rating
    FROM users u WHERE u.role='mechanic' AND u.available=1
    ${filter ? "AND FIND_IN_SET(?,u.services)" : ""}
    HAVING distance_km<=? ORDER BY distance_km LIMIT 30`;
  const params = [Number(lat), Number(lng), Number(lat), ...(filter ? [service] : []), radius];
  const [rows] = await db.execute(sql, params);
  res.json(rows);
}));

app.post("/api/requests", auth("driver"), asyncRoute(async (req, res) => {
  const { vehicle, issue, notes = "", lat, lng } = req.body;
  if (!VEHICLES.includes(vehicle) || !ISSUES.includes(issue) || !validCoordinates(lat, lng)) {
    return res.status(400).json({ error: "Invalid vehicle, issue or location." });
  }
  const [result] = await db.execute(
    "INSERT INTO requests(driver_id,vehicle,issue,notes,lat,lng) VALUES(?,?,?,?,?,?)",
    [req.user.id, vehicle, issue, String(notes).slice(0, 250), Number(lat), Number(lng)]
  );
  const requestId = result.insertId;
  notifyMechanics(issue === "emergency" ? "SOS: a driver needs urgent help." : `New ${issue} request (${vehicle}).`, { requestId });
  refresh();
  res.status(201).json({ id: requestId, status: "open" });
}));

app.get("/api/requests/mine", auth("driver"), asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT r.*, m.name AS mechanic_name, m.phone AS mechanic_phone
     FROM requests r LEFT JOIN users m ON m.id=r.mechanic_id
     WHERE r.driver_id=? ORDER BY r.created_at DESC`, [req.user.id]);
  res.json(rows);
}));

app.patch("/api/requests/:id/rate", auth("driver"), asyncRoute(async (req, res) => {
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: "Rating must be 1 to 5." });
  const [result] = await db.execute(
    "UPDATE requests SET rating=? WHERE id=? AND driver_id=? AND status='completed' AND rating IS NULL",
    [rating, req.params.id, req.user.id]);
  if (!result.affectedRows) return res.status(400).json({ error: "This request cannot be rated." });
  refresh();
  res.json({ ok: true });
}));

app.get("/api/requests/nearby", auth("mechanic"), asyncRoute(async (req, res) => {
  const { lat, lng, km = 25 } = req.query;
  if (!validCoordinates(lat, lng)) return res.status(400).json({ error: "Valid latitude and longitude are required." });
  const radius = Math.min(Math.max(Number(km) || 25, 1), 100);
  const [rows] = await db.execute(
    `SELECT r.*, d.name AS driver_name, d.phone AS driver_phone,
      ${distanceSql("r")} AS distance_km
     FROM requests r JOIN users d ON d.id=r.driver_id
     WHERE r.status='open' HAVING distance_km<=?
     ORDER BY (r.issue='emergency') DESC, distance_km ASC`,
    [Number(lat), Number(lng), Number(lat), radius]);
  res.json(rows);
}));

app.get("/api/requests/jobs", auth("mechanic"), asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT r.*, d.name AS driver_name, d.phone AS driver_phone
     FROM requests r JOIN users d ON d.id=r.driver_id
     WHERE r.mechanic_id=? ORDER BY r.created_at DESC`, [req.user.id]);
  res.json(rows);
}));

app.patch("/api/requests/:id/accept", auth("mechanic"), asyncRoute(async (req, res) => {
  const [[request]] = await db.execute("SELECT * FROM requests WHERE id=? AND status='open'", [req.params.id]);
  if (!request) return res.status(409).json({ error: "Request already taken." });
  const [[mechanic]] = await db.execute("SELECT lat,lng FROM users WHERE id=?", [req.user.id]);
  const km = 6371 * Math.acos(Math.min(1,
    Math.cos(mechanic.lat * Math.PI / 180) * Math.cos(request.lat * Math.PI / 180) *
    Math.cos((request.lng - mechanic.lng) * Math.PI / 180) +
    Math.sin(mechanic.lat * Math.PI / 180) * Math.sin(request.lat * Math.PI / 180)));
  const fare = estimate(request.issue, km);
  const [result] = await db.execute(
    "UPDATE requests SET status='accepted', mechanic_id=?, fare=? WHERE id=? AND status='open'",
    [req.user.id, fare, req.params.id]);
  if (!result.affectedRows) return res.status(409).json({ error: "Another mechanic accepted this request." });
  notifyUser(request.driver_id, `${req.user.name} accepted your request. Estimated fare: ₹${fare}.`, { requestId: Number(req.params.id) });
  refresh();
  res.json({ ok: true, fare });
}));

app.patch("/api/requests/:id/complete", auth("mechanic"), asyncRoute(async (req, res) => {
  const [result] = await db.execute(
    "UPDATE requests SET status='completed' WHERE id=? AND mechanic_id=? AND status='accepted'",
    [req.params.id, req.user.id]);
  if (!result.affectedRows) return res.status(404).json({ error: "Active job not found." });
  const [[row]] = await db.execute("SELECT driver_id FROM requests WHERE id=?", [req.params.id]);
  notifyUser(row.driver_id, "Your roadside service is completed. Please rate the mechanic.");
  refresh();
  res.json({ ok: true });
}));

app.patch("/api/mechanic/status", auth("mechanic"), asyncRoute(async (req, res) => {
  await db.execute("UPDATE users SET available=? WHERE id=?", [req.body.available ? 1 : 0, req.user.id]);
  res.json({ ok: true });
}));

app.get("/api/admin/stats", auth("admin"), asyncRoute(async (req, res) => {
  const [[users]] = await db.execute("SELECT COUNT(*) totalUsers, SUM(role='driver') drivers, SUM(role='mechanic') mechanics FROM users");
  const [[jobs]] = await db.execute("SELECT COUNT(*) totalRequests, SUM(status='open') openRequests, SUM(status='accepted') accepted, SUM(status='completed') completed, ROUND(AVG(rating),1) avgRating, COALESCE(SUM(CASE WHEN status='completed' THEN fare ELSE 0 END),0) revenue FROM requests");
  res.json({ ...users, ...jobs });
}));
app.get("/api/admin/users", auth("admin"), asyncRoute(async (req, res) => {
  const [rows] = await db.execute("SELECT id,name,email,phone,role,available FROM users ORDER BY id DESC LIMIT 200");
  res.json(rows);
}));
app.get("/api/admin/requests", auth("admin"), asyncRoute(async (req, res) => {
  const [rows] = await db.execute(
    `SELECT r.*, d.name AS driver_name, m.name AS mechanic_name
     FROM requests r JOIN users d ON d.id=r.driver_id
     LEFT JOIN users m ON m.id=r.mechanic_id ORDER BY r.created_at DESC LIMIT 200`);
  res.json(rows);
}));
app.delete("/api/admin/users/:id", auth("admin"), asyncRoute(async (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: "You cannot delete your own admin account." });
  await db.execute("DELETE FROM users WHERE id=? AND role<>'admin'", [req.params.id]);
  refresh();
  res.json({ ok: true });
}));

app.use((err, req, res, next) => {
  console.error(err);
  if (err.code === "ER_DUP_ENTRY") return res.status(409).json({ error: "Email already registered." });
  res.status(500).json({ error: "Server error. Check backend terminal and database configuration." });
});

async function start() {
  const config = { host: process.env.DB_HOST || "localhost", user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "", waitForConnections: true, connectionLimit: 10 };
  const connection = await mysql.createConnection(config);
  await connection.query("CREATE DATABASE IF NOT EXISTS breakdown");
  await connection.end();
  db = mysql.createPool({ ...config, database: "breakdown", decimalNumbers: true });
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(100) NOT NULL, phone VARCHAR(20) NOT NULL,
    email VARCHAR(150) NOT NULL UNIQUE, password VARCHAR(100) NOT NULL,
    role ENUM('driver','mechanic','admin') NOT NULL, services VARCHAR(200) DEFAULT '',
    lng DOUBLE NOT NULL DEFAULT 80.64, lat DOUBLE NOT NULL DEFAULT 16.50,
    available TINYINT(1) NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);
  await db.query(`CREATE TABLE IF NOT EXISTS requests (
    id INT AUTO_INCREMENT PRIMARY KEY, driver_id INT NOT NULL,
    mechanic_id INT NULL, vehicle VARCHAR(30) NOT NULL, issue VARCHAR(30) NOT NULL,
    notes VARCHAR(255) DEFAULT '', lng DOUBLE NOT NULL, lat DOUBLE NOT NULL,
    status ENUM('open','accepted','completed') NOT NULL DEFAULT 'open',
    rating TINYINT NULL, fare INT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_request_status(status), CONSTRAINT fk_driver FOREIGN KEY(driver_id) REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_mechanic FOREIGN KEY(mechanic_id) REFERENCES users(id) ON DELETE SET NULL
  )`);
  const port = Number(process.env.PORT || 5000);
  server.listen(port, () => console.log(`RoadAid API + Socket.IO running on http://localhost:${port}`));
}
start().catch(err => { console.error("Startup failed:", err.message); process.exit(1); });

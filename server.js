require("dotenv").config();
const express = require("express");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const cors = require("cors");
const rateLimit = require("express-rate-limit");
const { clerkMiddleware, requireAuth, getAuth } = require("@clerk/express");
const Database = require("better-sqlite3");

console.log("STARTING ARX CLOUD LITE SERVER...");

const app = express();
app.set("trust proxy", 1);
const PORT = 3001;
const STORAGE_PATH = "/mnt/arx_primary";
const USERS_DB = path.join(__dirname, "users.json");
const DB_PATH = path.join(__dirname, "search.db");

// ─── SQLITE SEARCH INDEX ─────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL,
    size INTEGER,
    modified TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_name ON files(name);
`);

function indexPath(filePath) {
  try {
    const stats = fs.statSync(filePath);
    const relative = filePath.replace(STORAGE_PATH, "").replace(/^\//, "");
    const name = path.basename(filePath);
    const type = stats.isDirectory() ? "folder" : "file";
    db.prepare(`INSERT OR REPLACE INTO files (name, path, type, size, modified) VALUES (?, ?, ?, ?, ?)`)
      .run(name, relative, type, stats.size, stats.mtime.toISOString());
  } catch {}
}

function indexDirectory(dirPath) {
  try {
    const items = fs.readdirSync(dirPath);
    for (const item of items) {
      const full = path.join(dirPath, item);
      indexPath(full);
      try { if (fs.statSync(full).isDirectory()) indexDirectory(full); } catch {}
    }
  } catch {}
}

function removeFromIndex(relativePath) {
  db.prepare(`DELETE FROM files WHERE path = ? OR path LIKE ?`).run(relativePath, relativePath + "/%");
}

// Initial index on startup
console.log("Indexing files...");
indexDirectory(STORAGE_PATH);
console.log(`Indexed ${db.prepare("SELECT COUNT(*) as c FROM files").get().c} files`);

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ADMIN_ID = "user_3D0U3FxwiCjscuaQcjMMgZvZkE2";
const FAMILIA_CAP = 8 * 1024 * 1024 * 1024;
const USER_QUOTA  = 12 * 1024 * 1024 * 1024;

// ─── USERS DB ─────────────────────────────────────────────────────────────────
function loadUsers() {
  if (!fs.existsSync(USERS_DB)) fs.writeFileSync(USERS_DB, JSON.stringify({}, null, 2));
  return JSON.parse(fs.readFileSync(USERS_DB, "utf8"));
}
function saveUsers(data) { fs.writeFileSync(USERS_DB, JSON.stringify(data, null, 2)); }
function sanitizeName(name) { return name.trim().replace(/[^a-zA-Z0-9 _-]/g, "").replace(/\s+/g, "_") || "User"; }
function getUniqueFolderName(baseName, db) {
  const existing = Object.values(db).map(u => u.folderName.toLowerCase());
  if (!existing.includes(baseName.toLowerCase())) return baseName;
  let i = 2;
  while (existing.includes(`${baseName}_${i}`.toLowerCase())) i++;
  return `${baseName}_${i}`;
}
function ensureUserFolder(userId, fullName) {
  const users = loadUsers();
  if (users[userId]) {
    const userDir = path.join(STORAGE_PATH, "users", users[userId].folderName);
    if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
    return users[userId];
  }
  const baseName = sanitizeName(fullName || "User");
  const folderName = getUniqueFolderName(baseName, users);
  const userDir = path.join(STORAGE_PATH, "users", folderName);
  fs.mkdirSync(userDir, { recursive: true });
  users[userId] = { folderName, displayName: fullName || folderName, quota: userId === ADMIN_ID ? null : USER_QUOTA, isAdmin: userId === ADMIN_ID, createdAt: new Date().toISOString() };
  saveUsers(users);
  console.log(`New user: ${fullName} → users/${folderName}`);
  return users[userId];
}
function getUserRecord(userId) { return loadUsers()[userId] || null; }
function getUserFolder(userId) {
  const r = getUserRecord(userId);
  return r ? path.join(STORAGE_PATH, "users", r.folderName) : null;
}

// ─── PERMISSIONS ──────────────────────────────────────────────────────────────
function isAdmin(userId) { return userId === ADMIN_ID; }
function getFolderType(p) {
  const norm = p.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!norm) return "root";
  const top = norm.split("/")[0].toLowerCase();
  if (top === "palladium") return "palladium";
  if (top === "familia") return "familia";
  if (top === "users") return "users";
  return "admin";
}
function isOwnUserFolder(userId, relativePath) {
  const r = getUserRecord(userId);
  if (!r) return false;
  const parts = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").split("/");
  return parts.length >= 2 && parts[0].toLowerCase() === "users" && parts[1] === r.folderName;
}
function canRead(userId, p) {
  if (isAdmin(userId)) return true;
  const record = getUserRecord(userId);
  if (!record) return false;
  const t = getFolderType(p);
  return t === "palladium" || t === "familia" || t === "users" || t === "root";
}
function canUpload(userId, p) {
  if (isAdmin(userId)) return true;
  const t = getFolderType(p);
  if (t === "familia") return true;
  if (t === "users") return isOwnUserFolder(userId, p);
  return false;
}
function canDelete(userId, p) {
  if (isAdmin(userId)) return true;
  return getFolderType(p) === "users" && isOwnUserFolder(userId, p);
}
function canCreateFolder(userId, p) {
  if (isAdmin(userId)) return true;
  return getFolderType(p) === "users" && isOwnUserFolder(userId, p);
}

// ─── QUOTA ────────────────────────────────────────────────────────────────────
function getFolderSize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const item of fs.readdirSync(dirPath)) {
    const full = path.join(dirPath, item);
    const s = fs.statSync(full);
    total += s.isDirectory() ? getFolderSize(full) : s.size;
  }
  return total;
}

// ─── MIDDLEWARE ───────────────────────────────────────────────────────────────
app.use(rateLimit({ windowMs: 15 * 60 * 1000, max: 100, standardHeaders: true, legacyHeaders: false }));
app.use(cors());
app.use(express.json());
app.use(clerkMiddleware());
app.use(express.static(path.join(__dirname, "public")));

// ─── SECURITY ─────────────────────────────────────────────────────────────────
function safePath(userPath = "") {
  const resolved = path.normalize(path.join(STORAGE_PATH, userPath));
  if (!resolved.startsWith(STORAGE_PATH)) throw new Error("Invalid path: access denied");
  return resolved;
}

// ─── MULTER ───────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const p = safePath(req.query.path || "");
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    cb(null, p);
  },
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({ storage });

// ─── AUTH ─────────────────────────────────────────────────────────────────────
app.post("/auth/register", requireAuth(), async (req, res) => {
  const { userId } = getAuth(req);
  const { fullName } = req.body;
  try {
    const record = ensureUserFolder(userId, fullName || "User");
    res.json({ valid: true, userId, isAdmin: isAdmin(userId), folderName: record.folderName, displayName: record.displayName, quota: record.quota });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get("/auth/verify", (req, res) => {
  const { userId } = getAuth(req);
  if (!userId) return res.status(401).json({ valid: false });
  res.json({ valid: true, userId, isAdmin: isAdmin(userId), record: getUserRecord(userId) });
});

// ─── FILES ────────────────────────────────────────────────────────────────────
app.get("/files", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.query.path || "";
  if (!canRead(userId, relativePath)) return res.status(403).json({ error: "Access denied" });
  try {
    const dirPath = safePath(relativePath);
    if (!fs.existsSync(dirPath)) return res.status(404).json({ error: "Not found" });
    let files = fs.readdirSync(dirPath).map(file => {
      const full = path.join(dirPath, file);
      const s = fs.statSync(full);
      return { name: file, type: s.isDirectory() ? "folder" : "file", size: s.size, modified: s.mtime };
    });
    if (relativePath === "" && !isAdmin(userId)) {
      files = files.filter(f => ["palladium","familia","users"].includes(f.name.toLowerCase()));
    }
    if (getFolderType(relativePath) === "users" && !isAdmin(userId)) {
      const r = getUserRecord(userId);
      files = files.filter(f => r && f.name === r.folderName);
    }
    files.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "folder" ? -1 : 1);
    res.json(files);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/upload", requireAuth(), upload.single("file"), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.query.path || "";
  if (!canUpload(userId, relativePath)) {
    if (req.file) fs.unlinkSync(req.file.path);
    return res.status(403).json({ error: "Upload not allowed here" });
  }
  if (!req.file) return res.status(400).json({ error: "No file provided" });
  if (getFolderType(relativePath) === "familia" && getFolderSize(path.join(STORAGE_PATH, "Familia")) > FAMILIA_CAP) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: "Familia storage limit reached (8GB)" });
  }
  if (getFolderType(relativePath) === "users" && !isAdmin(userId)) {
    const userDir = getUserFolder(userId);
    if (userDir && getFolderSize(userDir) > USER_QUOTA) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ error: "Personal storage limit reached (12GB)" });
    }
  }
  indexPath(req.file.path);
  res.json({ message: "Uploaded", filename: req.file.originalname });
});

app.get("/download", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.query.path || "";
  if (!canRead(userId, relativePath)) return res.status(403).json({ error: "Access denied" });
  try {
    const filePath = safePath(relativePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
    res.download(filePath);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// Stream endpoint for media player (supports range requests)
app.get("/stream", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.query.path || "";
  if (!canRead(userId, relativePath)) return res.status(403).json({ error: "Access denied" });
  try {
    const filePath = safePath(relativePath);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: "Not found" });
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const range = req.headers.range;
    const ext = path.extname(filePath).toLowerCase();
    const mimeTypes = { ".mp3":"audio/mpeg", ".mp4":"video/mp4", ".mkv":"video/x-matroska", ".webm":"video/webm", ".ogg":"audio/ogg", ".wav":"audio/wav", ".m4a":"audio/mp4" };
    const contentType = mimeTypes[ext] || "application/octet-stream";
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
      const chunkSize = end - start + 1;
      res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${fileSize}`, "Accept-Ranges": "bytes", "Content-Length": chunkSize, "Content-Type": contentType });
      fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
      res.writeHead(200, { "Content-Length": fileSize, "Content-Type": contentType, "Accept-Ranges": "bytes" });
      fs.createReadStream(filePath).pipe(res);
    }
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/folder", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.body.path || "";
  if (!canCreateFolder(userId, relativePath)) return res.status(403).json({ error: "Cannot create folders here" });
  try {
    const dirPath = safePath(relativePath);
    fs.mkdirSync(dirPath, { recursive: true });
    indexPath(dirPath);
    res.json({ message: "Folder created" });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.delete("/file", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.body.path || "";
  if (!canDelete(userId, relativePath)) return res.status(403).json({ error: "Delete not allowed here" });
  try {
    const filePath = safePath(relativePath);
    const s = fs.statSync(filePath);
    if (s.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
    removeFromIndex(relativePath);
    res.json({ message: "Deleted" });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/rename", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const oldRelative = req.body.oldPath || "";
  if (!canDelete(userId, oldRelative)) return res.status(403).json({ error: "Rename not allowed here" });
  try {
    const oldPath = safePath(oldRelative);
    const newPath = safePath(req.body.newPath || "");
    fs.renameSync(oldPath, newPath);
    removeFromIndex(oldRelative);
    indexPath(newPath);
    res.json({ message: "Renamed" });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── FILE READ/WRITE FOR EDITOR ───────────────────────────────────────────────
app.get("/file/read", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.query.path || "";
  if (!canRead(userId, relativePath)) return res.status(403).json({ error: "Access denied" });
  try {
    const filePath = safePath(relativePath);
    const content = fs.readFileSync(filePath, "utf8");
    res.json({ content });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

app.post("/file/write", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const relativePath = req.body.path || "";
  if (!canUpload(userId, relativePath)) return res.status(403).json({ error: "Write not allowed here" });
  try {
    const filePath = safePath(relativePath);
    fs.writeFileSync(filePath, req.body.content || "", "utf8");
    indexPath(filePath);
    res.json({ message: "Saved" });
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── SEARCH ───────────────────────────────────────────────────────────────────
app.get("/search", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const q = req.query.q || "";
  if (!q.trim()) return res.json([]);
  try {
    let results = db.prepare(`SELECT * FROM files WHERE name LIKE ? LIMIT 50`).all(`%${q}%`);
    if (!isAdmin(userId)) {
      results = results.filter(r => {
        const top = r.path.split("/")[0].toLowerCase();
        return top === "palladium" || top === "familia" || top === "users";
      });
    }
    res.json(results);
  } catch (err) { res.status(400).json({ error: err.message }); }
});

// ─── QUOTA ────────────────────────────────────────────────────────────────────
app.get("/quota", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  const userDir = getUserFolder(userId);
  res.json({
    personal: { used: userDir ? getFolderSize(userDir) : 0, total: isAdmin(userId) ? null : USER_QUOTA },
    familia: { used: getFolderSize(path.join(STORAGE_PATH, "Familia")), total: FAMILIA_CAP }
  });
});

app.get("/admin/users", requireAuth(), (req, res) => {
  const { userId } = getAuth(req);
  if (!isAdmin(userId)) return res.status(403).json({ error: "Admin only" });
  const users = loadUsers();
  res.json(Object.entries(users).map(([id, r]) => ({ id, ...r, storageUsed: getFolderSize(path.join(STORAGE_PATH, "users", r.folderName)) })));
});

// ─── BASE FOLDERS ─────────────────────────────────────────────────────────────
["Palladium","Familia","users"].forEach(dir => {
  const p = path.join(STORAGE_PATH, dir);
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Arx Cloud Lite running at http://localhost:${PORT}`);
  console.log(`Storage: ${STORAGE_PATH}`);
});

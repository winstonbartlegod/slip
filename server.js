import express from "express";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dataFile = join(root, "data", "board.json");
const TTL = new Set([0, 60, 300, 600, 1800, 3600, 86400]);
const ROOM = /^[0-9a-f]{32}$/;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const B64 = /^[A-Za-z0-9+/]+=*$/;

function load() {
  try {
    const parsed = JSON.parse(readFileSync(dataFile, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let clips = load();

function save() {
  mkdirSync(dirname(dataFile), { recursive: true });
  writeFileSync(dataFile, JSON.stringify(clips));
}

function live(now = Date.now()) {
  const before = clips.length;
  clips = clips.filter((clip) => clip.expiresAt == null || clip.expiresAt > now);
  if (clips.length !== before) save();
}

const app = express();
app.use(express.json({ limit: "3mb" }));

app.post("/api/clips/list", (req, res) => {
  const roomId = req.body?.roomId;
  if (typeof roomId !== "string" || !ROOM.test(roomId)) {
    res.status(400).json({ error: "That request didn’t look right." });
    return;
  }
  const known = new Set(Array.isArray(req.body?.knownIds) ? req.body.knownIds : []);
  live();
  const present = clips
    .filter((clip) => clip.roomId === roomId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 40);
  const missing = present.filter((clip) => !known.has(clip.id));
  res.set("Cache-Control", "no-store");
  res.json({
    serverNow: Date.now(),
    present: present.map(({ id, createdAt, expiresAt }) => ({ id, createdAt, expiresAt })),
    clips: missing.map(({ id, iv, ciphertext, createdAt, expiresAt }) => ({
      id,
      iv,
      ciphertext,
      createdAt,
      expiresAt,
    })),
  });
});

app.post("/api/clips", (req, res) => {
  const { id, roomId, iv, ciphertext, ttlSeconds } = req.body ?? {};
  if (
    typeof id !== "string" ||
    !ID.test(id) ||
    typeof roomId !== "string" ||
    !ROOM.test(roomId) ||
    typeof iv !== "string" ||
    !B64.test(iv) ||
    typeof ciphertext !== "string" ||
    !B64.test(ciphertext) ||
    ciphertext.length > 2_000_000 ||
    !TTL.has(ttlSeconds)
  ) {
    res.status(400).json({ error: "That request didn’t look right." });
    return;
  }
  live();
  const count = clips.filter((clip) => clip.roomId === roomId).length;
  if (count >= 40 && !clips.some((clip) => clip.id === id)) {
    res.status(400).json({ error: "This board is full. Remove a slip to add another." });
    return;
  }
  if (!clips.some((clip) => clip.id === id)) {
    clips.push({
      id,
      roomId,
      iv,
      ciphertext,
      createdAt: Date.now(),
      expiresAt: ttlSeconds === 0 ? null : Date.now() + ttlSeconds * 1000,
    });
    save();
  }
  const row = clips.find((clip) => clip.id === id && clip.roomId === roomId);
  if (!row) {
    res.status(400).json({ error: "Could not save that slip." });
    return;
  }
  res.set("Cache-Control", "no-store");
  res.json({ id: row.id, createdAt: row.createdAt, expiresAt: row.expiresAt });
});

app.delete("/api/clips", (req, res) => {
  const { id, roomId } = req.body ?? {};
  if (typeof id !== "string" || !ID.test(id) || typeof roomId !== "string" || !ROOM.test(roomId)) {
    res.status(400).json({ error: "That request didn’t look right." });
    return;
  }
  clips = clips.filter((clip) => !(clip.id === id && clip.roomId === roomId));
  save();
  res.set("Cache-Control", "no-store");
  res.json({ ok: true });
});

const port = Number(process.env.PORT) || 4173;
const production = process.env.NODE_ENV === "production";

if (production) {
  const dist = join(root, "dist");
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(join(dist, "index.html"));
  });
  app.listen(port, "0.0.0.0", () => {
    console.log(`Slip listening on ${port}`);
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root,
    server: { middlewareMode: true, host: "0.0.0.0", hmr: { port: 24678 } },
    appType: "spa",
  });
  app.use(vite.middlewares);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Slip listening on http://127.0.0.1:${port}`);
  });
}

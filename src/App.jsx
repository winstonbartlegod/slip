import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  TTL_CHOICES,
  TTL_LABELS,
  compressImage,
  decryptPayload,
  deviceId,
  deviceLabel,
  encryptPayload,
  extractCode,
  generateCode,
  imageDataUrlToPngBlob,
  imageFileFromList,
  normalizeCode,
  roomIdFromCode,
} from "./clip.js";

const MAX_CHARS = 16_000;

export function App() {
  const [code, setCode] = useState(null);
  const [draft, setDraft] = useState("");
  const [roomId, setRoomId] = useState(null);
  const [slips, setSlips] = useState([]);
  const [notice, setNotice] = useState("");
  const [clockOffset, setClockOffset] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(null);
  const [busy, setBusy] = useState(false);
  const [ttl, setTtl] = useState(0);
  const composer = useRef(null);
  const slipsRef = useRef([]);
  const known = useRef(new Set());
  const seeded = useRef(false);
  const me = useRef("");

  useEffect(() => {
    me.current = deviceId();
    const saved = localStorage.getItem("slip-ttl");
    if (saved && TTL_CHOICES.includes(Number(saved))) setTtl(Number(saved));
    const sync = () => setCode(normalizeCode(decodeURIComponent(location.hash.replace(/^#/, ""))));
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (!code) {
      setRoomId(null);
      setSlips([]);
      seeded.current = false;
      known.current = new Set();
      return;
    }
    let cancel = false;
    void roomIdFromCode(code).then((id) => {
      if (!cancel) setRoomId(id);
    });
    return () => {
      cancel = true;
    };
  }, [code]);

  const refresh = useCallback(async () => {
    if (!code || !roomId) return;
    const knownIds = slipsRef.current.filter((slip) => !slip.pending && !slip.failed).map((slip) => slip.id);
    const response = await fetch("/api/clips/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ roomId, knownIds }),
    });
    if (!response.ok) throw new Error("list");
    const data = await response.json();
    setClockOffset(data.serverNow - Date.now());
    const decoded = [];
    for (const row of data.clips) {
      const payload = await decryptPayload(code, row.iv, row.ciphertext);
      if (!payload) continue;
      decoded.push({
        id: row.id,
        text: payload.text,
        image: payload.image,
        device: payload.device,
        mine: payload.deviceId === me.current,
        createdAt: row.createdAt,
        expiresAt: row.expiresAt,
      });
    }
    seeded.current = true;
    for (const slip of decoded) known.current.add(slip.id);
    const presentIds = new Set(data.present.map((item) => item.id));
    const incoming = new Map(decoded.map((slip) => [slip.id, slip]));
    setSlips((local) => {
      const next = [];
      for (const meta of data.present) {
        const arrived = incoming.get(meta.id);
        const existing = local.find((slip) => slip.id === meta.id);
        if (arrived) next.push(arrived);
        else if (existing) next.push({ ...existing, createdAt: meta.createdAt, expiresAt: meta.expiresAt });
      }
      const extras = local.filter((slip) => (slip.pending || slip.failed) && !presentIds.has(slip.id));
      return [...extras, ...next].sort((a, b) => b.createdAt - a.createdAt);
    });
  }, [code, roomId]);

  useEffect(() => {
    if (!roomId) return;
    let stop = false;
    let inflight = false;
    const tick = async () => {
      if (stop || inflight || document.hidden) return;
      inflight = true;
      try {
        await refresh();
        if (!stop) setNotice((current) => (current.startsWith("Can’t reach") ? "" : current));
      } catch {
        if (!stop) setNotice("Can’t reach the board. Still trying.");
      } finally {
        inflight = false;
      }
    };
    void tick();
    const id = window.setInterval(() => void tick(), 1500);
    const onVis = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [roomId, refresh]);

  useEffect(() => {
    slipsRef.current = slips;
  }, [slips]);

  const enter = useCallback((next) => {
    history.replaceState(null, "", `${location.pathname}${location.search}#${next}`);
    setCode(next);
    setDraft("");
    setNotice("");
  }, []);

  const leave = useCallback(() => {
    history.replaceState(null, "", `${location.pathname}${location.search}`);
    setCode(null);
    setNotice("");
  }, []);

  const send = useCallback(
    async (raw, image) => {
      if (!code || !roomId) return;
      const text = raw.replace(/\r\n/g, "\n");
      if (!text.trim() && !image) {
        setNotice("Nothing to share.");
        return;
      }
      if (text.length > MAX_CHARS) {
        setNotice("That slip is too long. Keep it under 16,000 characters.");
        return;
      }
      const id = crypto.randomUUID();
      const optimistic = {
        id,
        text,
        image,
        device: deviceLabel(),
        mine: true,
        createdAt: Date.now(),
        expiresAt: ttl === 0 ? null : Date.now() + ttl * 1000,
        pending: true,
      };
      setSlips((prev) => [optimistic, ...prev]);
      setBusy(true);
      try {
        const packed = await encryptPayload(code, {
          text,
          image,
          device: deviceLabel(),
          deviceId: me.current,
        });
        const response = await fetch("/api/clips", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, roomId, ...packed, ttlSeconds: ttl }),
        });
        const saved = await response.json();
        if (!response.ok) throw new Error(saved.error || "Could not save that slip.");
        setSlips((prev) =>
          prev.map((slip) =>
            slip.id === id
              ? { ...slip, pending: false, failed: false, createdAt: saved.createdAt, expiresAt: saved.expiresAt }
              : slip,
          ),
        );
        if (composer.current) composer.current.value = "";
        setNotice("");
      } catch (error) {
        setSlips((prev) => prev.map((slip) => (slip.id === id ? { ...slip, pending: false, failed: true } : slip)));
        setNotice(error instanceof Error ? error.message : "Could not save that slip.");
      } finally {
        setBusy(false);
      }
    },
    [code, roomId, ttl],
  );

  const shareClipboard = useCallback(
    async (data) => {
      const text = data?.getData("text/plain") ?? "";
      const file = imageFileFromList(data?.items);
      if (!text && !file) return;
      const image = file ? await compressImage(file) : undefined;
      await send(text, image);
    },
    [send],
  );

  useEffect(() => {
    if (!code) return;
    const onPaste = (event) => {
      const target = event.target;
      if (target && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) return;
      const text = event.clipboardData?.getData("text/plain") ?? "";
      const file = imageFileFromList(event.clipboardData?.items);
      if (!text && !file) return;
      event.preventDefault();
      void shareClipboard(event.clipboardData);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [code, shareClipboard]);

  const copySlip = useCallback(async (id, slip) => {
    try {
      if (slip.image) {
        const png = () => imageDataUrlToPngBlob(slip.image);
        const payload = { "image/png": png() };
        if (slip.text.trim()) payload["text/plain"] = new Blob([slip.text], { type: "text/plain" });
        try {
          await navigator.clipboard.write([new ClipboardItem(payload)]);
        } catch {
          await navigator.clipboard.write([new ClipboardItem({ "image/png": png() })]);
        }
      } else {
        await navigator.clipboard.writeText(slip.text);
      }
      setCopied(id);
      window.setTimeout(() => setCopied((current) => (current === id ? null : current)), 1600);
    } catch {
      setNotice("Couldn’t copy. Select the text, or save the image, and copy it manually.");
    }
  }, []);

  const grab = useCallback(async () => {
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        let text = "";
        let image;
        for (const item of items) {
          if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
          const imageType = item.types.find((type) => type.startsWith("image/"));
          if (imageType) image = await compressImage(await item.getType(imageType));
        }
        if (!text && !image) {
          setNotice("Clipboard is empty.");
          return;
        }
        await send(text, image);
        return;
      }
      await send(await navigator.clipboard.readText());
    } catch {
      setNotice("Clipboard read was blocked. Paste with ⌘V or Ctrl+V instead.");
    }
  }, [send]);

  const remove = useCallback(
    async (id) => {
      if (!roomId) return;
      setSlips((prev) => prev.filter((slip) => slip.id !== id));
      try {
        await fetch("/api/clips", {
          method: "DELETE",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ id, roomId }),
        });
      } catch {
        setNotice("Couldn’t remove that slip.");
        void refresh();
      }
    },
    [roomId, refresh],
  );

  const visible = useMemo(
    () =>
      slips.filter((slip) => {
        if (slip.pending) return true;
        if (slip.expiresAt == null) return true;
        return slip.expiresAt - (now + clockOffset) > 0;
      }),
    [slips, now, clockOffset],
  );

  return (
    <main className="wrap">
      <header className="top">
        <p className="brand">Slip</p>
        <p className="tag">Shared clipboard</p>
      </header>
      {code ? (
        <Board
          code={code}
          slips={visible}
          notice={notice}
          busy={busy}
          copied={copied}
          now={now + clockOffset}
          ttl={ttl}
          composer={composer}
          onLeave={leave}
          onTtl={(value) => {
            const next = Number(value);
            if (!TTL_CHOICES.includes(next)) return;
            setTtl(next);
            localStorage.setItem("slip-ttl", String(next));
          }}
          onSend={() => void send(composer.current?.value ?? "")}
          onPaste={(data) => void shareClipboard(data)}
          onImageFile={(file) => {
            void compressImage(file)
              .then((image) => send("", image))
              .catch((error) => setNotice(error instanceof Error ? error.message : "Couldn’t read that image."));
          }}
          onGrab={() => void grab()}
          onCopy={(slip) => void copySlip(slip.id, slip)}
          onCopyCode={() => void copySlip("code", { id: "code", text: code })}
          onCopyLink={() =>
            void copySlip("link", {
              id: "link",
              text: `${location.origin}${location.pathname}${location.search}#${code}`,
            })
          }
          onRemove={(id) => void remove(id)}
        />
      ) : (
        <Landing
          draft={draft}
          notice={notice}
          onDraft={(value) => {
            const extracted = value.includes("#") || /https?:/i.test(value) ? extractCode(value) : null;
            if (extracted) {
              enter(extracted);
              return;
            }
            const cleaned = value
              .toUpperCase()
              .replace(/[^ABCDEFGHJKLMNPQRSTUVWXYZ23456789]/g, "")
              .slice(0, 12);
            setDraft(cleaned.replace(/(.{4})(?=.)/g, "$1-"));
          }}
          onCreate={() => enter(generateCode())}
          onJoin={() => {
            const next = normalizeCode(draft);
            if (!next) {
              setNotice("Enter the full code — three groups of four, like K7MP-4QW9-X2LN.");
              return;
            }
            enter(next);
          }}
        />
      )}
    </main>
  );
}

function Landing({ draft, notice, onDraft, onCreate, onJoin }) {
  return (
    <section className="hero">
      <h1>Paste here. Copy there.</h1>
      <p className="lede">
        Open Slip on both laptops with the same code. Paste text or a picture on one, then copy it off the other.
        Slips stay until you remove them, unless you set a timer.
      </p>
      <div className="actions">
        <button type="button" className="primary" onClick={onCreate}>
          New clipboard
        </button>
      </div>
      <label className="field">
        Or type the code from the other laptop
        <input value={draft} placeholder="XXXX-XXXX-XXXX" onChange={(event) => onDraft(event.target.value)} />
      </label>
      <div className="actions">
        <button type="button" className="line" onClick={onJoin}>
          Join
        </button>
      </div>
      {notice ? <p className="warn">{notice}</p> : null}
    </section>
  );
}

function Board({
  code,
  slips,
  notice,
  busy,
  copied,
  now,
  ttl,
  composer,
  onLeave,
  onTtl,
  onSend,
  onPaste,
  onImageFile,
  onGrab,
  onCopy,
  onCopyCode,
  onCopyLink,
  onRemove,
}) {
  return (
    <div className="board">
      <div className="sheet-wrap">
        <div className="clip" aria-hidden>
          <span />
        </div>
        <section className="sheet">
          <p className="note">Code for the other laptop</p>
          <p className="code" aria-label="Pairing code">
            {code}
          </p>
          <div className="row" style={{ marginTop: "1rem" }}>
            <button type="button" className="ghost" onClick={onCopyCode}>
              {copied === "code" ? "Copied" : "Copy code"}
            </button>
            <button type="button" className="ghost" onClick={onCopyLink}>
              {copied === "link" ? "Link copied" : "Copy link"}
            </button>
          </div>
          <label className="field" htmlFor="keep-for">
            Keep slips
          </label>
          <select id="keep-for" value={String(ttl)} onChange={(event) => onTtl(event.target.value)}>
            {TTL_CHOICES.map((seconds) => (
              <option key={seconds} value={String(seconds)}>
                {TTL_LABELS[seconds]}
              </option>
            ))}
          </select>
          <label className="field" htmlFor="composer">
            Paste or type
          </label>
          <textarea
            id="composer"
            ref={composer}
            rows={4}
            placeholder="Text or an image — ⌘V or Ctrl+V shares it"
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              const file = imageFileFromList(event.clipboardData.items);
              if (!text && !file) return;
              event.preventDefault();
              onPaste(event.clipboardData);
            }}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
                event.preventDefault();
                onSend();
              }
            }}
          />
          <div className="row" style={{ marginTop: "0.75rem" }}>
            <button type="button" className="primary" onClick={onSend} disabled={busy}>
              Share slip
            </button>
            <button type="button" className="line" onClick={onGrab}>
              Grab clipboard
            </button>
            <label className="line">
              Image
              <input
                id="slip-image"
                className="sr"
                type="file"
                accept="image/*"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  event.target.value = "";
                  if (file) onImageFile(file);
                }}
              />
            </label>
          </div>
          {notice ? <p className="warn">{notice}</p> : <p className="note">The code is the key. The server only stores scrambled slips.</p>}
          <button type="button" className="quiet" onClick={onLeave} style={{ marginTop: "1rem" }}>
            Leave this clipboard
          </button>
        </section>
      </div>
      <section aria-label="Recent slips">
        <div className="top">
          <h2>On the board</h2>
          <p className="note">{slips.length}</p>
        </div>
        {slips.length === 0 ? (
          <div className="empty">
            <h2>Nothing yet</h2>
            <p className="note">Paste text or an image on either laptop. It shows up here.</p>
          </div>
        ) : (
          <ul className="cards">
            {slips.map((slip) => (
              <SlipCard
                key={slip.id}
                slip={slip}
                now={now}
                copied={copied === slip.id}
                onCopy={() => onCopy(slip)}
                onRemove={() => onRemove(slip.id)}
              />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SlipCard({ slip, now, copied, onCopy, onRemove }) {
  const span = slip.expiresAt == null ? null : slip.expiresAt - slip.createdAt;
  const left = slip.expiresAt == null ? null : slip.expiresAt - now;
  const pct = span && left != null ? Math.max(0, Math.min(100, (left / span) * 100)) : 0;
  return (
    <li className="card">
      <div className="card-head">
        <p className="meta">
          <strong>{slip.mine ? "You" : slip.device}</strong>
          {slip.mine ? ` · ${slip.device}` : ""} · {ago(now - slip.createdAt)}
          {slip.pending ? " · sending" : ""}
          {slip.failed ? " · didn’t send" : ""}
        </p>
        <p className="timer">{left == null ? "Kept" : leftLabel(left)}</p>
      </div>
      {slip.image ? (
        <div className="shot">
          <img src={slip.image} alt="Pasted image" />
        </div>
      ) : null}
      {slip.text ? <p className="slip-text">{slip.text}</p> : null}
      <div className="card-foot">
        {left == null ? <div className="bar" /> : <div className="bar"><i style={{ width: `${pct}%` }} /></div>}
        <button type="button" className="text-btn" onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
        <button type="button" className="quiet" onClick={onRemove}>
          Remove
        </button>
      </div>
    </li>
  );
}

function ago(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function leftLabel(ms) {
  if (ms <= 0) return "expiring";
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

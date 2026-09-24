const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const MAX_IMAGE_CHARS = 1_200_000;

export const TTL_CHOICES = [0, 60, 300, 600, 1800, 3600, 86400];
export const TTL_LABELS = {
  0: "No timer",
  60: "1 minute",
  300: "5 minutes",
  600: "10 minutes",
  1800: "30 minutes",
  3600: "1 hour",
  86400: "1 day",
};

export function generateCode() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let raw = "";
  for (let i = 0; i < bytes.length; i += 1) raw += ALPHABET[bytes[i] & 31];
  return group(raw);
}

export function normalizeCode(input) {
  const raw = input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/[O0I1]/g, "");
  if (raw.length !== 12) return null;
  if ([...raw].some((char) => !ALPHABET.includes(char))) return null;
  return group(raw);
}

export function extractCode(input) {
  const hash = input.split("#")[1];
  if (hash) {
    const fromHash = normalizeCode(decodeURIComponent(hash).split(/[?&]/)[0] ?? "");
    if (fromHash) return fromHash;
  }
  return normalizeCode(input);
}

export async function roomIdFromCode(code) {
  const digest = await sha256(`slip-room:${code.replace(/-/g, "")}`);
  return hex(new Uint8Array(digest).slice(0, 16));
}

export async function encryptPayload(code, payload) {
  const key = await keyFromCode(code);
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const data = new TextEncoder().encode(JSON.stringify(payload));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return { iv: bytesToB64(iv), ciphertext: bytesToB64(new Uint8Array(ct)) };
}

export async function decryptPayload(code, iv, ciphertext) {
  try {
    const key = await keyFromCode(code);
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: b64ToBytes(iv) },
      key,
      b64ToBytes(ciphertext),
    );
    const obj = JSON.parse(new TextDecoder().decode(plain));
    if (!obj || typeof obj.deviceId !== "string") return null;
    const text = typeof obj.text === "string" ? obj.text : "";
    const image = validImage(obj.image);
    if (!text.trim() && !image) return null;
    return {
      text,
      image,
      device: typeof obj.device === "string" ? obj.device : "Device",
      deviceId: obj.deviceId,
    };
  } catch {
    return null;
  }
}

export function deviceLabel() {
  const ua = navigator.userAgent;
  if (/Windows/i.test(ua)) return "Windows";
  if (/Macintosh|Mac OS X/i.test(ua)) return "Mac";
  if (/iPhone|iPad/i.test(ua)) return "iPhone";
  if (/Android/i.test(ua)) return "Android";
  if (/Linux/i.test(ua)) return "Linux";
  return "Device";
}

export function deviceId() {
  const key = "slip-device";
  const existing = localStorage.getItem(key);
  if (existing) return existing;
  const id = crypto.randomUUID();
  localStorage.setItem(key, id);
  return id;
}

export function imageFileFromList(items) {
  if (!items) return null;
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item && item.kind === "file" && item.type.startsWith("image/")) return item.getAsFile();
  }
  return null;
}

export async function compressImage(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    const maxEdge = 1600;
    const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Couldn’t read that image.");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.55]) {
      const out = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (!out) continue;
      const dataUrl = await blobToDataUrl(out);
      if (dataUrl.length <= MAX_IMAGE_CHARS) return dataUrl;
    }
    throw new Error("That image is too large. Try a smaller screenshot.");
  } finally {
    bitmap.close();
  }
}

export function imageDataUrlToPngBlob(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth || 1;
      canvas.height = image.naturalHeight || 1;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Couldn’t prepare that image."));
        return;
      }
      ctx.drawImage(image, 0, 0);
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("Couldn’t prepare that image."));
      }, "image/png");
    };
    image.onerror = () => reject(new Error("Couldn’t prepare that image."));
    image.src = dataUrl;
  });
}

function group(raw) {
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
}

async function sha256(label) {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(label));
}

async function keyFromCode(code) {
  const digest = await sha256(`slip-key:${code.replace(/-/g, "")}`);
  return crypto.subtle.importKey("raw", digest, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesToB64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function b64ToBytes(value) {
  const bin = atob(value);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function validImage(value) {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("data:image/jpeg;base64,")) return undefined;
  if (value.length > MAX_IMAGE_CHARS) return undefined;
  return value;
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("Couldn’t read that image."));
    };
    reader.onerror = () => reject(new Error("Couldn’t read that image."));
    reader.readAsDataURL(blob);
  });
}

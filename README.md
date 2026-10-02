# Slip

A cross-platform shared clipboard you open in a browser. Paste text or a picture on one laptop, then copy it on the other. No install, no account, and it works between Mac and Windows.

## Why it’s useful

Moving a paragraph or a screenshot between two computers is usually worse than it should be. AirDrop skips Windows. Email and chat apps compress images and keep a copy forever. A shared-clipboard app means another download, another account, and another thing that only runs on one operating system.

Slip is a web page.

- Open it on each machine. Any modern browser is enough.
- Mac, Windows, Linux, and a phone can join the same board.
- The laptops do not need to be on the same Wi‑Fi. They only need to reach the same Slip site.
- Nothing is installed, and nothing asks you to sign in.

## How it works

1. One person clicks **New clipboard**. Slip shows a short code, like `K7MP-4QW9-X2LN`, and a link.
2. The other person types that code, or opens the link.
3. Paste text or an image on either side. It shows up on the board within a second or two.
4. Press **Copy** on the other machine. Text goes to the clipboard. Photos are copied as PNG, which is the format browsers will actually paste into other apps.
5. Slips stay until you remove them, or they expire if you set a timer (one minute up to one day).

The page polls the server about every second and a half. There is no background watcher, because a website is not allowed to read your system clipboard unless you paste or click **Grab clipboard**.

## How it stays private

The pairing code is the key. It never gets sent to the server.

Before a slip leaves the browser, Slip encrypts it with AES-GCM. The key is derived from the code with SHA-256. The server receives only:

- a room id, which is a hash of the code, not the code itself
- a random initialization vector
- the ciphertext

Someone with the server’s data file can see that a board exists and how large each slip is. They cannot read the text or the image without the code. The same is true of anyone watching the network, once the site is served over HTTPS.

A few honest limits:

- Anyone who has the code or the link can read and add slips. Treat the code like a password for that board, and leave the board when you are done.
- The code is 12 characters from a 32-character alphabet (about 1.15 × 10¹⁸ combinations). Guessing a live board is not practical. Sharing the link is.
- Slip does not hide *that* you are using it, or the size of what you sent. It hides the contents.
- On your own machine, `npm run dev` speaks plain HTTP. Use HTTPS when you put it on the public internet, so the code in the link is not visible to the network.
- This is practical encryption in the browser, not a security audit.

Images are scaled down in the browser before they are encrypted, so a screenshot stays small enough to pass through.

## Run it locally

```bash
npm install
npm run dev
```

Open http://127.0.0.1:4173 . That address is only this computer. Another laptop needs a deployed Slip, or this machine’s LAN address plus a firewall rule that allows port 4173.

Production:

```bash
npm run build
npm start
```

`PORT` overrides the port. Boards are stored in `data/board.json` on the server. That file is ciphertext. It is gitignored.

## Project layout

| Path | What it is |
| --- | --- |
| `src/` | The page: pairing, encryption, paste, and copy |
| `server.js` | Stores and serves scrambled slips |
| `public/` | Icon |

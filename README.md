# ♟️ Chess Live: Real-Time Multiplayer Web App

A production-ready real-time multiplayer Chess web application built with **Node.js**, **Express**, **Socket.io**, and **chess.js**.

Designed to be played locally across different PCs/phones on the same Wi-Fi/LAN network, or deployed straight to cloud production (Render, Railway, Fly.io, DigitalOcean, or Docker).

---

## 🚀 Quick Start (Local PC)

### 1. Install Dependencies
```bash
npm install
```

### 2. Run the Server
```bash
npm start
```

### 3. Open in Browser
* **On your host PC:** [http://localhost:3000](http://localhost:3000)

---

## 🌐 Playing from Another PC on the Same Wi-Fi / LAN

The server automatically listens on `0.0.0.0:3000`. Any other device (laptop, desktop, tablet, or smartphone) connected to the same Wi-Fi network can play!

1. Start the server on your primary PC:
   ```bash
   npm start
   ```
2. Note your local IP displayed in the console (e.g. `192.168.1.11`).
3. On the **second PC or mobile phone**, open:
   ```
   http://192.168.1.11:3000
   ```
4. **Player 1** clicks **"Create New Game Room"**.
5. Copy the invite link or share the 6-character room code.
6. **Player 2** enters the room code and joins immediately! Both boards, moves, and clocks sync in real-time.

---

## 🤖 Single Player (vs AI Mode)
Don't have a partner online? Switch to the **"Play vs AI"** tab to play against the integrated Antigravity Chess AI bot running Minimax with alpha-beta pruning.

---

## 📦 Deploying to Production (Live on the Internet)

### Option 1: Docker / Docker Compose
```bash
docker compose up -d
```

### Option 2: Render.com / Railway / Fly.io
1. Push this repository to GitHub.
2. In **Render** or **Railway**:
   - Create a **New Web Service**.
   - Build Command: `npm install`
   - Start Command: `node server.js`
   - Set Environment Variable: `PORT=3000` (or allow the platform to set `$PORT`).
3. Your game is live worldwide on a public HTTPS URL with real-time WebSockets!

---

## 🛠️ Tech Stack & Features
* **Backend:** Node.js, Express, Socket.io, `chess.js` (authoritative rule validation).
* **Frontend:** Vanilla JavaScript, HTML5, Tailwind CSS, Web Audio API (synthesized sounds).
* **Clocks & Timers:** Rapid (10m), Blitz (5m), Bullet (3m), Casual (Unlimited).
* **In-Game Chat:** Real-time chat box inside every game room.
* **Spectator Mode:** Friends can join as spectators to watch the match live.

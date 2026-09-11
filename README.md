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

## 📱 Telegram Mini App Setup

You can launch and play Chess Live directly inside Telegram as a Web App (Mini App):

### 1. Create a Telegram Bot via BotFather
1. In Telegram, search for `@BotFather` and click **Start**.
2. Send `/newbot` and follow the prompts to choose a display name and username (e.g. `ChessLivePvPBot`).
3. BotFather will provide an HTTP API token (e.g. `123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ`).
4. Add this token as the `BOT_TOKEN` environment variable in your production host (or local `.env`):
   ```env
   BOT_TOKEN=123456789:ABCDefGhIJKlmNoPQRsTUVwxyZ
   ```

### 2. Create the Mini App in BotFather
1. In `@BotFather`, send the `/newapp` command (note: use `/newapp`, not `/newgame`).
2. Select your newly created bot.
3. Provide a title and description for the Mini App (e.g., "Chess Live Multiplayer").
4. Upload a 640x360 app icon image when prompted.
5. When prompted for the **Web App URL**, enter your deployed HTTPS URL (e.g. `https://your-chess-domain.com`).
6. Set a short name for the app (e.g. `play` or `chess`). BotFather will generate your direct Mini App link:
   ```
   https://t.me/YourBotUsername/play
   ```

### 3. Deep Linking Support
You can share direct links to join a specific match room automatically:
```
https://t.me/YourBotUsername/play?startapp=room_ROOMCODE
```
When opened, the Mini App extracts the room code, auto-populates the join input, and immediately joins the match room without manual code entry.

### 4. Register Bot Commands in BotFather
To enable auto-complete for commands in Telegram:
1. Open `@BotFather` and send `/setcommands`.
2. Select your bot.
3. Paste the following list:
```text
start - Play Chess Live inside Telegram
help - How to play and game rules
```

### 5. Telegram Bot Service (`bot.js`)
A standalone bot script (`bot.js`) powers interactive Telegram interactions:
* `/start` responds with the game preview banner (`preview.png`), introductory text, and an inline **♟️ Play Chess Live** button launching the Mini App.
* `/help` displays rules, time controls, and feature overviews.

#### Running Locally
```bash
# Terminal 1 (Express & Socket.io Web Server)
npm start

# Terminal 2 (Telegram Bot Polling Worker)
npm run bot
```

#### Deploying as a Background Worker on Render
Render Web Services require listening on an incoming HTTP `$PORT`. Because the Telegram bot uses long-polling without needing an HTTP port, deploy it as an isolated **Background Worker**:

##### Method A: Docker Deployment (Recommended)
1. On [Render Dashboard](https://dashboard.render.com), click **New +** > **Background Worker**.
2. Connect your GitHub repository.
3. Configure settings:
   * **Name:** `chess-telegram-bot`
   * **Branch:** `master`
   * **Runtime / Environment:** `Docker`
   * **Dockerfile Path:** `Dockerfile.bot`
   * **Docker Context:** `.`
4. Under **Environment Variables**, add:
   * `BOT_TOKEN`: Your API token from `@BotFather`.
   * `WEB_APP_URL`: Your deployed web service URL (e.g. `https://chess-j33o.onrender.com/`).
5. Click **Create Background Worker**. The bot worker will spin up and handle Telegram commands.

##### Method B: Native Node Deployment
1. On Render, click **New +** > **Background Worker**.
2. Set **Environment:** `Node`, **Build Command:** `npm install`, **Start Command:** `npm run bot`.
3. Add the same `BOT_TOKEN` and `WEB_APP_URL` environment variables.

---

### 6. Web Service Configuration on Render
For the primary web service running `server.js`:
* **Runtime:** `Docker` (using default `Dockerfile`) or `Node` (`npm start`)
* **Health Check Path:** `/health` (returns HTTP 200 `{ status: "ok" }`)
* **Environment Variables:**
  * `PORT`: `3000` (or auto-assigned by Render)
  * `NODE_ENV`: `production`
  * `BOT_TOKEN`: Same API token from `@BotFather` (enables server-side `initData` signature validation)


---

## 🛠️ Tech Stack & Features
* **Backend:** Node.js, Express, Socket.io, `chess.js` (authoritative rule validation).
* **Frontend:** Vanilla JavaScript, HTML5, Tailwind CSS, Web Audio API (synthesized sounds).
* **Clocks & Timers:** Rapid (10m), Blitz (5m), Bullet (3m), Casual (Unlimited).
* **In-Game Chat:** Real-time chat box inside every game room.
* **Spectator Mode:** Friends can join as spectators to watch the match live.

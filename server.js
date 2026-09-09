const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const helmet = require('helmet');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
require('dotenv').config();

// ─── Configuration ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const NODE_ENV = process.env.NODE_ENV || 'development';
const MAX_ROOMS_PER_IP = parseInt(process.env.MAX_ROOMS_PER_IP, 10) || 5;
const ROOM_TTL_MS = parseInt(process.env.ROOM_TTL_MS, 10) || 3600000; // 1 hour default

// Parse allowed origins from env, fallback to permissive in dev
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)
  : null; // null = allow all (dev mode)

// ─── Express & HTTP ───────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);

// Helmet security headers — allow CDN scripts/styles, socket.io, and inline styles from Tailwind
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      scriptSrcAttr: ["'unsafe-inline'"], // needed for onclick/onsubmit handlers in HTML
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", "ws:", "wss:"],
      imgSrc: ["'self'", "data:"],
      fontSrc: ["'self'"],
    }
  },
  crossOriginEmbedderPolicy: false,
}));

// CORS — restrict in production, permissive in dev
const corsOptions = ALLOWED_ORIGINS
  ? { origin: ALLOWED_ORIGINS, methods: ['GET', 'POST'] }
  : { origin: true, methods: ['GET', 'POST'] };
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Socket.io with same CORS policy
const io = new Server(server, {
  cors: corsOptions
});

// ─── In-memory Room Store ─────────────────────────────────────────────────────
const rooms = new Map();
const ipRoomCount = new Map(); // ip -> number of rooms created

// ─── Helpers ──────────────────────────────────────────────────────────────────

// HTML entity encoding for XSS prevention
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Get local network IPs (for startup logging only)
function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({ name, ip: iface.address });
      }
    }
  }
  return addresses;
}

// Extract client IP from socket (respects X-Forwarded-For behind proxy)
function getSocketIp(socket) {
  return socket.handshake.headers['x-forwarded-for']?.split(',')[0]?.trim()
    || socket.handshake.address
    || 'unknown';
}

// Find a player's role/name in a room by socket.id
function getPlayerInfo(room, socketId) {
  if (room.players.white && room.players.white.id === socketId) {
    return { color: 'white', player: room.players.white };
  }
  if (room.players.black && room.players.black.id === socketId) {
    return { color: 'black', player: room.players.black };
  }
  return null;
}

// Verify that a socket and playerToken belong to an active player seat (rejects spectators)
function getVerifiedPlayer(room, socket, playerToken) {
  if (!room || !playerToken) return null;
  if (room.players.white && room.players.white.id === socket.id && room.players.white.token === playerToken) {
    return { color: 'white', player: room.players.white };
  }
  if (room.players.black && room.players.black.id === socket.id && room.players.black.token === playerToken) {
    return { color: 'black', player: room.players.black };
  }
  return null;
}

// Build a public-safe players object (never leak tokens)
function publicPlayers(room) {
  return {
    white: room.players.white
      ? { name: room.players.white.name, connected: room.players.white.connected !== false }
      : null,
    black: room.players.black
      ? { name: room.players.black.name, connected: room.players.black.connected !== false }
      : null
  };
}

// ─── Room Cleanup (Fix #4) ───────────────────────────────────────────────────
function cleanupRoom(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (room.cleanupTimeout) clearTimeout(room.cleanupTimeout);
  // Decrement per-IP counter
  if (room._creatorIp) {
    const count = ipRoomCount.get(room._creatorIp) || 0;
    if (count > 1) ipRoomCount.set(room._creatorIp, count - 1);
    else ipRoomCount.delete(room._creatorIp);
  }
  rooms.delete(roomId);
}

// Schedule room cleanup after TTL of inactivity
function scheduleRoomCleanup(room) {
  if (room.cleanupTimeout) clearTimeout(room.cleanupTimeout);
  room.cleanupTimeout = setTimeout(() => {
    // Only clean up if both players are disconnected or game is over
    const wConn = room.players.white && room.players.white.connected !== false;
    const bConn = room.players.black && room.players.black.connected !== false;
    if (!wConn && !bConn) {
      cleanupRoom(room.id);
    } else {
      // Reschedule — still has active players
      scheduleRoomCleanup(room);
    }
  }, ROOM_TTL_MS);
}

// ─── AI Engine ────────────────────────────────────────────────────────────────
const PIECE_VALUES = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 20000 };
const PST_P = [
  0,  0,  0,  0,  0,  0,  0,  0,
  50, 50, 50, 50, 50, 50, 50, 50,
  10, 10, 20, 30, 30, 20, 10, 10,
  5,  5, 10, 25, 25, 10,  5,  5,
  0,  0,  0, 20, 20,  0,  0,  0,
  5, -5,-10,  0,  0,-10, -5,  5,
  5, 10, 10,-20,-20, 10, 10,  5,
  0,  0,  0,  0,  0,  0,  0,  0
];
const PST_N = [
  -50,-40,-30,-30,-30,-30,-40,-50,
  -40,-20,  0,  0,  0,  0,-20,-40,
  -30,  0, 10, 15, 15, 10,  0,-30,
  -30,  5, 15, 20, 20, 15,  5,-30,
  -30,  0, 15, 20, 20, 15,  0,-30,
  -30,  5, 10, 15, 15, 10,  5,-30,
  -40,-20,  0,  5,  5,  0,-20,-40,
  -50,-40,-30,-30,-30,-30,-40,-50
];

function evaluatePosition(chess) {
  if (chess.isCheckmate()) {
    return chess.turn() === 'w' ? -99999 : 99999;
  }
  if (chess.isDraw()) return 0;

  let score = 0;
  const board = chess.board();
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const piece = board[r][c];
      if (!piece) continue;
      const val = PIECE_VALUES[piece.type] || 0;
      let pos = 0;
      const idx = piece.color === 'w' ? r * 8 + c : (7 - r) * 8 + c;
      if (piece.type === 'p') pos = PST_P[idx] || 0;
      if (piece.type === 'n') pos = PST_N[idx] || 0;
      if (piece.color === 'w') score += val + pos;
      else score -= (val + pos);
    }
  }
  return score;
}

function minimax(chess, depth, alpha, beta, isMaximizing) {
  if (depth === 0 || chess.isGameOver()) {
    return { score: evaluatePosition(chess) };
  }
  const moves = chess.moves({ verbose: true });
  if (moves.length === 0) return { score: 0 };
  moves.sort((a, b) => (b.captured ? 1 : 0) - (a.captured ? 1 : 0));

  let bestMove = moves[0];
  if (isMaximizing) {
    let maxEval = -Infinity;
    for (const m of moves) {
      chess.move(m);
      const ev = minimax(chess, depth - 1, alpha, beta, false).score;
      chess.undo();
      if (ev > maxEval) { maxEval = ev; bestMove = m; }
      alpha = Math.max(alpha, ev);
      if (beta <= alpha) break;
    }
    return { score: maxEval, move: bestMove };
  } else {
    let minEval = Infinity;
    for (const m of moves) {
      chess.move(m);
      const ev = minimax(chess, depth - 1, alpha, beta, true).score;
      chess.undo();
      if (ev < minEval) { minEval = ev; bestMove = m; }
      beta = Math.min(beta, ev);
      if (beta <= alpha) break;
    }
    return { score: minEval, move: bestMove };
  }
}

function triggerAiMove(room, delayMs = 350) {
  if (!room || room.mode !== 'ai' || room.chess.isGameOver()) return;
  const currentTurn = room.chess.turn() === 'w' ? 'white' : 'black';
  const aiPlayer = room.players[currentTurn];
  if (!aiPlayer || aiPlayer.id !== 'ai-bot') return;

  const isMaximizing = (currentTurn === 'white');
  setTimeout(() => {
    try {
      if (!rooms.has(room.id)) return;
      if (room.chess.isGameOver()) return;
      const turnNow = room.chess.turn() === 'w' ? 'white' : 'black';
      if (room.players[turnNow]?.id !== 'ai-bot') return;

      const aiResult = minimax(room.chess, 2, -Infinity, Infinity, isMaximizing);
      if (aiResult.move) {
        const aiMove = room.chess.move(aiResult.move);
        const afterAiTurn = room.chess.turn() === 'w' ? 'white' : 'black';
        const aiInCheck = room.chess.inCheck();
        const aiIsGameOver = room.chess.isGameOver();

        let aiGameOverData = null;
        if (aiIsGameOver) {
          if (room.timerInterval) clearInterval(room.timerInterval);
          room.gameOver = true;
          let aiWinner = null;
          let aiReason = 'draw';
          if (room.chess.isCheckmate()) {
            aiWinner = currentTurn === 'white' ? 'White (AI)' : 'Black (AI)';
            aiReason = 'checkmate';
          }
          aiGameOverData = { winner: aiWinner, reason: aiReason };
          scheduleRoomCleanup(room);
        }

        io.to(room.id).emit('move_made', {
          move: aiMove,
          fen: room.chess.fen(),
          pgn: room.chess.pgn(),
          turn: afterAiTurn,
          inCheck: aiInCheck,
          isGameOver: aiIsGameOver,
          gameOverData: aiGameOverData,
          clocks: room.clocks
        });
      }
    } catch (aiErr) {
      console.error(`AI move error in room ${room.id}:`, aiErr.message);
    }
  }, delayMs);
}

// ─── Timer Management ─────────────────────────────────────────────────────────
function startClock(room) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (!room.timeControl || room.timeControl <= 0) return;

  room.timerInterval = setInterval(() => {
    if (room.chess.isGameOver()) {
      clearInterval(room.timerInterval);
      return;
    }
    const turn = room.chess.turn() === 'w' ? 'white' : 'black';
    if (room.clocks[turn] > 0) {
      room.clocks[turn]--;
      if (room.clocks[turn] === 0) {
        clearInterval(room.timerInterval);
        room.gameOver = true;
        const winner = turn === 'white' ? 'Black' : 'White';
        io.to(room.id).emit('game_over', {
          winner,
          reason: 'timeout',
          message: `${turn.toUpperCase()} ran out of time! ${winner} wins! ⏱️`
        });
      }
      io.to(room.id).emit('clock_update', room.clocks);
    }
  }, 1000);
}

// ─── Rate Limiting ────────────────────────────────────────────────────────────
const rateLimits = new Map(); // socket.id -> { chat: {...}, join: {...} }

function checkRateLimit(socketId, type, max, windowMs) {
  const now = Date.now();
  let userLimits = rateLimits.get(socketId);
  if (!userLimits) {
    userLimits = {
      chat: { count: 0, resetTime: now + windowMs },
      join: { count: 0, resetTime: now + windowMs }
    };
    rateLimits.set(socketId, userLimits);
  }
  const tracker = userLimits[type];
  if (!tracker) return true;
  if (now > tracker.resetTime) {
    tracker.count = 0;
    tracker.resetTime = now + windowMs;
  }
  tracker.count++;
  return tracker.count <= max;
}

// ─── REST API ─────────────────────────────────────────────────────────────────
// Fix #9: /api/info no longer leaks LAN IPs to unauthenticated clients
app.get('/api/info', (req, res) => {
  res.json({
    status: 'online',
    roomsActive: rooms.size
    // LAN IPs intentionally omitted — logged to server console only
  });
});

// Health check endpoint (for Docker HEALTHCHECK, load balancers, etc.)
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', uptime: process.uptime() });
});

// Favicon endpoints
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.ico'));
});
app.get('/favicon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// ─── Socket.io Event Handlers ─────────────────────────────────────────────────
io.on('connection', (socket) => {
  let currentRoomId = null;

  // ── join_game ───────────────────────────────────────────────────────────────
  socket.on('join_game', (payload) => {
    // Fix #1: Payload validation
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid join request.');
    }
    const { roomId, playerName, mode, timeControl, preferredColor, playerToken } = payload;

    // Rate limit join attempts (max 12 per minute)
    if (!checkRateLimit(socket.id, 'join', 12, 60000)) {
      return socket.emit('error_message', 'Too many join requests. Please slow down.');
    }

    const clientIp = getSocketIp(socket);
    const resolvedRoomId = (typeof roomId === 'string' && roomId.trim())
      ? roomId.trim().toUpperCase().substring(0, 12)
      : crypto.randomBytes(3).toString('hex').toUpperCase();

    let room = rooms.get(resolvedRoomId);
    const isNewRoom = !room;

    // Fix #4: Per-IP room creation cap
    if (isNewRoom) {
      const currentCount = ipRoomCount.get(clientIp) || 0;
      if (currentCount >= MAX_ROOMS_PER_IP) {
        return socket.emit('error_message', `Room limit reached (${MAX_ROOMS_PER_IP} per IP). Please close an existing room first.`);
      }
    }

    if (isNewRoom) {
      const tc = parseInt(timeControl) || 0;
      room = {
        id: resolvedRoomId,
        chess: new Chess(),
        mode: (mode === 'ai') ? 'ai' : 'pvp',
        timeControl: tc,
        clocks: { white: tc, black: tc },
        timerInterval: null,
        players: { white: null, black: null },
        spectators: [],
        messages: [],
        restartRequests: new Set(), // Fix #12: mutual consent
        _creatorIp: clientIp,
        _createdAt: Date.now(),
        _lastActivity: Date.now()
      };
      rooms.set(resolvedRoomId, room);
      ipRoomCount.set(clientIp, (ipRoomCount.get(clientIp) || 0) + 1);
      scheduleRoomCleanup(room);
    }

    // Touch activity timestamp
    room._lastActivity = Date.now();

    currentRoomId = resolvedRoomId;
    socket.join(currentRoomId);

    let role = 'spectator';
    let token = (typeof playerToken === 'string' && playerToken) ? playerToken : crypto.randomUUID();
    const rawName = (typeof playerName === 'string' ? playerName : '').trim().substring(0, 24);
    const cleanName = sanitize(rawName || `Player-${socket.id.substring(0, 4)}`);
    let assignedName = cleanName;

    // Determine host color if room is newly created
    let hostColor = 'white';
    if (preferredColor === 'black') {
      hostColor = 'black';
    } else if (preferredColor === 'white') {
      hostColor = 'white';
    } else {
      // 'random' or unspecified -> server rolls 50/50
      hostColor = Math.random() < 0.5 ? 'white' : 'black';
    }

    if (room.mode === 'ai') {
      // Check if human player already exists in this AI room
      const existingUser = (room.players.white && room.players.white.id !== 'ai-bot') ? room.players.white
                         : (room.players.black && room.players.black.id !== 'ai-bot') ? room.players.black : null;
      const existingUserColor = (existingUser === room.players.white) ? 'white' : 'black';

      if (existingUser && existingUser.id !== socket.id) {
        // Check reconnect by token
        if (existingUser.token === playerToken) {
          existingUser.id = socket.id;
          existingUser.connected = true;
          role = existingUserColor;
          token = existingUser.token;
          assignedName = existingUser.name;
        } else {
          // Someone else's AI game — join as spectator
          role = 'spectator';
          token = null;
          room.spectatorCount = (room.spectatorCount || 0) + 1;
          let specName = rawName;
          if (!specName || specName.toLowerCase() === 'player 2' || specName.toLowerCase().startsWith('player-')) {
            specName = `Spectator ${room.spectatorCount}`;
          }
          assignedName = sanitize(specName);
          room.spectators.push({ id: socket.id, name: assignedName, role: 'spectator' });
        }
      } else {
        // New AI game: seat human player based on hostColor
        if (hostColor === 'black') {
          room.players.white = { id: 'ai-bot', token: 'ai-token', name: 'Antigravity AI (Bot)', connected: true };
          room.players.black = { id: socket.id, token, name: cleanName, connected: true };
          role = 'black';
        } else {
          room.players.white = { id: socket.id, token, name: cleanName, connected: true };
          room.players.black = { id: 'ai-bot', token: 'ai-token', name: 'Antigravity AI (Bot)', connected: true };
          role = 'white';
        }
      }
    } else {
      // PvP mode — reconnect by token first
      if (room.players.white && room.players.white.token === playerToken) {
        room.players.white.id = socket.id;
        room.players.white.connected = true;
        role = 'white';
        token = room.players.white.token;
        assignedName = room.players.white.name;
      } else if (room.players.black && room.players.black.token === playerToken) {
        room.players.black.id = socket.id;
        room.players.black.connected = true;
        role = 'black';
        token = room.players.black.token;
        assignedName = room.players.black.name;
      } else if (isNewRoom) {
        // Room creator assigned according to hostColor
        if (hostColor === 'black') {
          room.players.black = { id: socket.id, token, name: cleanName, connected: true };
          room.players.white = null;
          role = 'black';
        } else {
          room.players.white = { id: socket.id, token, name: cleanName, connected: true };
          room.players.black = null;
          role = 'white';
        }
      } else {
        // Second player takes the remaining available seat
        if (!room.players.white) {
          room.players.white = { id: socket.id, token, name: cleanName, connected: true };
          role = 'white';
        } else if (!room.players.black) {
          room.players.black = { id: socket.id, token, name: cleanName, connected: true };
          role = 'black';
        } else {
          role = 'spectator';
          token = null;
          room.spectatorCount = (room.spectatorCount || 0) + 1;
          let specName = rawName;
          if (!specName || specName.toLowerCase() === 'player 2' || specName.toLowerCase().startsWith('player-')) {
            specName = `Spectator ${room.spectatorCount}`;
          }
          assignedName = sanitize(specName);
          room.spectators.push({ id: socket.id, name: assignedName, role: 'spectator' });
        }
      }
    }

    // Start timer once both players have joined
    if (room.players.white && room.players.black && room.timeControl > 0 && !room.timerInterval) {
      startClock(room);
    }

    // Send private init event with playerToken to the joining client
    socket.emit('game_init', {
      roomId: room.id,
      role,
      playerName: assignedName,
      playerToken: token,
      fen: room.chess.fen(),
      pgn: room.chess.pgn(),
      history: room.chess.history({ verbose: true }),
      turn: room.chess.turn() === 'w' ? 'white' : 'black',
      players: publicPlayers(room),
      clocks: room.clocks,
      timeControl: room.timeControl,
      mode: room.mode,
      inCheck: room.chess.inCheck(),
      isGameOver: room.chess.isGameOver(),
      messages: room.messages.slice(-30)
    });

    // If AI is playing as White and it is move 1, trigger opening move
    if (room.mode === 'ai' && room.players.white?.id === 'ai-bot' && room.chess.history().length === 0) {
      triggerAiMove(room, 500);
    }

    // Notify entire room of player changes
    io.to(room.id).emit('players_update', {
      players: publicPlayers(room),
      spectatorsCount: room.spectators.length
    });
  });

  // ── make_move ───────────────────────────────────────────────────────────────
  socket.on('make_move', (payload) => {
    // Fix #1: Payload validation
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid move request.');
    }
    const { roomId, from, to, promotion, playerToken } = payload;
    if (typeof roomId !== 'string' || typeof from !== 'string' || typeof to !== 'string') {
      return socket.emit('error_message', 'Invalid move parameters.');
    }

    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_message', 'Room not found.');

    const currentTurn = room.chess.turn() === 'w' ? 'white' : 'black';
    const player = room.players[currentTurn];

    // Unified auth for BOTH PvP and AI modes
    // Check if it is AI's turn
    if (player && player.id === 'ai-bot') {
      return socket.emit('error_message', 'Wait for AI to move.');
    }
    if (!player || player.token !== playerToken || player.id !== socket.id) {
      return socket.emit('error_message', 'Unauthorized: Not your turn or invalid player token!');
    }

    try {
      // Validate promotion field
      const validPromotions = ['q', 'r', 'b', 'n'];
      const promo = (typeof promotion === 'string' && validPromotions.includes(promotion))
        ? promotion : 'q';

      const move = room.chess.move({ from, to, promotion: promo });
      if (!move) return socket.emit('error_message', 'Illegal move.');

      room._lastActivity = Date.now();
      const nextTurn = room.chess.turn() === 'w' ? 'white' : 'black';
      const inCheck = room.chess.inCheck();
      const isGameOver = room.chess.isGameOver();

      let gameOverData = null;
      if (isGameOver) {
        if (room.timerInterval) clearInterval(room.timerInterval);
        room.gameOver = true;
        let winner = null;
        let reason = 'draw';
        if (room.chess.isCheckmate()) {
          winner = currentTurn === 'white' ? 'White' : 'Black';
          reason = 'checkmate';
        } else if (room.chess.isStalemate()) {
          reason = 'stalemate';
        } else if (room.chess.isThreefoldRepetition()) {
          reason = 'threefold repetition';
        } else if (room.chess.isInsufficientMaterial()) {
          reason = 'insufficient material';
        }
        gameOverData = { winner, reason };
        // Schedule cleanup for finished game
        scheduleRoomCleanup(room);
      }

      io.to(room.id).emit('move_made', {
        move,
        fen: room.chess.fen(),
        pgn: room.chess.pgn(),
        turn: nextTurn,
        inCheck,
        isGameOver,
        gameOverData,
        clocks: room.clocks
      });

      // AI Response Trigger
      if (room.mode === 'ai' && !isGameOver) {
        triggerAiMove(room, 350);
      }
    } catch (err) {
      socket.emit('error_message', `Invalid move: ${err.message}`);
    }
  });

  // ── startRematch helper ─────────────────────────────────────────────────────
  function startRematch(room) {
    if (room.rematchTimeout) clearTimeout(room.rematchTimeout);
    room.rematchRequests = new Set();
    room.drawOffer = null;
    room.drawDeclinedAt = null;

    // Swap player seats by default (chess.com convention)
    const prevWhite = room.players.white;
    const prevBlack = room.players.black;
    room.players.white = prevBlack;
    room.players.black = prevWhite;

    // Reset chess and clocks
    if (room.timerInterval) clearInterval(room.timerInterval);
    room.chess = new Chess();
    room.clocks = { white: room.timeControl, black: room.timeControl };
    room.gameOver = false;
    room._lastActivity = Date.now();
    if (room.timeControl > 0) startClock(room);

    // Notify all sockets in room
    io.to(room.id).emit('game_restarted', {
      fen: room.chess.fen(),
      pgn: '',
      turn: 'white',
      clocks: room.clocks,
      players: publicPlayers(room),
      swapped: true
    });

    // If AI mode and AI is White, trigger AI move
    if (room.mode === 'ai' && room.players.white?.id === 'ai-bot') {
      triggerAiMove(room, 500);
    }
  }

  // ── offer_draw ──────────────────────────────────────────────────────────────
  socket.on('offer_draw', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid draw offer request.');
    }
    const { roomId, playerToken } = payload;
    if (typeof roomId !== 'string' || typeof playerToken !== 'string') {
      return socket.emit('error_message', 'Invalid parameters.');
    }

    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_message', 'Room not found.');

    const verified = getVerifiedPlayer(room, socket, playerToken);
    if (!verified) {
      return socket.emit('error_message', 'Only active players can offer a draw.');
    }

    if (room.chess.isGameOver() || room.gameOver) {
      return socket.emit('error_message', 'Game is already over.');
    }

    // Cooldown check (prevent draw offer spam)
    if (room.drawOffer) {
      return socket.emit('error_message', 'A draw offer is already pending.');
    }
    if (room.drawDeclinedAt && Date.now() - room.drawDeclinedAt < 20000) {
      const waitSec = Math.ceil((20000 - (Date.now() - room.drawDeclinedAt)) / 1000);
      return socket.emit('error_message', `Please wait ${waitSec}s before offering another draw.`);
    }

    const offeringColor = verified.color;
    const opponentColor = offeringColor === 'white' ? 'black' : 'white';
    const opponent = room.players[opponentColor];

    // Handle AI game
    if (room.mode === 'ai' && opponent && opponent.id === 'ai-bot') {
      const evalScore = evaluateBoard(room.chess);
      const aiAdvantage = opponentColor === 'white' ? evalScore : -evalScore;
      if (aiAdvantage > 150) {
        room.drawDeclinedAt = Date.now();
        return socket.emit('draw_declined', { message: 'AI declined the draw offer.' });
      } else {
        if (room.timerInterval) clearInterval(room.timerInterval);
        room.gameOver = true;
        io.to(room.id).emit('game_over', {
          winner: null,
          reason: 'agreement',
          message: 'Draw agreed! AI accepted your draw offer. 🤝'
        });
        scheduleRoomCleanup(room);
        return;
      }
    }

    if (!opponent || opponent.connected === false) {
      return socket.emit('error_message', 'Opponent is not connected.');
    }

    room.drawOffer = { from: offeringColor, timestamp: Date.now() };

    // Emit offer to opponent
    io.to(opponent.id).emit('draw_offered', {
      from: offeringColor,
      playerName: verified.player.name
    });
  });

  // ── respond_draw ────────────────────────────────────────────────────────────
  socket.on('respond_draw', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid draw response.');
    }
    const { roomId, playerToken, accept } = payload;
    if (typeof roomId !== 'string' || typeof playerToken !== 'string') {
      return socket.emit('error_message', 'Invalid parameters.');
    }

    const room = rooms.get(roomId);
    if (!room) return;

    const verified = getVerifiedPlayer(room, socket, playerToken);
    if (!verified) {
      return socket.emit('error_message', 'Only active players can respond to a draw offer.');
    }

    if (!room.drawOffer) return;

    // Verify respondent is the opponent of the offerer
    if (verified.color === room.drawOffer.from) {
      return socket.emit('error_message', 'Cannot respond to your own draw offer.');
    }

    const offeringPlayer = room.players[room.drawOffer.from];
    room.drawOffer = null;

    if (accept) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      room.gameOver = true;
      io.to(room.id).emit('game_over', {
        winner: null,
        reason: 'agreement',
        message: 'Draw agreed! Game ended by mutual agreement. 🤝'
      });
      scheduleRoomCleanup(room);
    } else {
      room.drawDeclinedAt = Date.now();
      if (offeringPlayer && offeringPlayer.id) {
        io.to(offeringPlayer.id).emit('draw_declined', {
          message: `${verified.player.name} declined the draw offer.`
        });
      }
    }
  });

  // ── request_rematch ─────────────────────────────────────────────────────────
  socket.on('request_rematch', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid rematch request.');
    }
    const { roomId, playerToken } = payload;
    if (typeof roomId !== 'string' || typeof playerToken !== 'string') {
      return socket.emit('error_message', 'Invalid parameters.');
    }

    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_message', 'Room not found.');

    const verified = getVerifiedPlayer(room, socket, playerToken);
    if (!verified) {
      return socket.emit('error_message', 'Only active players can request a rematch.');
    }

    // Rematch is only allowed when game has ended
    if (!room.chess.isGameOver() && !room.gameOver) {
      return socket.emit('error_message', 'Cannot rematch while game is still active.');
    }

    // AI Mode: AI always immediately accepts rematch
    if (room.mode === 'ai') {
      startRematch(room);
      return;
    }

    const requesterColor = verified.color;
    const opponentColor = requesterColor === 'white' ? 'black' : 'white';
    const opponent = room.players[opponentColor];

    if (!opponent || opponent.connected === false) {
      return socket.emit('error_message', 'Opponent is not connected.');
    }

    room.rematchRequests = room.rematchRequests || new Set();
    room.rematchRequests.add(requesterColor);

    // If both players requested, trigger rematch!
    if (room.rematchRequests.size >= 2) {
      startRematch(room);
      return;
    }

    // Single request: notify requester & opponent, set 45s expiration timer
    socket.emit('rematch_pending', { message: 'Rematch request sent. Waiting for opponent...' });
    io.to(opponent.id).emit('rematch_requested', {
      requester: verified.player.name,
      message: `${verified.player.name} wants a rematch!`
    });

    if (room.rematchTimeout) clearTimeout(room.rematchTimeout);
    room.rematchTimeout = setTimeout(() => {
      if (room.rematchRequests && room.rematchRequests.size > 0 && room.rematchRequests.size < 2) {
        room.rematchRequests.clear();
        io.to(room.id).emit('rematch_declined', {
          reason: 'timeout',
          message: 'Rematch request expired (no response from opponent).'
        });
      }
    }, 45000);
  });

  // ── respond_rematch ─────────────────────────────────────────────────────────
  socket.on('respond_rematch', (payload) => {
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid rematch response.');
    }
    const { roomId, playerToken, accept } = payload;
    if (typeof roomId !== 'string' || typeof playerToken !== 'string') {
      return socket.emit('error_message', 'Invalid parameters.');
    }

    const room = rooms.get(roomId);
    if (!room) return;

    const verified = getVerifiedPlayer(room, socket, playerToken);
    if (!verified) {
      return socket.emit('error_message', 'Only active players can respond to a rematch.');
    }

    if (!room.rematchRequests || room.rematchRequests.size === 0) return;

    if (accept) {
      startRematch(room);
    } else {
      if (room.rematchTimeout) clearTimeout(room.rematchTimeout);
      room.rematchRequests.clear();
      io.to(room.id).emit('rematch_declined', {
        reason: 'declined',
        message: `${verified.player.name} declined the rematch request.`
      });
    }
  });

  // ── chat_message ────────────────────────────────────────────────────────────
  socket.on('chat_message', (payload) => {
    // Fix #1: Payload validation
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid chat message.');
    }
    const { roomId, text } = payload;
    if (typeof roomId !== 'string' || typeof text !== 'string') {
      return socket.emit('error_message', 'Invalid chat parameters.');
    }

    const room = rooms.get(roomId);
    if (!room) return;

    // Rate limit: max 4 messages per 2 seconds
    if (!checkRateLimit(socket.id, 'chat', 4, 2000)) {
      return socket.emit('error_message', 'You are sending messages too quickly.');
    }

    const cleanText = sanitize(text.trim().substring(0, 200));
    if (!cleanText) return;

    // Spectator Chat Identity: Explicitly check player records first
    const isWhite = room.players.white && room.players.white.id === socket.id;
    const isBlack = room.players.black && room.players.black.id === socket.id;
    let senderName;
    let isSpectator = false;
    let senderRole = 'spectator';

    if (isWhite) {
      senderName = room.players.white.name;
      senderRole = 'white';
    } else if (isBlack) {
      senderName = room.players.black.name;
      senderRole = 'black';
    } else {
      // Classified as spectator — do NOT fall through to default player label
      isSpectator = true;
      senderRole = 'spectator';
      const spec = room.spectators.find(s => s.id === socket.id);
      const baseName = spec ? spec.name : 'Spectator';
      senderName = `${baseName} (Spectator)`;
    }

    const msg = {
      id: Date.now(),
      sender: senderName,
      isSpectator,
      role: senderRole,
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.messages.push(msg);
    if (room.messages.length > 50) room.messages.shift();
    io.to(room.id).emit('chat_message', msg);
  });

  // ── resign ──────────────────────────────────────────────────────────────────
  socket.on('resign', (payload) => {
    // Fix #1: Payload validation
    if (!payload || typeof payload !== 'object') {
      return socket.emit('error_message', 'Invalid resign request.');
    }
    const { roomId, playerToken } = payload;
    if (typeof roomId !== 'string' || typeof playerToken !== 'string') {
      return socket.emit('error_message', 'Invalid room ID or player token.');
    }

    const room = rooms.get(roomId);
    if (!room || room.chess.isGameOver() || room.gameOver) return;

    // Reuse seat/token verification — spectators are strictly rejected
    const verified = getVerifiedPlayer(room, socket, playerToken);
    if (!verified) {
      return socket.emit('error_message', 'Only active players can resign.');
    }

    if (room.timerInterval) clearInterval(room.timerInterval);
    room.gameOver = true;
    const isWhite = verified.color === 'white';
    const winner = isWhite ? 'Black' : 'White';
    io.to(room.id).emit('game_over', {
      winner,
      reason: 'resignation',
      message: `${isWhite ? 'White' : 'Black'} resigned. ${winner} wins! 🏳️`
    });

    scheduleRoomCleanup(room);
  });

  // ── disconnect ──────────────────────────────────────────────────────────────
  socket.on('disconnect', () => {
    rateLimits.delete(socket.id);
    if (!currentRoomId) return;
    const room = rooms.get(currentRoomId);
    if (!room) return;

    if (room.players.white && room.players.white.id === socket.id) {
      room.players.white.connected = false;
    }
    if (room.players.black && room.players.black.id === socket.id) {
      room.players.black.connected = false;
    }
    room.spectators = room.spectators.filter(s => s.id !== socket.id);

    io.to(room.id).emit('players_update', {
      players: publicPlayers(room),
      spectatorsCount: room.spectators.length
    });

    // Schedule cleanup if both players disconnected
    const wConn = room.players.white && room.players.white.connected !== false;
    const bConn = room.players.black && room.players.black.connected !== false;
    if (!wConn && !bConn) {
      scheduleRoomCleanup(room);
    }
  });
});

// ─── Crash Containment (Fix #6) ───────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception:', err);
  // In production, you'd want to trigger a graceful restart via process manager
  // For now, keep the server alive
});

process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Rejection:', reason);
});

// ─── Start Server ─────────────────────────────────────────────────────────────
server.listen(PORT, HOST, () => {
  const localIps = getLocalIpAddresses();
  console.log(`\n=================================================`);
  console.log(`♟️  CHESS LIVE SERVER RUNNING (HARDENED & SECURE)!`);
  console.log(`-------------------------------------------------`);
  console.log(`> Environment:     ${NODE_ENV}`);
  console.log(`> Local PC:        http://localhost:${PORT}`);
  localIps.forEach(net => {
    console.log(`> On LAN (${net.name}): http://${net.ip}:${PORT}`);
  });
  if (ALLOWED_ORIGINS) {
    console.log(`> CORS Origins:    ${ALLOWED_ORIGINS.join(', ')}`);
  } else {
    console.log(`> CORS Origins:    * (permissive — set ALLOWED_ORIGINS for production)`);
  }
  console.log(`> Room TTL:        ${ROOM_TTL_MS / 1000}s | Max rooms/IP: ${MAX_ROOMS_PER_IP}`);
  console.log(`=================================================\n`);
});

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Chess } = require('chess.js');
const cors = require('cors');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
const rooms = new Map();

// Helper: HTML sanitization
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Helper: Get local network IPs
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

// AI Engine Evaluation & Minimax
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
      if (ev > maxEval) {
        maxEval = ev;
        bestMove = m;
      }
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
      if (ev < minEval) {
        minEval = ev;
        bestMove = m;
      }
      beta = Math.min(beta, ev);
      if (beta <= alpha) break;
    }
    return { score: minEval, move: bestMove };
  }
}

// Timer Management
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

// REST API for Server Info
app.get('/api/info', (req, res) => {
  res.json({
    status: 'online',
    roomsActive: rooms.size,
    localIps: getLocalIpAddresses()
  });
});

// Socket Rate Limiting & Auth Maps
const rateLimits = new Map(); // socket.id -> { chatCount, lastChat, joinCount, lastJoin }

function checkRateLimit(socketId, type, max, windowMs) {
  const now = Date.now();
  let userLimits = rateLimits.get(socketId);
  if (!userLimits) {
    userLimits = { chat: { count: 0, resetTime: now + windowMs }, join: { count: 0, resetTime: now + windowMs } };
    rateLimits.set(socketId, userLimits);
  }

  const tracker = userLimits[type];
  if (now > tracker.resetTime) {
    tracker.count = 0;
    tracker.resetTime = now + windowMs;
  }
  tracker.count++;
  return tracker.count <= max;
}

// Socket.io Events
io.on('connection', (socket) => {
  let currentRoomId = null;

  socket.on('join_game', ({ roomId, playerName, mode, timeControl, preferredColor, playerToken }) => {
    // Rate limit join attempts (max 12 per minute)
    if (!checkRateLimit(socket.id, 'join', 12, 60000)) {
      return socket.emit('error_message', 'Too many join requests. Please slow down.');
    }

    currentRoomId = roomId ? roomId.trim().toUpperCase() : crypto.randomBytes(3).toString('hex').toUpperCase();
    socket.join(currentRoomId);

    let room = rooms.get(currentRoomId);
    if (!room) {
      const tc = parseInt(timeControl) || 0;
      room = {
        id: currentRoomId,
        chess: new Chess(),
        mode: mode || 'pvp',
        timeControl: tc,
        clocks: { white: tc, black: tc },
        timerInterval: null,
        players: { white: null, black: null },
        spectators: [],
        messages: []
      };
      rooms.set(currentRoomId, room);
    }

    let role = 'spectator';
    let token = playerToken || crypto.randomUUID();
    const cleanName = sanitize((playerName || `Player-${socket.id.substring(0, 4)}`).trim().substring(0, 24));

    if (room.mode === 'ai') {
      room.players.white = { id: socket.id, token, name: cleanName };
      room.players.black = { id: 'ai-bot', token: 'ai-token', name: 'Antigravity AI (Bot)' };
      role = 'white';
    } else {
      // Reconnect by token
      if (room.players.white && room.players.white.token === playerToken) {
        room.players.white.id = socket.id;
        room.players.white.connected = true;
        role = 'white';
        token = room.players.white.token;
      } else if (room.players.black && room.players.black.token === playerToken) {
        room.players.black.id = socket.id;
        room.players.black.connected = true;
        role = 'black';
        token = room.players.black.token;
      } else if (!room.players.white && preferredColor !== 'black') {
        room.players.white = { id: socket.id, token, name: cleanName, connected: true };
        role = 'white';
      } else if (!room.players.black) {
        room.players.black = { id: socket.id, token, name: cleanName, connected: true };
        role = 'black';
      } else if (!room.players.white) {
        room.players.white = { id: socket.id, token, name: cleanName, connected: true };
        role = 'white';
      } else {
        role = 'spectator';
        token = null;
        room.spectators.push({ id: socket.id, name: cleanName });
      }
    }

    // Start timer once both players have joined
    if (room.players.white && room.players.black && room.timeControl > 0 && !room.timerInterval) {
      startClock(room);
    }

    // Sanitize players object for public broadcast (never leak playerToken!)
    const publicPlayers = {
      white: room.players.white ? { name: room.players.white.name, connected: room.players.white.connected } : null,
      black: room.players.black ? { name: room.players.black.name, connected: room.players.black.connected } : null
    };

    // Send private init event with playerToken to the client
    socket.emit('game_init', {
      roomId: room.id,
      role,
      playerToken: token,
      fen: room.chess.fen(),
      pgn: room.chess.pgn(),
      history: room.chess.history({ verbose: true }),
      turn: room.chess.turn() === 'w' ? 'white' : 'black',
      players: publicPlayers,
      clocks: room.clocks,
      timeControl: room.timeControl,
      mode: room.mode,
      inCheck: room.chess.inCheck(),
      isGameOver: room.chess.isGameOver(),
      messages: room.messages.slice(-30)
    });

    // Notify room of player changes
    io.to(room.id).emit('players_update', {
      players: publicPlayers,
      spectatorsCount: room.spectators.length
    });
  });

  socket.on('make_move', ({ roomId, from, to, promotion, playerToken }) => {
    const room = rooms.get(roomId);
    if (!room) return socket.emit('error_message', 'Room not found.');

    const currentTurn = room.chess.turn() === 'w' ? 'white' : 'black';
    const player = room.players[currentTurn];

    // Cryptographic Token & Turn Authorization
    if (room.mode !== 'ai' && (!player || player.token !== playerToken || player.id !== socket.id)) {
      return socket.emit('error_message', 'Unauthorized: Not your turn or invalid player token!');
    }

    try {
      const move = room.chess.move({ from, to, promotion: promotion || 'q' });
      if (!move) return socket.emit('error_message', 'Illegal move.');

      const nextTurn = room.chess.turn() === 'w' ? 'white' : 'black';
      const inCheck = room.chess.inCheck();
      const isGameOver = room.chess.isGameOver();

      let gameOverData = null;
      if (isGameOver) {
        if (room.timerInterval) clearInterval(room.timerInterval);
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
      if (room.mode === 'ai' && nextTurn === 'black' && !isGameOver) {
        setTimeout(() => {
          const aiResult = minimax(room.chess, 2, -Infinity, Infinity, false);
          if (aiResult.move) {
            const aiMove = room.chess.move(aiResult.move);
            const afterAiTurn = room.chess.turn() === 'w' ? 'white' : 'black';
            const aiInCheck = room.chess.inCheck();
            const aiIsGameOver = room.chess.isGameOver();

            let aiGameOverData = null;
            if (aiIsGameOver) {
              let aiWinner = null;
              let aiReason = 'draw';
              if (room.chess.isCheckmate()) {
                aiWinner = 'Black (AI)';
                aiReason = 'checkmate';
              }
              aiGameOverData = { winner: aiWinner, reason: aiReason };
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
        }, 350);
      }
    } catch (err) {
      socket.emit('error_message', `Invalid move: ${err.message}`);
    }
  });

  socket.on('restart_game', ({ roomId, playerToken }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Only active authorized players can restart
    const isWhite = room.players.white && room.players.white.token === playerToken;
    const isBlack = room.players.black && room.players.black.token === playerToken;
    if (!isWhite && !isBlack) {
      return socket.emit('error_message', 'Only active players can restart the game.');
    }

    if (room.timerInterval) clearInterval(room.timerInterval);
    room.chess = new Chess();
    room.clocks = { white: room.timeControl, black: room.timeControl };
    if (room.timeControl > 0) startClock(room);

    io.to(room.id).emit('game_restarted', {
      fen: room.chess.fen(),
      pgn: '',
      turn: 'white',
      clocks: room.clocks
    });
  });

  socket.on('chat_message', ({ roomId, text, sender }) => {
    const room = rooms.get(roomId);
    if (!room) return;

    // Rate limit: max 4 messages per 2 seconds
    if (!checkRateLimit(socket.id, 'chat', 4, 2000)) {
      return socket.emit('error_message', 'You are sending messages too quickly.');
    }

    const cleanText = sanitize(text.trim().substring(0, 200));
    if (!cleanText) return;

    const msg = {
      id: Date.now(),
      sender: sanitize(sender || 'Player').substring(0, 24),
      text: cleanText,
      time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    room.messages.push(msg);
    if (room.messages.length > 50) room.messages.shift();
    io.to(room.id).emit('chat_message', msg);
  });

  socket.on('resign', ({ roomId, playerToken }) => {
    const room = rooms.get(roomId);
    if (!room || room.chess.isGameOver()) return;

    const isWhite = room.players.white && room.players.white.token === playerToken;
    const isBlack = room.players.black && room.players.black.token === playerToken;

    // Reject spectator resignation attempts
    if (!isWhite && !isBlack) {
      return socket.emit('error_message', 'Only active players can resign.');
    }

    if (room.timerInterval) clearInterval(room.timerInterval);
    const winner = isWhite ? 'Black' : 'White';
    io.to(room.id).emit('game_over', {
      winner,
      reason: 'resignation',
      message: `${isWhite ? 'White' : 'Black'} resigned. ${winner} wins! 🏳️`
    });
  });

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

    const publicPlayers = {
      white: room.players.white ? { name: room.players.white.name, connected: room.players.white.connected } : null,
      black: room.players.black ? { name: room.players.black.name, connected: room.players.black.connected } : null
    };

    io.to(room.id).emit('players_update', {
      players: publicPlayers,
      spectatorsCount: room.spectators.length
    });
  });
});

server.listen(PORT, HOST, () => {
  const localIps = getLocalIpAddresses();
  console.log(`\n=================================================`);
  console.log(`♟️  CHESS LIVE SERVER RUNNING (HARDENED & SECURE)!`);
  console.log(`-------------------------------------------------`);
  console.log(`> Local PC:        http://localhost:${PORT}`);
  localIps.forEach(net => {
    console.log(`> On LAN (${net.name}): http://${net.ip}:${PORT}`);
  });
  console.log(`=================================================\n`);
});

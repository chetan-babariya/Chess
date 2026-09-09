// Web Audio Sound Synthesizer
const AudioContext = window.AudioContext || window.webkitAudioContext;
let audioCtx = null;
function playSound(type) {
  try {
    if (!audioCtx) audioCtx = new AudioContext();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    const now = audioCtx.currentTime;
    if (type === 'move') {
      osc.frequency.setValueAtTime(480, now);
      gain.gain.setValueAtTime(0.08, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.08);
      osc.start(now);
      osc.stop(now + 0.08);
    } else if (type === 'capture') {
      osc.frequency.setValueAtTime(650, now);
      osc.frequency.exponentialRampToValueAtTime(320, now + 0.12);
      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
      osc.start(now);
      osc.stop(now + 0.12);
    } else if (type === 'check') {
      osc.frequency.setValueAtTime(750, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
      osc.start(now);
      osc.stop(now + 0.2);
    } else if (type === 'gameover') {
      osc.frequency.setValueAtTime(330, now);
      gain.gain.setValueAtTime(0.12, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.4);
      osc.start(now);
      osc.stop(now + 0.4);
    }
  } catch (e) {}
}

// Unicode Chess Pieces
const SYMBOLS = {
  'P': '♙', 'N': '♘', 'B': '♗', 'R': '♖', 'Q': '♕', 'K': '♔',
  'p': '♟', 'n': '♞', 'b': '♝', 'r': '♜', 'q': '♛', 'k': '♚'
};

// Client State
const socket = io();
let currentRoom = null;
let myRole = 'spectator'; // 'white', 'black', 'spectator'
let playerToken = null; // Secret session token
let myName = '';
let currentTurn = 'white';
let isFlipped = false;
let boardState = null; // 8x8 array
let selectedSq = null;
let lastMove = null;
let inCheck = false;
let isGameOver = false;
let moveHistory = [];
let clocks = { white: 0, black: 0 };
let capturedPieces = { white: [], black: [] };

// FEN Parser
function fenToBoard(fen) {
  const parts = fen.split(' ');
  const rows = parts[0].split('/');
  const b = [];
  for (let r = 0; r < 8; r++) {
    const row = [];
    for (const char of rows[r]) {
      if (!isNaN(char)) {
        const count = parseInt(char, 10);
        for (let i = 0; i < count; i++) row.push(null);
      } else {
        row.push(char);
      }
    }
    b.push(row);
  }
  return b;
}

function squareToAlg(r, c) {
  return ['a','b','c','d','e','f','g','h'][c] + (8 - r);
}

function algToSquare(alg) {
  const file = alg.charCodeAt(0) - 97;
  const rank = 8 - parseInt(alg[1], 10);
  return [rank, file];
}

function formatClock(seconds) {
  if (seconds <= 0 || isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

// Simple Client Legal Move Generator for Instant UI Feedback
function getPieceMoves(r, c) {
  const p = boardState[r][c];
  if (!p) return [];
  const isWhite = p === p.toUpperCase();
  const moves = [];

  // Pawns
  if (p.toLowerCase() === 'p') {
    const dir = isWhite ? -1 : 1;
    const startRow = isWhite ? 6 : 1;
    if (r + dir >= 0 && r + dir < 8 && !boardState[r + dir][c]) {
      moves.push([r + dir, c]);
      if (r === startRow && !boardState[r + 2 * dir][c]) {
        moves.push([r + 2 * dir, c]);
      }
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const target = boardState[nr][nc];
        if (target && (isWhite ? target === target.toLowerCase() : target === target.toUpperCase())) {
          moves.push([nr, nc]);
        }
      }
    }
  }

  // Knights
  if (p.toLowerCase() === 'n') {
    const deltas = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dr, dc] of deltas) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const target = boardState[nr][nc];
        if (!target || (isWhite ? target === target.toLowerCase() : target === target.toUpperCase())) {
          moves.push([nr, nc]);
        }
      }
    }
  }

  // Bishops / Rooks / Queens
  if (['b', 'r', 'q'].includes(p.toLowerCase())) {
    const dirs = [];
    if (['b', 'q'].includes(p.toLowerCase())) dirs.push([-1,-1],[-1,1],[1,-1],[1,1]);
    if (['r', 'q'].includes(p.toLowerCase())) dirs.push([-1,0],[1,0],[0,-1],[0,1]);
    for (const [dr, dc] of dirs) {
      let nr = r + dr, nc = c + dc;
      while (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const target = boardState[nr][nc];
        if (!target) {
          moves.push([nr, nc]);
        } else {
          if (isWhite ? target === target.toLowerCase() : target === target.toUpperCase()) {
            moves.push([nr, nc]);
          }
          break;
        }
        nr += dr; nc += dc;
      }
    }
  }

  // King
  if (p.toLowerCase() === 'k') {
    const dirs = [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]];
    for (const [dr, dc] of dirs) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const target = boardState[nr][nc];
        if (!target || (isWhite ? target === target.toLowerCase() : target === target.toUpperCase())) {
          moves.push([nr, nc]);
        }
      }
    }
    // Simple castling visualization
    if (isWhite && r === 7 && c === 4) {
      if (!boardState[7][5] && !boardState[7][6]) moves.push([7, 6]);
      if (!boardState[7][3] && !boardState[7][2] && !boardState[7][1]) moves.push([7, 2]);
    } else if (!isWhite && r === 0 && c === 4) {
      if (!boardState[0][5] && !boardState[0][6]) moves.push([0, 6]);
      if (!boardState[0][3] && !boardState[0][2] && !boardState[0][1]) moves.push([0, 2]);
    }
  }

  return moves;
}

// Render Board
function renderBoard() {
  const boardEl = document.getElementById('board');
  if (!boardEl || !boardState) return;
  boardEl.innerHTML = '';

  const legalTargets = selectedSq ? getPieceMoves(selectedSq[0], selectedSq[1]) : [];

  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = isFlipped ? 7 - vr : vr;
      const c = isFlipped ? 7 - vc : vc;

      const isLight = (r + c) % 2 === 0;
      const sq = document.createElement('div');
      sq.className = `chess-square ${isLight ? 'sq-light' : 'sq-dark'}`;

      // Highlight selected square
      if (selectedSq && selectedSq[0] === r && selectedSq[1] === c) {
        sq.classList.add('sq-selected');
      }

      // Highlight last move
      if (lastMove && ((lastMove.from[0] === r && lastMove.from[1] === c) || (lastMove.to[0] === r && lastMove.to[1] === c))) {
        sq.classList.add('sq-last-move');
      }

      const piece = boardState[r][c];

      // Highlight King in check
      if (inCheck && piece && piece.toLowerCase() === 'k') {
        const isKingTurn = (currentTurn === 'white' && piece === 'K') || (currentTurn === 'black' && piece === 'k');
        if (isKingTurn) sq.classList.add('sq-check');
      }

      // Render Piece
      if (piece) {
        const span = document.createElement('span');
        span.className = piece === piece.toUpperCase() ? 'piece-w' : 'piece-b';
        span.textContent = SYMBOLS[piece] || piece;
        sq.appendChild(span);
      }

      // Render Legal Move Hints
      const isLegal = legalTargets.some(t => t[0] === r && t[1] === c);
      if (isLegal) {
        const hint = document.createElement('div');
        hint.className = piece ? 'capture-ring' : 'move-dot';
        sq.appendChild(hint);
      }

      sq.onclick = () => onSquareClick(r, c);
      boardEl.appendChild(sq);
    }
  }

  // Update clocks display
  updateClockDisplay();
}

function onSquareClick(r, c) {
  if (isGameOver) return;
  if (myRole !== 'spectator' && myRole !== currentTurn) return;

  const piece = boardState[r][c];
  const isMyPiece = piece && (myRole === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase());

  // If a piece is already selected, check if this is a move target
  if (selectedSq) {
    const legals = getPieceMoves(selectedSq[0], selectedSq[1]);
    const isTarget = legals.some(t => t[0] === r && t[1] === c);

    if (isTarget) {
      const fromAlg = squareToAlg(selectedSq[0], selectedSq[1]);
      const toAlg = squareToAlg(r, c);

      // Pawn promotion check
      let promotion = undefined;
      const movedPiece = boardState[selectedSq[0]][selectedSq[1]];
      if (movedPiece === 'P' && r === 0) promotion = 'q';
      if (movedPiece === 'p' && r === 7) promotion = 'q';

      socket.emit('make_move', {
        roomId: currentRoom,
        from: fromAlg,
        to: toAlg,
        promotion,
        playerToken
      });

      selectedSq = null;
      renderBoard();
      return;
    }
  }

  // Select piece
  if (isMyPiece) {
    selectedSq = [r, c];
    playSound('move');
  } else {
    selectedSq = null;
  }
  renderBoard();
}

function updateClockDisplay() {
  const pClock = document.getElementById('player-clock');
  const oClock = document.getElementById('opp-clock');
  if (pClock) pClock.textContent = formatClock(myRole === 'black' ? clocks.black : clocks.white);
  if (oClock) oClock.textContent = formatClock(myRole === 'black' ? clocks.white : clocks.black);
}

function updateStatusMessage() {
  const badge = document.getElementById('room-code-badge');
  const msg = document.getElementById('status-message');
  if (badge) badge.textContent = `ROOM: ${currentRoom}`;

  if (isGameOver) return;

  if (myRole === 'spectator') {
    msg.textContent = `${currentTurn.toUpperCase()} to move (Spectating)`;
  } else if (myRole === currentTurn) {
    msg.textContent = inCheck ? '⚠️ CHECK! Your turn to defend!' : 'Your turn to move!';
  } else {
    msg.textContent = `Opponent (${currentTurn}) is thinking...`;
  }
}

// Socket Event Handlers
socket.on('connect', () => {
  document.getElementById('conn-text').textContent = 'Online';
});

socket.on('disconnect', () => {
  document.getElementById('conn-text').textContent = 'Disconnected';
});

socket.on('game_init', (data) => {
  currentRoom = data.roomId;
  myRole = data.role;
  playerToken = data.playerToken;
  if (playerToken) {
    sessionStorage.setItem('chess_player_token_' + currentRoom, playerToken);
  }
  currentTurn = data.turn;
  boardState = fenToBoard(data.fen);
  clocks = data.clocks || { white: data.timeControl, black: data.timeControl };
  inCheck = data.inCheck;
  isGameOver = data.isGameOver;

  if (myRole === 'black') isFlipped = true;

  // Switch screens
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('nav-share-btn').classList.remove('hidden');

  // Update Profile cards
  document.getElementById('player-name').textContent = myName || 'You';
  document.getElementById('player-role-label').textContent = myRole.toUpperCase();
  document.getElementById('player-avatar').textContent = myRole === 'white' ? '⚪' : '⚫';

  updatePlayersUI(data.players);
  updateStatusMessage();
  renderBoard();

  // Load chat messages
  const chatBox = document.getElementById('chat-messages');
  chatBox.innerHTML = '';
  if (data.messages) {
    data.messages.forEach(m => appendChatMessage(m));
  }
});

socket.on('players_update', (data) => {
  updatePlayersUI(data.players);
});

function updatePlayersUI(players) {
  if (!players) return;
  const opp = myRole === 'white' ? players.black : players.white;
  const oppNameEl = document.getElementById('opp-name');
  const oppRoleEl = document.getElementById('opp-role-label');
  const oppAvatarEl = document.getElementById('opp-avatar');

  if (opp) {
    oppNameEl.textContent = opp.name || 'Opponent';
    oppRoleEl.textContent = (myRole === 'white' ? 'Black' : 'White') + (opp.connected ? ' • Online' : ' • Offline');
  } else {
    oppNameEl.textContent = 'Waiting for opponent...';
    oppRoleEl.textContent = 'Share invite link';
  }
  oppAvatarEl.textContent = myRole === 'white' ? '⚫' : '⚪';
}

socket.on('move_made', (data) => {
  boardState = fenToBoard(data.fen);
  currentTurn = data.turn;
  inCheck = data.inCheck;
  isGameOver = data.isGameOver;
  clocks = data.clocks || clocks;

  const fromSq = algToSquare(data.move.from);
  const toSq = algToSquare(data.move.to);
  lastMove = { from: fromSq, to: toSq };

  // Sound effects
  if (data.isGameOver) {
    playSound('gameover');
  } else if (data.inCheck) {
    playSound('check');
  } else if (data.move.captured) {
    playSound('capture');
  } else {
    playSound('move');
  }

  // Record notation
  appendMoveNotation(data.move.san);
  updateStatusMessage();
  renderBoard();

  if (data.isGameOver && data.gameOverData) {
    const text = data.gameOverData.winner
      ? `Checkmate! ${data.gameOverData.winner} wins!`
      : `Game Drawn by ${data.gameOverData.reason}!`;
    document.getElementById('status-message').textContent = text;
    alert(text);
  }
});

socket.on('clock_update', (newClocks) => {
  clocks = newClocks;
  updateClockDisplay();
});

socket.on('game_restarted', (data) => {
  boardState = fenToBoard(data.fen);
  currentTurn = data.turn;
  clocks = data.clocks;
  lastMove = null;
  selectedSq = null;
  isGameOver = false;
  inCheck = false;
  moveHistory = [];
  document.getElementById('moves-tbody').innerHTML = '';
  document.getElementById('move-count-label').textContent = '0 moves';
  updateStatusMessage();
  renderBoard();
  playSound('move');
});

socket.on('game_over', (data) => {
  isGameOver = true;
  document.getElementById('status-message').textContent = data.message || `Game Over: ${data.winner} wins!`;
  playSound('gameover');
  alert(data.message || `Game Over!`);
});

socket.on('chat_message', (msg) => {
  appendChatMessage(msg);
});

socket.on('error_message', (msg) => {
  alert(msg);
});

// UI Actions
function switchLobbyTab(tab) {
  const pvpTab = document.getElementById('tab-content-pvp');
  const aiTab = document.getElementById('tab-content-ai');
  const btnPvp = document.getElementById('tab-btn-pvp');
  const btnAi = document.getElementById('tab-btn-ai');

  if (tab === 'pvp') {
    pvpTab.classList.remove('hidden');
    aiTab.classList.add('hidden');
    btnPvp.className = 'py-1.5 text-xs font-semibold rounded-lg bg-indigo-600 text-white transition';
    btnAi.className = 'py-1.5 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition';
  } else {
    pvpTab.classList.add('hidden');
    aiTab.classList.remove('hidden');
    btnAi.className = 'py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white transition';
    btnPvp.className = 'py-1.5 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition';
  }
}

function createRoom() {
  myName = document.getElementById('player-name-input').value.trim() || 'Player 1';
  const timeControl = document.getElementById('time-control-select').value;

  socket.emit('join_game', {
    playerName: myName,
    mode: 'pvp',
    timeControl: parseInt(timeControl)
  });
}

function joinRoomByCode() {
  const code = document.getElementById('join-room-input').value.trim().toUpperCase();
  if (!code) return alert('Please enter a room code');
  myName = document.getElementById('player-name-input').value.trim() || 'Player 2';
  const savedToken = sessionStorage.getItem('chess_player_token_' + code);

  socket.emit('join_game', {
    roomId: code,
    playerName: myName,
    mode: 'pvp',
    playerToken: savedToken
  });
}

function startAiGame() {
  myName = document.getElementById('player-name-input').value.trim() || 'Player';

  socket.emit('join_game', {
    playerName: myName,
    mode: 'ai',
    timeControl: 0
  });
}

function flipBoard() {
  isFlipped = !isFlipped;
  renderBoard();
}

function requestRestart() {
  if (confirm('Start a new game in this room?')) {
    socket.emit('restart_game', { roomId: currentRoom, playerToken });
  }
}

function confirmResign() {
  if (confirm('Are you sure you want to resign?')) {
    socket.emit('resign', { roomId: currentRoom, playerToken });
  }
}

function copyInviteLink() {
  const url = `${window.location.origin}/?room=${currentRoom}`;
  navigator.clipboard.writeText(url).then(() => {
    alert(`Invite Link copied!\n${url}\nShare this link with your friend on the same network!`);
  }).catch(() => {
    prompt('Copy this link to invite a friend:', url);
  });
}

function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  socket.emit('chat_message', {
    roomId: currentRoom,
    text,
    sender: myName || 'Player'
  });
  input.value = '';
}

function appendChatMessage(msg) {
  const chatBox = document.getElementById('chat-messages');
  const div = document.createElement('div');
  div.className = 'flex flex-col bg-slate-950/70 p-1.5 rounded-lg border border-slate-800/80';
  div.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-slate-400 mb-0.5">
      <span class="font-bold text-indigo-400">${msg.sender}</span>
      <span>${msg.time}</span>
    </div>
    <div class="text-slate-200 text-xs break-words">${msg.text}</div>
  `;
  chatBox.appendChild(div);
  chatBox.scrollTop = chatBox.scrollHeight;
}

function appendMoveNotation(san) {
  const tbody = document.getElementById('moves-tbody');
  const total = moveHistory.length;

  if (currentTurn === 'black') {
    moveHistory.push({ num: total + 1, w: san, b: '' });
    const tr = document.createElement('tr');
    tr.className = 'hover:bg-slate-800/40';
    tr.innerHTML = `
      <td class="py-1 px-2 text-slate-500 w-8">${total + 1}.</td>
      <td class="py-1 px-2 font-bold text-indigo-300">${san}</td>
      <td class="py-1 px-2 text-slate-300" id="hist-b-${total + 1}">...</td>
    `;
    tbody.appendChild(tr);
  } else {
    if (total > 0) {
      moveHistory[total - 1].b = san;
      const cell = document.getElementById(`hist-b-${total}`);
      if (cell) cell.textContent = san;
    }
  }
  document.getElementById('move-count-label').textContent = `${moveHistory.length} moves`;
  const scrollEl = document.getElementById('moves-scroll');
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

// Auto-populate URL room parameter & LAN IP hint
window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const input = document.getElementById('join-room-input');
    if (input) input.value = roomParam.toUpperCase();
  }

  fetch('/api/info').then(res => res.json()).then(data => {
    if (data.localIps && data.localIps.length > 0) {
      const wifiIp = data.localIps.find(i => i.name.toLowerCase().includes('wi-fi')) || data.localIps[0];
      const hint = document.getElementById('lan-ip-hint');
      if (hint) hint.textContent = `http://${wifiIp.ip}:${window.location.port || 3000}`;
    }
  }).catch(() => {});
});

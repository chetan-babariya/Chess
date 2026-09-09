// ─── Web Audio Sound Synthesizer ───────────────────────────────────────────────
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

// ─── Unicode Chess Pieces ─────────────────────────────────────────────────────
const SYMBOLS = {
  'P': '♙', 'N': '♘', 'B': '♗', 'R': '♖', 'Q': '♕', 'K': '♔',
  'p': '♟', 'n': '♞', 'b': '♝', 'r': '♜', 'q': '♛', 'k': '♚'
};

const PIECE_VALS = { 'p': 1, 'n': 3, 'b': 3, 'r': 5, 'q': 9, 'k': 0 };

// ─── Client State ─────────────────────────────────────────────────────────────
const socket = io();
let currentRoom = null;
let myRole = 'spectator'; // 'white', 'black', 'spectator'
let playerToken = null; // Secret session token
let myName = '';
let currentTurn = 'white';
let isFlipped = false;
let boardState = null; // 8x8 authoritative board array
let selectedSq = null;
let lastMove = null;
let inCheck = false;
let isGameOver = false;
let moveHistory = [];
let clocks = { white: 0, black: 0 };
let currentFen = '';
let currentPgn = '';
let pendingPromotion = null;
let currentPlayers = { white: null, black: null };

// ─── Premove System State (chess.com-style) ───────────────────────────────────
const PREMOVE_SETTINGS_KEYS = {
  enabled: 'chess_premove_enabled',
  mode: 'chess_premove_mode',
  promo: 'chess_premove_promo'
};

let premoveSettings = {
  enabled: true,
  mode: 'unlimited', // 'single' or 'unlimited'
  promo: 'q'        // 'q', 'r', 'b', 'n'
};

let premoveQueue = [];      // [{ from: [r,c], to: [r,c], fromAlg, toAlg, promotion, piece }]
let virtualBoardState = null; // Virtual 8x8 board with client-queued moves applied
let premoveSelectedSq = null; // Selected piece during opponent's turn

function loadPremoveSettings() {
  const savedEnabled = localStorage.getItem(PREMOVE_SETTINGS_KEYS.enabled);
  if (savedEnabled !== null) {
    premoveSettings.enabled = (savedEnabled === 'true');
  }
  const savedMode = localStorage.getItem(PREMOVE_SETTINGS_KEYS.mode);
  if (savedMode === 'single' || savedMode === 'unlimited') {
    premoveSettings.mode = savedMode;
  }
  const savedPromo = localStorage.getItem(PREMOVE_SETTINGS_KEYS.promo);
  if (['q', 'r', 'b', 'n'].includes(savedPromo)) {
    premoveSettings.promo = savedPromo;
  }

  // Update modal controls
  const toggleEl = document.getElementById('setting-premove-enabled');
  if (toggleEl) toggleEl.checked = premoveSettings.enabled;

  const modeRadios = document.querySelectorAll('input[name="premove-mode"]');
  modeRadios.forEach(r => {
    r.checked = (r.value === premoveSettings.mode);
  });

  const promoEl = document.getElementById('setting-default-promo');
  if (promoEl) promoEl.value = premoveSettings.promo;
}

function openSettingsModal() {
  loadPremoveSettings();
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.remove('hidden');
}

function closeSettingsModal() {
  const modal = document.getElementById('settings-modal');
  if (modal) modal.classList.add('hidden');
}

function saveSettingsModal() {
  const toggleEl = document.getElementById('setting-premove-enabled');
  if (toggleEl) premoveSettings.enabled = toggleEl.checked;

  const checkedMode = document.querySelector('input[name="premove-mode"]:checked');
  if (checkedMode) premoveSettings.mode = checkedMode.value;

  const promoEl = document.getElementById('setting-default-promo');
  if (promoEl) premoveSettings.promo = promoEl.value;

  localStorage.setItem(PREMOVE_SETTINGS_KEYS.enabled, premoveSettings.enabled);
  localStorage.setItem(PREMOVE_SETTINGS_KEYS.mode, premoveSettings.mode);
  localStorage.setItem(PREMOVE_SETTINGS_KEYS.promo, premoveSettings.promo);

  closeSettingsModal();
  showToast('Settings saved.', 'success', 2000);
}

function selectHostColor(color, btn, mode) {
  const inputId = mode === 'pvp' ? 'pvp-color-val' : 'ai-color-val';
  const containerId = mode === 'pvp' ? 'pvp-color-picker' : 'ai-color-picker';
  const input = document.getElementById(inputId);
  if (input) input.value = color;

  const container = document.getElementById(containerId);
  if (container) {
    const btns = container.querySelectorAll('.color-btn');
    btns.forEach(b => {
      b.className = 'color-btn p-2 rounded-xl border border-slate-800 bg-slate-950 text-center hover:border-slate-700 transition cursor-pointer flex flex-col items-center justify-center gap-1';
      const label = b.querySelector('span:last-child');
      if (label) label.className = 'text-xs font-bold text-slate-300';
    });
  }

  const activeColorClass = mode === 'pvp' ? 'border-indigo-500/50 bg-indigo-600/20' : 'border-emerald-500/50 bg-emerald-600/20';
  const activeTextClass = mode === 'pvp' ? 'text-indigo-300' : 'text-emerald-300';
  btn.className = `color-btn active p-2 rounded-xl border ${activeColorClass} text-center transition cursor-pointer flex flex-col items-center justify-center gap-1`;
  const activeLabel = btn.querySelector('span:last-child');
  if (activeLabel) activeLabel.className = `text-xs font-bold ${activeTextClass}`;
}

// ─── Toast Notifications Manager (Fix #5) ─────────────────────────────────────
function showToast(message, type = 'info', duration = 3500) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const icons = {
    info: 'ℹ️',
    success: '✅',
    warning: '⚠️',
    error: '❌'
  };
  const borders = {
    info: 'border-slate-700 bg-slate-900/95 text-slate-100',
    success: 'border-emerald-500/40 bg-slate-900/95 text-emerald-200',
    warning: 'border-amber-500/40 bg-slate-900/95 text-amber-200',
    error: 'border-rose-500/40 bg-slate-900/95 text-rose-200'
  };

  toast.className = `toast-item flex items-center gap-2.5 px-3.5 py-2.5 rounded-xl border shadow-2xl backdrop-blur-md text-xs font-medium ${borders[type] || borders.info}`;
  toast.innerHTML = `
    <span class="text-base flex-shrink-0">${icons[type] || 'ℹ️'}</span>
    <span class="flex-1 leading-snug break-words">${message}</span>
    <button class="opacity-60 hover:opacity-100 transition ml-1 text-sm font-bold flex-shrink-0 cursor-pointer p-0.5 leading-none" aria-label="Dismiss">×</button>
  `;

  const closeBtn = toast.querySelector('button');
  closeBtn.onclick = () => dismissToast(toast);
  container.appendChild(toast);

  const timer = setTimeout(() => dismissToast(toast), duration);
  toast._timer = timer;
}

function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._timer);
  toast.classList.add('toast-out');
  setTimeout(() => toast.remove(), 220);
}

// ─── Accessible Modal Dialog Manager (Fix #5 & #7) ────────────────────────────
function showModal({ title, message, icon = 'ℹ️', confirmText = 'Confirm', cancelText = 'Cancel', onConfirm, onCancel, destructive = false }) {
  const container = document.getElementById('modal-container');
  const titleEl = document.getElementById('modal-title');
  const msgEl = document.getElementById('modal-message');
  const iconEl = document.getElementById('modal-icon');
  const confirmBtn = document.getElementById('modal-confirm-btn');
  const cancelBtn = document.getElementById('modal-cancel-btn');

  if (!container) return;

  titleEl.textContent = title;
  msgEl.textContent = message;
  iconEl.textContent = icon;

  confirmBtn.textContent = confirmText;
  if (destructive) {
    confirmBtn.className = 'flex-1 py-2.5 rounded-xl bg-rose-600 hover:bg-rose-500 active:scale-95 text-xs font-bold text-white transition cursor-pointer shadow-lg shadow-rose-600/25';
  } else {
    confirmBtn.className = 'flex-1 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 active:scale-95 text-xs font-bold text-white transition cursor-pointer shadow-lg shadow-indigo-600/25';
  }

  if (cancelText) {
    cancelBtn.classList.remove('hidden');
    cancelBtn.textContent = cancelText;
  } else {
    cancelBtn.classList.add('hidden');
  }

  container.classList.remove('hidden');
  confirmBtn.focus();

  const closeModal = () => {
    container.classList.add('hidden');
    document.removeEventListener('keydown', handleKeyDown);
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') {
      closeModal();
      if (onCancel) onCancel();
    }
  };
  document.addEventListener('keydown', handleKeyDown);

  confirmBtn.onclick = () => {
    closeModal();
    if (onConfirm) onConfirm();
  };

  cancelBtn.onclick = () => {
    closeModal();
    if (onCancel) onCancel();
  };
}

// ─── FEN & Coordinate Utilities ───────────────────────────────────────────────
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

function getEnPassantTarget() {
  if (!currentFen) return null;
  const parts = currentFen.split(' ');
  if (parts.length < 4 || parts[3] === '-') return null;
  return algToSquare(parts[3]);
}

// ─── Captured Pieces & Material Calculation ───────────────────────────────────
function updateCapturedPieces() {
  if (!boardState) return;

  const initialCount = {
    w: { 'P': 8, 'N': 2, 'B': 2, 'R': 2, 'Q': 1 },
    b: { 'p': 8, 'n': 2, 'b': 2, 'r': 2, 'q': 1 }
  };

  const activeCount = {
    w: { 'P': 0, 'N': 0, 'B': 0, 'R': 0, 'Q': 0 },
    b: { 'p': 0, 'n': 0, 'b': 0, 'r': 0, 'q': 0 }
  };

  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      const p = boardState[r][c];
      if (!p || p.toLowerCase() === 'k') continue;
      if (p === p.toUpperCase()) {
        activeCount.w[p] = (activeCount.w[p] || 0) + 1;
      } else {
        activeCount.b[p] = (activeCount.b[p] || 0) + 1;
      }
    }
  }

  // Pieces captured by White (missing Black pieces)
  const capturedByWhite = [];
  let whiteMaterialPoints = 0;
  for (const [type, init] of Object.entries(initialCount.b)) {
    const active = activeCount.b[type] || 0;
    const missing = Math.max(0, init - active);
    for (let i = 0; i < missing; i++) {
      capturedByWhite.push(type);
      whiteMaterialPoints += PIECE_VALS[type] || 0;
    }
  }

  // Pieces captured by Black (missing White pieces)
  const capturedByBlack = [];
  let blackMaterialPoints = 0;
  for (const [type, init] of Object.entries(initialCount.w)) {
    const active = activeCount.w[type] || 0;
    const missing = Math.max(0, init - active);
    for (let i = 0; i < missing; i++) {
      capturedByBlack.push(type);
      blackMaterialPoints += PIECE_VALS[type.toLowerCase()] || 0;
    }
  }

  // Render to player / opp trays based on role
  const isWhite = (myRole !== 'black');
  const myTrayEl = document.getElementById('player-captured');
  const oppTrayEl = document.getElementById('opp-captured');
  const myAdvEl = document.getElementById('player-advantage');
  const oppAdvEl = document.getElementById('opp-advantage');

  const myCaptured = isWhite ? capturedByWhite : capturedByBlack;
  const oppCaptured = isWhite ? capturedByBlack : capturedByWhite;
  const myPoints = isWhite ? whiteMaterialPoints : blackMaterialPoints;
  const oppPoints = isWhite ? blackMaterialPoints : whiteMaterialPoints;

  renderTray(myTrayEl, myCaptured);
  renderTray(oppTrayEl, oppCaptured);

  if (myAdvEl && oppAdvEl) {
    const diff = myPoints - oppPoints;
    if (diff > 0) {
      myAdvEl.textContent = `+${diff}`;
      myAdvEl.classList.remove('hidden');
      oppAdvEl.classList.add('hidden');
    } else if (diff < 0) {
      oppAdvEl.textContent = `+${Math.abs(diff)}`;
      oppAdvEl.classList.remove('hidden');
      myAdvEl.classList.add('hidden');
    } else {
      myAdvEl.classList.add('hidden');
      oppAdvEl.classList.add('hidden');
    }
  }
}

function renderTray(el, pieceTypes) {
  if (!el) return;
  el.innerHTML = '';
  // Order: Q, R, B, N, P
  const order = ['q', 'r', 'b', 'n', 'p'];
  pieceTypes.sort((a, b) => order.indexOf(a.toLowerCase()) - order.indexOf(b.toLowerCase()));
  for (const p of pieceTypes) {
    const span = document.createElement('span');
    span.className = 'captured-piece-mini ' + (p === p.toUpperCase() ? 'piece-w' : 'piece-b');
    span.textContent = SYMBOLS[p] || p;
    el.appendChild(span);
  }
}

// ─── Premove & Virtual Board Helpers ──────────────────────────────────────────
function getActiveBoard() {
  return virtualBoardState || boardState;
}

function applyMoveToVirtualBoard(fromR, fromC, toR, toC, promo) {
  if (!virtualBoardState) {
    virtualBoardState = boardState.map(row => [...row]);
  }
  const p = virtualBoardState[fromR][fromC];
  if (!p) return;

  // Castling
  if (p.toLowerCase() === 'k' && Math.abs(toC - fromC) === 2) {
    if (toC === 6) { // Kingside
      virtualBoardState[fromR][5] = virtualBoardState[fromR][7];
      virtualBoardState[fromR][7] = null;
    } else if (toC === 2) { // Queenside
      virtualBoardState[fromR][3] = virtualBoardState[fromR][0];
      virtualBoardState[fromR][0] = null;
    }
  }

  // En Passant
  if (p.toLowerCase() === 'p' && fromC !== toC && !virtualBoardState[toR][toC]) {
    virtualBoardState[fromR][toC] = null;
  }

  // Move piece & handle pawn promotion
  if (promo && p.toLowerCase() === 'p' && (toR === 0 || toR === 7)) {
    virtualBoardState[toR][toC] = (p === p.toUpperCase()) ? promo.toUpperCase() : promo.toLowerCase();
  } else {
    virtualBoardState[toR][toC] = p;
  }
  virtualBoardState[fromR][fromC] = null;
}

function rebuildVirtualBoard() {
  if (premoveQueue.length === 0) {
    virtualBoardState = null;
    return;
  }
  virtualBoardState = boardState.map(row => [...row]);
  for (const pm of premoveQueue) {
    applyMoveToVirtualBoard(pm.from[0], pm.from[1], pm.to[0], pm.to[1], pm.promotion);
  }
}

function cancelPremoves() {
  premoveQueue = [];
  virtualBoardState = null;
  premoveSelectedSq = null;
  renderBoard();
}

function handlePremoveClick(r, c) {
  const activeBoard = getActiveBoard();
  if (!activeBoard) return;
  const piece = activeBoard[r][c];
  const isMyPiece = piece && (myRole === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase());

  if (premoveSelectedSq) {
    // Clicking same square cancels selection
    if (premoveSelectedSq[0] === r && premoveSelectedSq[1] === c) {
      premoveSelectedSq = null;
      renderBoard();
      return;
    }

    const legals = getPieceMoves(premoveSelectedSq[0], premoveSelectedSq[1], activeBoard);
    const isTarget = legals.some(t => t[0] === r && t[1] === c);

    if (isTarget) {
      if (premoveSettings.mode === 'single') {
        premoveQueue = [];
        virtualBoardState = null;
      }

      const curBoard = getActiveBoard();
      const movingPiece = curBoard[premoveSelectedSq[0]][premoveSelectedSq[1]];
      const isPawn = movingPiece && movingPiece.toLowerCase() === 'p';
      const isPromotion = isPawn && (r === 0 || r === 7);
      const promo = isPromotion ? (premoveSettings.promo || 'q') : undefined;

      const fromAlg = squareToAlg(premoveSelectedSq[0], premoveSelectedSq[1]);
      const toAlg = squareToAlg(r, c);

      premoveQueue.push({
        from: [premoveSelectedSq[0], premoveSelectedSq[1]],
        to: [r, c],
        fromAlg,
        toAlg,
        promotion: promo,
        piece: movingPiece
      });

      applyMoveToVirtualBoard(premoveSelectedSq[0], premoveSelectedSq[1], r, c, promo);
      premoveSelectedSq = null;
      playSound('move');
      renderBoard();
      return;
    }

    // Reselect another piece
    if (isMyPiece) {
      premoveSelectedSq = [r, c];
      playSound('move');
      renderBoard();
      return;
    }

    // Click on destination of queued premove cancels that premove
    const clickedPremoveIndex = premoveQueue.findIndex(pm => pm.to[0] === r && pm.to[1] === c);
    if (clickedPremoveIndex !== -1) {
      premoveQueue.splice(clickedPremoveIndex, 1);
      rebuildVirtualBoard();
      premoveSelectedSq = null;
      renderBoard();
      return;
    }

    premoveSelectedSq = null;
    renderBoard();
    return;
  }

  // No piece selected yet
  if (isMyPiece) {
    premoveSelectedSq = [r, c];
    playSound('move');
    renderBoard();
  } else {
    const clickedPremoveIndex = premoveQueue.findIndex(pm => pm.to[0] === r && pm.to[1] === c);
    if (clickedPremoveIndex !== -1) {
      premoveQueue.splice(clickedPremoveIndex, 1);
      rebuildVirtualBoard();
      renderBoard();
    }
  }
}

function executeNextPremove() {
  if (premoveQueue.length === 0 || currentTurn !== myRole || isGameOver) {
    virtualBoardState = null;
    renderBoard();
    return;
  }

  const next = premoveQueue.shift();
  // Validate move against authoritative boardState
  const legalMoves = getPieceMoves(next.from[0], next.from[1], boardState);
  const isLegal = legalMoves.some(t => t[0] === next.to[0] && t[1] === next.to[1]);

  if (isLegal) {
    rebuildVirtualBoard();
    renderBoard();

    const movingPiece = boardState[next.from[0]][next.from[1]];
    const isPawn = movingPiece && movingPiece.toLowerCase() === 'p';
    const isPromotion = isPawn && (next.to[0] === 0 || next.to[0] === 7);
    const promo = isPromotion ? (next.promotion || premoveSettings.promo || 'q') : undefined;

    socket.emit('make_move', {
      roomId: currentRoom,
      from: next.fromAlg,
      to: next.toAlg,
      promotion: promo,
      playerToken
    });
  } else {
    // Silent discard per chess.com rules
    cancelPremoves();
  }
}

// ─── Legal Move Generator (UI hints) ──────────────────────────────────────────
function getPieceMoves(r, c, bState = getActiveBoard()) {
  if (!bState) return [];
  const p = bState[r][c];
  if (!p) return [];
  const isWhite = p === p.toUpperCase();
  const moves = [];

  // Pawns
  if (p.toLowerCase() === 'p') {
    const dir = isWhite ? -1 : 1;
    const startRow = isWhite ? 6 : 1;
    if (r + dir >= 0 && r + dir < 8 && !bState[r + dir][c]) {
      moves.push([r + dir, c]);
      if (r === startRow && !bState[r + 2 * dir][c]) {
        moves.push([r + 2 * dir, c]);
      }
    }
    for (const dc of [-1, 1]) {
      const nr = r + dir, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const target = bState[nr][nc];
        if (target && (isWhite ? target === target.toLowerCase() : target === target.toUpperCase())) {
          moves.push([nr, nc]);
        }
      }
    }
    // En Passant
    const epTarget = getEnPassantTarget();
    if (epTarget) {
      const [epR, epC] = epTarget;
      if (epR === r + dir && Math.abs(epC - c) === 1) {
        moves.push([epR, epC]);
      }
    }
  }

  // Knights
  if (p.toLowerCase() === 'n') {
    const deltas = [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]];
    for (const [dr, dc] of deltas) {
      const nr = r + dr, nc = c + dc;
      if (nr >= 0 && nr < 8 && nc >= 0 && nc < 8) {
        const target = bState[nr][nc];
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
        const target = bState[nr][nc];
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
        const target = bState[nr][nc];
        if (!target || (isWhite ? target === target.toLowerCase() : target === target.toUpperCase())) {
          moves.push([nr, nc]);
        }
      }
    }
    // Castling hints
    if (isWhite && r === 7 && c === 4) {
      if (!bState[7][5] && !bState[7][6]) moves.push([7, 6]);
      if (!bState[7][3] && !bState[7][2] && !bState[7][1]) moves.push([7, 2]);
    } else if (!isWhite && r === 0 && c === 4) {
      if (!bState[0][5] && !bState[0][6]) moves.push([0, 6]);
      if (!bState[0][3] && !bState[0][2] && !bState[0][1]) moves.push([0, 2]);
    }
  }

  return moves;
}

// ─── Pawn Promotion Picker Modal (Fix #14) ────────────────────────────────────
function showPromotionModal(fromAlg, toAlg, isWhitePiece) {
  pendingPromotion = { from: fromAlg, to: toAlg };

  let overlay = document.getElementById('promo-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.id = 'promo-overlay';
  overlay.className = 'fixed inset-0 z-50 bg-black/75 flex items-center justify-center backdrop-blur-sm modal-backdrop';

  const pieces = [
    { type: 'q', symbol: isWhitePiece ? '♕' : '♛', label: 'Queen' },
    { type: 'r', symbol: isWhitePiece ? '♖' : '♜', label: 'Rook' },
    { type: 'b', symbol: isWhitePiece ? '♗' : '♝', label: 'Bishop' },
    { type: 'n', symbol: isWhitePiece ? '♘' : '♞', label: 'Knight' },
  ];

  const box = document.createElement('div');
  box.className = 'bg-slate-900 border border-slate-700/80 rounded-2xl p-6 shadow-2xl text-center max-w-xs w-full modal-content';
  box.innerHTML = `
    <div class="text-sm font-bold text-slate-100 mb-1">Promote Pawn</div>
    <div class="text-[11px] text-slate-400 mb-4">Choose a piece to replace your pawn</div>
    <div class="flex gap-2.5 justify-center mb-4"></div>
  `;

  const row = box.querySelector('div:nth-child(3)');
  for (const p of pieces) {
    const btn = document.createElement('button');
    btn.className = 'w-14 h-14 rounded-xl bg-slate-800/90 hover:bg-indigo-600 border border-slate-700 hover:border-indigo-400 active:scale-95 flex items-center justify-center text-3xl transition cursor-pointer shadow-sm ' + (isWhitePiece ? 'piece-w' : 'piece-b');
    btn.textContent = p.symbol;
    btn.title = p.label;
    btn.onclick = () => {
      overlay.remove();
      sendMoveWithPromotion(pendingPromotion.from, pendingPromotion.to, p.type);
      pendingPromotion = null;
    };
    row.appendChild(btn);
  }

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'w-full py-2 text-xs font-semibold text-slate-400 hover:text-white transition cursor-pointer';
  cancelBtn.textContent = 'Cancel Move';
  cancelBtn.onclick = () => {
    overlay.remove();
    pendingPromotion = null;
    selectedSq = null;
    renderBoard();
  };
  box.appendChild(cancelBtn);

  overlay.appendChild(box);
  document.body.appendChild(overlay);
}

function sendMoveWithPromotion(fromAlg, toAlg, promotion) {
  socket.emit('make_move', {
    roomId: currentRoom,
    from: fromAlg,
    to: toAlg,
    promotion,
    playerToken
  });
  selectedSq = null;
  renderBoard();
}

// ─── Board Rendering & Smooth Piece Movement ──────────────────────────────────
function renderBoard() {
  const boardEl = document.getElementById('board');
  if (!boardEl || !boardState) return;
  boardEl.innerHTML = '';

  const activeBoard = getActiveBoard();
  const isMyTurn = (myRole !== 'spectator' && myRole === currentTurn && !isGameOver);
  const canPremove = (myRole !== 'spectator' && myRole !== currentTurn && !isGameOver && premoveSettings.enabled);

  // Calculate move hints
  let legalTargets = [];
  if (isMyTurn && selectedSq) {
    legalTargets = getPieceMoves(selectedSq[0], selectedSq[1], activeBoard);
  } else if (canPremove && premoveSelectedSq) {
    legalTargets = getPieceMoves(premoveSelectedSq[0], premoveSelectedSq[1], activeBoard);
  }

  for (let vr = 0; vr < 8; vr++) {
    for (let vc = 0; vc < 8; vc++) {
      const r = isFlipped ? 7 - vr : vr;
      const c = isFlipped ? 7 - vc : vc;

      const isLight = (r + c) % 2 === 0;
      const sq = document.createElement('div');
      sq.className = `chess-square ${isLight ? 'sq-light' : 'sq-dark'}`;
      sq.dataset.r = r;
      sq.dataset.c = c;

      // Normal turn selected square highlight
      if (selectedSq && selectedSq[0] === r && selectedSq[1] === c) {
        sq.classList.add('sq-selected');
      }

      // Premove source highlight (currently selected piece or queued moves)
      if (premoveSelectedSq && premoveSelectedSq[0] === r && premoveSelectedSq[1] === c) {
        sq.classList.add('sq-premove-from');
      } else if (premoveQueue.some(pm => pm.from[0] === r && pm.from[1] === c)) {
        sq.classList.add('sq-premove-from');
      }

      // Premove destination highlight & badge
      const pmIndex = premoveQueue.findIndex(pm => pm.to[0] === r && pm.to[1] === c);
      if (pmIndex !== -1) {
        sq.classList.add('sq-premove-to');
        if (premoveQueue.length > 1) {
          const badge = document.createElement('span');
          badge.className = 'premove-badge';
          badge.textContent = `${pmIndex + 1}`;
          sq.appendChild(badge);
        }
      }

      // Highlight last move played
      if (lastMove && ((lastMove.from[0] === r && lastMove.from[1] === c) || (lastMove.to[0] === r && lastMove.to[1] === c))) {
        sq.classList.add('sq-last-move');
      }

      const piece = activeBoard[r][c];

      // Highlight King in check (only in authoritative state)
      if (inCheck && piece && piece.toLowerCase() === 'k' && !virtualBoardState) {
        const isKingTurn = (currentTurn === 'white' && piece === 'K') || (currentTurn === 'black' && piece === 'k');
        if (isKingTurn) sq.classList.add('sq-check');
      }

      // Render Piece
      if (piece) {
        const span = document.createElement('span');
        span.className = piece === piece.toUpperCase() ? 'piece-w' : 'piece-b';
        if (pmIndex !== -1) {
          span.classList.add('premove-piece-ghost');
        }
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

      // Cursor state
      if (!isMyTurn && !canPremove) {
        sq.classList.add('cursor-default');
      }

      sq.onclick = () => onSquareClick(r, c);
      boardEl.appendChild(sq);
    }
  }

  updateCapturedPieces();
  updateClockDisplay();
}

// Animate piece movement from origin to destination square (180ms ease-out)
function animatePieceMove(fromR, fromC, toR, toC, callback) {
  const boardEl = document.getElementById('board');
  if (!boardEl) return callback();

  // Find origin and target square elements in current DOM
  const fromSq = boardEl.querySelector(`[data-r="${fromR}"][data-c="${fromC}"]`);
  const toSq = boardEl.querySelector(`[data-r="${toR}"][data-c="${toC}"]`);

  if (!fromSq || !toSq) return callback();

  const pieceEl = fromSq.querySelector('.piece-w, .piece-b');
  if (!pieceEl) return callback();

  const fromRect = fromSq.getBoundingClientRect();
  const toRect = toSq.getBoundingClientRect();
  const deltaX = toRect.left - fromRect.left;
  const deltaY = toRect.top - fromRect.top;

  // Clone piece for animation
  const ghost = document.createElement('div');
  ghost.className = 'moving-piece-clone ' + pieceEl.className;
  ghost.textContent = pieceEl.textContent;
  ghost.style.left = `${fromSq.offsetLeft}px`;
  ghost.style.top = `${fromSq.offsetTop}px`;
  document.getElementById('board-frame').appendChild(ghost);

  // Temporarily hide original piece
  pieceEl.style.opacity = '0';

  // Force reflow and animate
  requestAnimationFrame(() => {
    ghost.style.transform = `translate(${deltaX}px, ${deltaY}px)`;
  });

  setTimeout(() => {
    ghost.remove();
    callback();
  }, 180);
}

function onSquareClick(r, c) {
  if (isGameOver) return;

  const isMyTurn = (myRole !== 'spectator' && myRole === currentTurn);

  // If opponent's turn, handle premove queuing
  if (!isMyTurn) {
    if (myRole === 'spectator') return;
    if (!premoveSettings.enabled) {
      showToast(`Wait for your turn (${currentTurn.toUpperCase()}'s turn).`, 'info', 1800);
      return;
    }
    handlePremoveClick(r, c);
    return;
  }

  // Active player turn handling: clear any remaining premoves
  if (premoveQueue.length > 0) {
    cancelPremoves();
  }

  const piece = boardState[r][c];
  const isMyPiece = piece && (myRole === 'white' ? piece === piece.toUpperCase() : piece === piece.toLowerCase());

  // If a piece is selected, check if this is a target square
  if (selectedSq) {
    const legals = getPieceMoves(selectedSq[0], selectedSq[1], boardState);
    const isTarget = legals.some(t => t[0] === r && t[1] === c);

    if (isTarget) {
      const fromAlg = squareToAlg(selectedSq[0], selectedSq[1]);
      const toAlg = squareToAlg(r, c);

      // Check pawn promotion
      const movedPiece = boardState[selectedSq[0]][selectedSq[1]];
      const isPromotion = (movedPiece === 'P' && r === 0) || (movedPiece === 'p' && r === 7);

      if (isPromotion) {
        showPromotionModal(fromAlg, toAlg, movedPiece === 'P');
        return;
      }

      socket.emit('make_move', {
        roomId: currentRoom,
        from: fromAlg,
        to: toAlg,
        playerToken
      });

      selectedSq = null;
      renderBoard();
      return;
    }
  }

  // Select clicked piece
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
  const myTime = myRole === 'black' ? clocks.black : clocks.white;
  const oppTime = myRole === 'black' ? clocks.white : clocks.black;

  if (pClock) {
    pClock.textContent = formatClock(myTime);
    if (myTime <= 30 && myTime > 0 && currentTurn === myRole) {
      pClock.classList.add('clock-danger');
    } else {
      pClock.classList.remove('clock-danger');
    }
  }

  if (oClock) {
    oClock.textContent = formatClock(oppTime);
    const oppRole = myRole === 'white' ? 'black' : 'white';
    if (oppTime <= 30 && oppTime > 0 && currentTurn === oppRole) {
      oClock.classList.add('clock-danger');
    } else {
      oClock.classList.remove('clock-danger');
    }
  }
}

function updateStatusMessage() {
  const badge = document.getElementById('room-code-badge');
  const msg = document.getElementById('status-message');
  const pCard = document.getElementById('player-card');
  const oCard = document.getElementById('opp-card');

  if (badge) badge.textContent = `ROOM: ${currentRoom}`;

  if (isGameOver) {
    if (pCard) pCard.classList.remove('ring-1', 'ring-indigo-500/50');
    if (oCard) oCard.classList.remove('ring-1', 'ring-indigo-500/50');
    return;
  }

  const isMyTurn = (myRole === currentTurn);

  // Visual card highlight for active player
  if (pCard && oCard) {
    if (isMyTurn) {
      pCard.classList.add('ring-1', 'ring-indigo-500/50');
      oCard.classList.remove('ring-1', 'ring-indigo-500/50');
    } else {
      oCard.classList.add('ring-1', 'ring-indigo-500/50');
      pCard.classList.remove('ring-1', 'ring-indigo-500/50');
    }
  }

  if (!msg) return;

  if (myRole === 'spectator') {
    msg.innerHTML = `<span class="w-2 h-2 rounded-full bg-slate-400"></span> <span>${currentTurn.toUpperCase()} to move (Spectating)</span>`;
  } else if (isMyTurn) {
    if (inCheck) {
      msg.innerHTML = `<span class="w-2 h-2 rounded-full bg-rose-500 animate-ping"></span> <span class="text-rose-300 font-bold">⚠️ CHECK! Defend your King!</span>`;
    } else {
      msg.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span> <span class="text-emerald-300 font-bold">Your turn to move!</span>`;
    }
  } else {
    msg.innerHTML = `<span class="w-2 h-2 rounded-full bg-indigo-400 animate-pulse"></span> <span>Opponent (${currentTurn}) is thinking...</span>`;
  }
}

// ─── Socket Event Handlers ────────────────────────────────────────────────────
socket.on('connect', () => {
  document.getElementById('conn-text').textContent = 'Online';
  const connStatus = document.getElementById('connection-status');
  if (connStatus) {
    connStatus.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20';
  }
  document.getElementById('reconnecting-banner')?.classList.add('hidden');

  // Auto-resume game if token saved
  if (currentRoom && playerToken) {
    socket.emit('join_game', {
      roomId: currentRoom,
      playerName: myName || 'Player',
      mode: 'pvp',
      playerToken
    });
    showToast('Reconnected to match room.', 'success');
  }
});

socket.on('disconnect', () => {
  document.getElementById('conn-text').textContent = 'Reconnecting...';
  const connStatus = document.getElementById('connection-status');
  if (connStatus) {
    connStatus.className = 'flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-400 border border-amber-500/20';
  }
  document.getElementById('reconnecting-banner')?.classList.remove('hidden');
  showToast('Connection interrupted. Attempting to reconnect...', 'warning');
});

socket.on('game_init', (data) => {
  currentRoom = data.roomId;
  myRole = data.role;
  playerToken = data.playerToken;
  currentFen = data.fen;
  currentPgn = data.pgn || '';
  currentPlayers = data.players || { white: null, black: null };

  if (playerToken) {
    sessionStorage.setItem('chess_player_token_' + currentRoom, playerToken);
    sessionStorage.setItem('chess_room_name_' + currentRoom, myName);
  }

  currentTurn = data.turn;
  boardState = fenToBoard(data.fen);
  cancelPremoves();
  clocks = data.clocks || { white: data.timeControl, black: data.timeControl };
  inCheck = data.inCheck;
  isGameOver = data.isGameOver;

  isFlipped = (myRole === 'black');

  // Switch screens
  document.getElementById('lobby-screen').classList.add('hidden');
  document.getElementById('game-screen').classList.remove('hidden');
  document.getElementById('nav-share-btn').classList.remove('hidden');

  // Update Profile cards
  document.getElementById('player-name').textContent = myName || 'You';
  document.getElementById('player-role-label').textContent = `${myRole.toUpperCase()} (You)`;
  document.getElementById('player-avatar').textContent = myRole === 'white' ? '⚪' : '⚫';

  updatePlayersUI(data.players);
  updateStatusMessage();
  renderBoard();

  // Replay move history
  moveHistory = [];
  const tbody = document.getElementById('moves-tbody');
  tbody.innerHTML = '';
  if (data.history && data.history.length > 0) {
    for (const move of data.history) {
      appendMoveNotation(move.san);
    }
  }

  // Load chat messages
  const chatBox = document.getElementById('chat-messages');
  chatBox.innerHTML = '';
  if (data.messages) {
    data.messages.forEach(m => appendChatMessage(m));
  }

  showToast(`Joined Room ${currentRoom} as ${myRole.toUpperCase()}`, 'success');
});

socket.on('players_update', (data) => {
  currentPlayers = data.players;
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
    oppRoleEl.innerHTML = `<span>${myRole === 'white' ? 'Black' : 'White'}</span> • <span class="${opp.connected ? 'text-emerald-400' : 'text-slate-500'}">${opp.connected ? 'Online' : 'Offline'}</span>`;
  } else {
    oppNameEl.textContent = 'Waiting for opponent...';
    const myRoleTitle = myRole === 'white' ? 'White' : (myRole === 'black' ? 'Black' : 'Spectator');
    oppRoleEl.innerHTML = `<span class="text-slate-400 font-medium">You play as ${myRoleTitle}</span> • <button onclick="copyInviteLink()" class="text-indigo-400 hover:text-indigo-300 font-semibold underline cursor-pointer">Share Invite Link</button>`;
  }
  oppAvatarEl.textContent = myRole === 'white' ? '⚫' : '⚪';
}

socket.on('move_made', (data) => {
  const fromSq = algToSquare(data.move.from);
  const toSq = algToSquare(data.move.to);

  // Play sound
  if (data.isGameOver) {
    playSound('gameover');
  } else if (data.inCheck) {
    playSound('check');
  } else if (data.move.captured) {
    playSound('capture');
  } else {
    playSound('move');
  }

  // Animate piece movement then update board state
  animatePieceMove(fromSq[0], fromSq[1], toSq[0], toSq[1], () => {
    boardState = fenToBoard(data.fen);
    currentFen = data.fen;
    currentPgn = data.pgn || '';
    currentTurn = data.turn;
    inCheck = data.inCheck;
    isGameOver = data.isGameOver;
    clocks = data.clocks || clocks;
    lastMove = { from: fromSq, to: toSq };

    appendMoveNotation(data.move.san);
    updateStatusMessage();

    // Trigger Game Over if ended
    if (data.isGameOver) {
      cancelPremoves();
      renderBoard();
      if (data.gameOverData) {
        handleGameOverState(data.gameOverData);
      }
      return;
    }

    // Premove execution on turn arrival
    if (currentTurn === myRole && premoveQueue.length > 0) {
      executeNextPremove();
    } else {
      virtualBoardState = null;
      renderBoard();
    }
  });
});

socket.on('clock_update', (newClocks) => {
  clocks = newClocks;
  updateClockDisplay();
});

socket.on('game_restarted', (data) => {
  boardState = fenToBoard(data.fen);
  currentFen = data.fen;
  currentPgn = '';
  currentTurn = data.turn;
  clocks = data.clocks;
  lastMove = null;
  selectedSq = null;
  cancelPremoves();
  isGameOver = false;
  inCheck = false;
  moveHistory = [];
  document.getElementById('moves-tbody').innerHTML = '';
  document.getElementById('move-count-label').textContent = '0';
  updateStatusMessage();
  renderBoard();
  playSound('move');
  showToast('Match restarted! White to move.', 'info');
});

socket.on('game_over', (data) => {
  cancelPremoves();
  isGameOver = true;
  playSound('gameover');
  handleGameOverState(data);
});

function handleGameOverState(data) {
  isGameOver = true;
  let icon = '🏆';
  let title = 'Game Over';
  let desc = data.message || '';

  if (data.reason === 'checkmate') {
    icon = '🏆';
    title = `${data.winner} Wins by Checkmate!`;
    desc = `Checkmate! ${data.winner} has achieved victory.`;
  } else if (data.reason === 'resignation') {
    icon = '🏳️';
    title = `${data.winner} Wins by Resignation`;
    desc = data.message || `${data.winner} won as opponent resigned.`;
  } else if (data.reason === 'timeout') {
    icon = '⏱️';
    title = `${data.winner} Wins on Time`;
    desc = data.message || `Time ran out. ${data.winner} wins!`;
  } else {
    icon = '🤝';
    title = `Game Drawn`;
    desc = `Match ended in a draw (${data.reason || 'draw'}).`;
  }

  showModal({
    icon,
    title,
    message: `${desc}\n\nTotal moves: ${moveHistory.length}. Would you like to request a rematch?`,
    confirmText: '🔁 Request Rematch',
    cancelText: 'Close',
    onConfirm: () => {
      socket.emit('restart_game', { roomId: currentRoom, playerToken });
    }
  });
}

// Opponent restart consent modal (Fix #12)
socket.on('restart_requested', (data) => {
  showModal({
    icon: '🔁',
    title: 'Rematch Request',
    message: data.message || 'Your opponent has requested to restart the match. Do you accept?',
    confirmText: 'Accept Rematch',
    cancelText: 'Decline',
    onConfirm: () => {
      socket.emit('restart_game', { roomId: currentRoom, playerToken });
    },
    onCancel: () => {
      showToast('Declined rematch request.', 'info');
    }
  });
});

socket.on('chat_message', (msg) => {
  appendChatMessage(msg);
});

socket.on('error_message', (msg) => {
  cancelPremoves();
  showToast(msg, 'error', 4500);
});

// ─── UI Actions & Lobby Controls ──────────────────────────────────────────────
function switchLobbyTab(tab) {
  const pvpTab = document.getElementById('tab-content-pvp');
  const aiTab = document.getElementById('tab-content-ai');
  const btnPvp = document.getElementById('tab-btn-pvp');
  const btnAi = document.getElementById('tab-btn-ai');

  if (tab === 'pvp') {
    pvpTab.classList.remove('hidden');
    aiTab.classList.add('hidden');
    btnPvp.className = 'py-2 text-xs font-bold rounded-lg bg-indigo-600 text-white transition shadow-sm cursor-pointer';
    btnAi.className = 'py-2 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer';
  } else {
    pvpTab.classList.add('hidden');
    aiTab.classList.remove('hidden');
    btnAi.className = 'py-2 text-xs font-bold rounded-lg bg-emerald-600 text-white transition shadow-sm cursor-pointer';
    btnPvp.className = 'py-2 text-xs font-semibold rounded-lg text-slate-400 hover:text-white transition cursor-pointer';
  }
}

function selectTimeControl(seconds, btn) {
  document.getElementById('time-control-val').value = seconds;
  const allBtns = document.querySelectorAll('.tc-btn');
  allBtns.forEach(b => {
    b.className = 'tc-btn p-2.5 rounded-xl border border-slate-800 bg-slate-950 text-left hover:border-slate-700 transition cursor-pointer';
    b.querySelector('.text-xs').className = 'text-xs font-bold text-slate-200';
  });

  btn.className = 'tc-btn active p-2.5 rounded-xl border border-indigo-500/60 bg-indigo-600/15 text-left transition cursor-pointer';
  btn.querySelector('.text-xs').className = 'text-xs font-bold text-indigo-300';
}

function createRoom() {
  const nameInput = document.getElementById('player-name-input');
  const nameHint = document.getElementById('name-error-hint');
  myName = nameInput.value.trim() || 'Player 1';
  nameHint.classList.add('hidden');

  const tc = parseInt(document.getElementById('time-control-val').value, 10) || 0;
  const preferredColor = document.getElementById('pvp-color-val')?.value || 'random';

  const btn = document.getElementById('create-room-btn');
  btn.disabled = true;
  btn.innerHTML = `<span class="animate-spin text-sm">⌛</span> <span>Creating Room...</span>`;

  socket.emit('join_game', {
    playerName: myName,
    mode: 'pvp',
    timeControl: tc,
    preferredColor
  });

  setTimeout(() => {
    btn.disabled = false;
    btn.innerHTML = `<span>⚔️</span> <span>Create New Game Room</span>`;
  }, 2000);
}

function joinRoomByCode() {
  const codeInput = document.getElementById('join-room-input');
  const codeHint = document.getElementById('code-error-hint');
  const code = codeInput.value.trim().toUpperCase();

  if (!code || code.length < 4) {
    codeHint.classList.remove('hidden');
    codeInput.focus();
    return;
  }
  codeHint.classList.add('hidden');

  const nameInput = document.getElementById('player-name-input');
  myName = nameInput.value.trim() || 'Player 2';
  const savedToken = sessionStorage.getItem('chess_player_token_' + code);

  socket.emit('join_game', {
    roomId: code,
    playerName: myName,
    mode: 'pvp',
    playerToken: savedToken
  });
}

function startAiGame() {
  const nameInput = document.getElementById('player-name-input');
  myName = nameInput.value.trim() || 'Player';
  const preferredColor = document.getElementById('ai-color-val')?.value || 'random';

  socket.emit('join_game', {
    playerName: myName,
    mode: 'ai',
    timeControl: 0,
    preferredColor
  });
}

function flipBoard() {
  isFlipped = !isFlipped;
  renderBoard();
  showToast(isFlipped ? 'Board view: Black on bottom' : 'Board view: White on bottom', 'info', 1800);
}

function requestRestart() {
  showModal({
    icon: '🔁',
    title: 'Restart Match',
    message: 'Are you sure you want to request a new match in this room?',
    confirmText: 'Yes, Restart',
    cancelText: 'Cancel',
    onConfirm: () => {
      socket.emit('restart_game', { roomId: currentRoom, playerToken });
    }
  });
}

function confirmResign() {
  showModal({
    icon: '🏳️',
    title: 'Resign Match',
    message: 'Are you sure you want to resign? Your opponent will be awarded the victory.',
    confirmText: 'Resign Match',
    cancelText: 'Keep Playing',
    destructive: true,
    onConfirm: () => {
      socket.emit('resign', { roomId: currentRoom, playerToken });
    }
  });
}

function copyInviteLink() {
  const url = `${window.location.origin}/?room=${currentRoom}`;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      showToast(`Invite link copied to clipboard!\n${url}`, 'success', 3500);
    }).catch(() => {
      showModal({
        icon: '📋',
        title: 'Invite Link',
        message: url,
        confirmText: 'Close',
        cancelText: null
      });
    });
  } else {
    showModal({
      icon: '📋',
      title: 'Invite Link',
      message: url,
      confirmText: 'Close',
      cancelText: null
    });
  }
}

function copyPgn() {
  if (!currentPgn && moveHistory.length === 0) {
    showToast('No moves made yet.', 'info');
    return;
  }
  const text = currentPgn || moveHistory.map(m => `${m.num}. ${m.w} ${m.b || ''}`).join(' ');
  navigator.clipboard.writeText(text).then(() => {
    showToast('PGN notation copied to clipboard!', 'success');
  }).catch(() => {
    showToast('Failed to copy PGN.', 'error');
  });
}

function sendChat(e) {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;

  socket.emit('chat_message', {
    roomId: currentRoom,
    text
  });
  input.value = '';
}

function appendChatMessage(msg) {
  const chatBox = document.getElementById('chat-messages');
  if (!chatBox) return;

  const isMe = (msg.sender === myName);
  const div = document.createElement('div');
  div.className = `flex flex-col p-2 rounded-xl border text-xs shadow-sm ${
    isMe
      ? 'bg-indigo-950/40 border-indigo-800/60 ml-4'
      : 'bg-slate-950/80 border-slate-800/80 mr-4'
  }`;

  div.innerHTML = `
    <div class="flex items-center justify-between text-[10px] text-slate-400 mb-0.5">
      <span class="font-bold ${isMe ? 'text-indigo-300' : 'text-slate-300'}">${msg.sender}</span>
      <span class="text-[9px] text-slate-500 font-mono">${msg.time}</span>
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
    tr.className = 'hover:bg-slate-800/40 transition-colors';
    tr.innerHTML = `
      <td class="py-1 px-2.5 text-slate-500 w-8 font-medium">${total + 1}.</td>
      <td class="py-1 px-2 font-bold text-indigo-300">${san}</td>
      <td class="py-1 px-2 text-slate-400" id="hist-b-${total + 1}">...</td>
    `;
    tbody.appendChild(tr);
  } else {
    if (total > 0) {
      moveHistory[total - 1].b = san;
      const cell = document.getElementById(`hist-b-${total}`);
      if (cell) {
        cell.textContent = san;
        cell.className = 'py-1 px-2 text-slate-200 font-semibold';
      }
    }
  }
  document.getElementById('move-count-label').textContent = `${moveHistory.length}`;
  const scrollEl = document.getElementById('moves-scroll');
  scrollEl.scrollTop = scrollEl.scrollHeight;
}

// ─── Keyboard Accessibility & Initialization ──────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  loadPremoveSettings();

  const params = new URLSearchParams(window.location.search);
  const roomParam = params.get('room');
  if (roomParam) {
    const input = document.getElementById('join-room-input');
    if (input) input.value = roomParam.toUpperCase();
  }

  // Right-click anywhere on the chessboard cancels queued premoves (chess.com-style)
  document.getElementById('board-frame')?.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (premoveQueue.length > 0 || premoveSelectedSq) {
      cancelPremoves();
      showToast('Premove cancelled.', 'info', 1200);
    }
  });

  // Clear validation hints on input
  document.getElementById('player-name-input')?.addEventListener('input', () => {
    document.getElementById('name-error-hint')?.classList.add('hidden');
  });
  document.getElementById('join-room-input')?.addEventListener('input', () => {
    document.getElementById('code-error-hint')?.classList.add('hidden');
  });

  // Global keyboard shortcuts
  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
    if (e.key === 'Escape') {
      closeSettingsModal();
    }
    if (e.key === 'f' || e.key === 'F') {
      flipBoard();
    }
  });
});

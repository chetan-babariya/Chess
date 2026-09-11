/**
 * Telegram Bot for Chess Live Mini App
 * Supports both:
 * 1. Render Background Worker (pure long polling)
 * 2. Render Web Service (long polling + minimal HTTP server to satisfy $PORT binding)
 */

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const http = require('http');
const path = require('path');
const fs = require('fs');

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEB_APP_URL = process.env.WEB_APP_URL || 'https://chess-j33o.onrender.com/';
const PORT = process.env.PORT;

if (!BOT_TOKEN) {
  console.error('\n❌ ERROR: BOT_TOKEN is not set in environment variables!');
  console.error('Please set BOT_TOKEN in your .env or hosting environment.\n');
  process.exit(1);
}

// ─── Dual-Mode Fallback: HTTP Server for Render Web Service Tier ───────────────
// If PORT is provided (e.g. deployed as a free Render Web Service instead of
// Background Worker), spin up a minimal health server to satisfy Render's port check.
if (PORT) {
  const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Chess Live Telegram Bot OK');
  });

  healthServer.listen(PORT, '0.0.0.0', () => {
    console.log(`📡 Fallback HTTP server listening on port ${PORT} (satisfies Render Web Service port-binding)`);
  });
}

// Clean trailing slash for URL concatenation
const cleanWebAppUrl = WEB_APP_URL.replace(/\/+$/, '');
const PREVIEW_IMAGE_URL = process.env.PREVIEW_IMAGE_URL || `${cleanWebAppUrl}/preview.png`;

// ─── Initialize Telegram Bot with Polling (v0.66 API) ──────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

console.log('=================================================');
console.log('🤖 CHESS LIVE TELEGRAM BOT STARTED!');
console.log('-------------------------------------------------');
console.log(`> Web App URL:    ${WEB_APP_URL}`);
console.log(`> Banner URL:     ${PREVIEW_IMAGE_URL}`);
if (PORT) {
  console.log(`> Service Mode:   Web Service (Port ${PORT})`);
} else {
  console.log(`> Service Mode:   Background Worker (No Port)`);
}
console.log('=================================================\n');

// ─── Programmatic Command Menu Registration ───────────────────────────────────
bot.setMyCommands([
  {
    command: 'start',
    description: 'Play Chess Live inside Telegram'
  },
  {
    command: 'help',
    description: 'How to play and game rules'
  }
])
  .then(() => {
    console.log('✅ Telegram bot commands registered successfully with Telegram API');
  })
  .catch((err) => {
    console.error('❌ Failed to register Telegram bot commands:', err.message);
  });

// ─── Help Message Text ────────────────────────────────────────────────────────
function getHelpText() {
  return (
    '♟️ *Chess Live — Quick Guide & Commands*\n\n' +
    '*🎮 How to Play:*\n' +
    '1. Tap *Play Chess Live* below to launch the Mini App.\n' +
    '2. *Multiplayer Room:*\n' +
    '   • Select your time control (Rapid 10m, Blitz 5m, Bullet 3m, or Casual).\n' +
    '   • Tap *Create Game Room* to generate a 6-character room code.\n' +
    '   • Share the invite link or code with a friend to play in real-time!\n' +
    '3. *Play vs AI:*\n' +
    '   • Switch to the *Play vs AI* tab to challenge our built-in Minimax bot.\n' +
    '4. *Joining an Existing Match:*\n' +
    '   • Paste any 6-character code into the room input to join as a player or spectator.\n\n' +
    '*⚡ Advanced Features:*\n' +
    '• *Premoves:* Queue moves ahead during your opponent\'s turn.\n' +
    '• *In-Game Chat:* Real-time room chat with spectator distinction.\n' +
    '• *Draws & Rematches:* Mutual draw agreements and color-swapped rematches.\n\n' +
    '*🤖 Commands:*\n' +
    '/start — Launch Chess Live with instant play button\n' +
    '/help — View game instructions and command list'
  );
}

// ─── /start Command ───────────────────────────────────────────────────────────
bot.onText(/^\/start(?:@\w+)?$/, async (msg) => {
  const chatId = msg.chat.id;
  const firstName = msg.from?.first_name || 'there';

  const caption =
    `♟️ *Welcome to Chess Live, ${firstName}!*\n\n` +
    `Play real-time multiplayer chess with friends or challenge the built-in AI engine directly inside Telegram.\n\n` +
    `• ⚔️ *Real-Time PvP Matchmaking*\n` +
    `• 🤖 *Minimax AI Engine*\n` +
    `• ⏱️ *Rapid, Blitz, Bullet & Casual Clocks*\n` +
    `• 💬 *Live Room Chat & Spectator Mode*\n` +
    `• ⚡ *chess.com-style Premoves*\n\n` +
    `Tap the button below to launch the game!`;

  const keyboard = {
    inline_keyboard: [
      [
        {
          text: '♟️ Play Chess Live',
          web_app: { url: WEB_APP_URL }
        }
      ],
      [
        {
          text: '📖 How to Play & Guide',
          callback_data: 'cmd_help'
        }
      ]
    ]
  };

  try {
    // Attempt sending with remote HTTPS image URL
    await bot.sendPhoto(chatId, PREVIEW_IMAGE_URL, {
      caption,
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  } catch (err) {
    console.warn('Could not send remote photo, attempting local fallback or text fallback:', err.message);
    const localImg = path.join(__dirname, 'public', 'preview.png');
    if (fs.existsSync(localImg)) {
      try {
        await bot.sendPhoto(chatId, localImg, {
          caption,
          parse_mode: 'Markdown',
          reply_markup: keyboard
        });
        return;
      } catch (localErr) {
        console.warn('Local photo send failed:', localErr.message);
      }
    }

    // Text fallback if image cannot be loaded
    bot.sendMessage(chatId, caption, {
      parse_mode: 'Markdown',
      reply_markup: keyboard
    });
  }
});

// ─── /help Command ────────────────────────────────────────────────────────────
bot.onText(/^\/help(?:@\w+)?$/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, getHelpText(), {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '♟️ Launch Chess Live',
            web_app: { url: WEB_APP_URL }
          }
        ]
      ]
    }
  });
});

// ─── Callback Queries (Inline Buttons) ────────────────────────────────────────
bot.on('callback_query', (query) => {
  const chatId = query.message?.chat?.id;
  if (!chatId) return;

  if (query.data === 'cmd_help') {
    bot.answerCallbackQuery(query.id);
    bot.sendMessage(chatId, getHelpText(), {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '♟️ Launch Chess Live',
              web_app: { url: WEB_APP_URL }
            }
          ]
        ]
      }
    });
  }
});

// ─── Polling Error Logging (Log All Errors, Including EFATAL) ─────────────────
bot.on('polling_error', (error) => {
  console.error('❌ [Telegram Bot Polling Error]:', error.code || '', error.message || error);
});

// ─── Process Crash Containment ────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ [FATAL] Uncaught Exception in Bot:', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('❌ [FATAL] Unhandled Rejection in Bot:', reason);
});


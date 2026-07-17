const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: false },
  maxHttpBufferSize: 100_000,
});

const ENGLISH_WORDS_PATH = path.join(__dirname, "data", "alias_words_1000.csv");
const UKRAINIAN_WORDS_PATH = path.join(__dirname, "data", "ukrainian_words.csv");
const DEFAULT_ROUND_SECONDS = 60;
const DIFFICULTIES = new Set(["easy", "normal"]);
const WORD_MODES = new Set(["english_easy", "english_medium", "ukrainian_mixed"]);
const publicDirectory = path.join(__dirname, "public");
const rooms = new Map();

function parseCsvLine(line) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      values.push(value.trim());
      value = "";
    } else {
      value += character;
    }
  }
  values.push(value.trim());
  return values;
}

function loadUkrainianWords() {
  const lines = fs.readFileSync(UKRAINIAN_WORDS_PATH, "utf8").replace(/^\uFEFF/, "").split(/\r?\n/);
  const words = lines
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [word, difficulty] = parseCsvLine(line);
      return { word, difficulty };
    });
  if (words.some(({ word, difficulty }) => !word || !DIFFICULTIES.has(difficulty))) {
    throw new Error("Every word needs a value and an easy or normal difficulty.");
  }
  return words;
}

function loadEnglishWords() {
  return fs.readFileSync(ENGLISH_WORDS_PATH, "utf8")
    .replace(/^\uFEFF/, "")
    .split(/\r?\n/)
    .slice(1)
    .map((word) => word.trim())
    .filter(Boolean);
}

const ENGLISH_WORDS = loadEnglishWords();
const UKRAINIAN_WORDS = loadUkrainianWords();

if (ENGLISH_WORDS.length === 0 || UKRAINIAN_WORDS.length === 0) {
  throw new Error("The word deck is empty.");
}

app.disable("x-powered-by");
app.use(express.static(publicDirectory, { extensions: ["html"] }));
app.get("/health", (_request, response) => {
  response.json({ ok: true, rooms: rooms.size, words: ENGLISH_WORDS.length + UKRAINIAN_WORDS.length });
});

function sanitizeName(value) {
  return String(value || "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
}

function safeCallback(candidate) {
  return typeof candidate === "function" ? candidate : () => {};
}

function normalizeCode(value) {
  return String(value || "").replace(/[^a-z0-9]/gi, "").toUpperCase().slice(0, 6);
}

function createRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let code = "";
    for (let index = 0; index < 6; index += 1) {
      code += alphabet[crypto.randomInt(alphabet.length)];
    }
    if (!rooms.has(code)) return code;
  }
  throw new Error("Could not create a unique room code.");
}

function shuffle(items) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function clearGameTimer(room) {
  if (room.game?.timer) {
    clearTimeout(room.game.timer);
    room.game.timer = null;
  }
}

function getPlayer(room, token) {
  return room.players.find((player) => player.token === token);
}

function getExplainer(room) {
  return room.game ? room.players[room.game.explainerIndex] : null;
}

function touchRoom(room) {
  room.lastActiveAt = Date.now();
  if (room.cleanupTimer) {
    clearTimeout(room.cleanupTimer);
    room.cleanupTimer = null;
  }
}

function scheduleRoomCleanup(room) {
  if (room.players.some((player) => player.connected) || room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => {
    clearGameTimer(room);
    rooms.delete(room.code);
  }, 30 * 60 * 1000);
}

function publicStateFor(room, player) {
  const explainer = getExplainer(room);
  const isExplainer = Boolean(explainer && explainer.token === player.token);
  const game = room.game
    ? {
        round: room.game.round,
        totalRounds: room.settings.totalRounds,
        explainerName: explainer?.name || "",
        isExplainer,
        roundCorrect: room.game.roundCorrect,
        roundSkipped: room.game.roundSkipped,
        roundDelta: room.game.roundCorrect - room.game.roundSkipped,
        remainingMs: room.game.endsAt ? Math.max(0, room.game.endsAt - Date.now()) : null,
        lastRound: room.game.lastRound,
        word: room.phase === "playing" && isExplainer ? room.game.currentWord : null,
      }
    : null;

  return {
    code: room.code,
    phase: room.phase,
    isHost: room.hostToken === player.token,
    selfToken: player.token,
    settings: room.settings,
    players: room.players.map((roomPlayer) => ({
      name: roomPlayer.name,
      connected: roomPlayer.connected,
      score: roomPlayer.score,
      correct: roomPlayer.correct,
      skipped: roomPlayer.skipped,
      isSelf: roomPlayer.token === player.token,
      isHost: roomPlayer.token === room.hostToken,
    })),
    game,
  };
}

function emitRoomState(room) {
  touchRoom(room);
  for (const player of room.players) {
    if (!player.connected || !player.socketId) continue;
    io.to(player.socketId).emit("room-state", publicStateFor(room, player));
  }
}

function nextWord(room) {
  if (room.game.deckIndex >= room.game.deck.length) {
    room.game.deck = makeDeck(room.settings.wordMode);
    room.game.deckIndex = 0;
  }
  const word = room.game.deck[room.game.deckIndex];
  room.game.deckIndex += 1;
  return word;
}

function makeDeck(wordMode) {
  if (wordMode === "english_easy") {
    return shuffle(ENGLISH_WORDS.filter((word) => word.length <= 6));
  }
  if (wordMode === "english_medium") {
    return shuffle(ENGLISH_WORDS.filter((word) => word.length > 6));
  }
  return shuffle(UKRAINIAN_WORDS.map((entry) => entry.word));
}

function endRound(room) {
  if (!room.game || room.phase !== "playing") return;
  clearGameTimer(room);
  const explainer = getExplainer(room);
  room.game.lastRound = {
    explainerName: explainer.name,
    correct: room.game.roundCorrect,
    skipped: room.game.roundSkipped,
    delta: room.game.roundCorrect - room.game.roundSkipped,
  };
  room.game.currentWord = null;
  room.game.endsAt = null;
  room.phase = "round_result";
  emitRoomState(room);
}

function startRoundTimer(room) {
  const duration = room.settings.roundSeconds * 1000;
  room.game.endsAt = Date.now() + duration;
  room.game.timer = setTimeout(() => endRound(room), duration + 100);
}

function attachPlayerToSocket(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) {
    io.sockets.sockets.get(player.socketId)?.disconnect(true);
  }
  player.socketId = socket.id;
  player.connected = true;
  socket.data.roomCode = room.code;
  socket.data.playerToken = player.token;
  socket.join(room.code);
  touchRoom(room);
}

function detachFromCurrentRoom(socket, removePlayer = false) {
  const room = rooms.get(socket.data.roomCode);
  if (!room) return;
  const player = getPlayer(room, socket.data.playerToken);
  if (!player || player.socketId !== socket.id) return;

  player.connected = false;
  player.socketId = null;
  socket.leave(room.code);

  if (removePlayer && room.phase === "lobby") {
    room.players = room.players.filter((candidate) => candidate.token !== player.token);
  }

  if (room.players.length === 0) {
    clearGameTimer(room);
    rooms.delete(room.code);
    return;
  }

  if (room.hostToken === player.token) {
    room.hostToken = room.players.find((candidate) => candidate.connected)?.token || room.players[0].token;
  }

  emitRoomState(room);
  scheduleRoomCleanup(room);
}

io.on("connection", (socket) => {
  socket.on("create-room", (payload, callback = () => {}) => {
    const name = sanitizeName(payload?.name);
    if (!name) return callback({ ok: false, error: "Enter your name first." });

    detachFromCurrentRoom(socket, true);
    const code = createRoomCode();
    const token = crypto.randomUUID();
    const player = {
      token,
      name,
      socketId: socket.id,
      connected: true,
      score: 0,
      correct: 0,
      skipped: 0,
    };
    const room = {
      code,
      hostToken: token,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cleanupTimer: null,
      phase: "lobby",
      settings: { roundSeconds: DEFAULT_ROUND_SECONDS, totalRounds: 6, wordMode: "english_easy" },
      players: [player],
      game: null,
    };
    rooms.set(code, room);
    attachPlayerToSocket(socket, room, player);
    callback({ ok: true, code, token });
    emitRoomState(room);
  });

  socket.on("join-room", (payload, callback = () => {}) => {
    const code = normalizeCode(payload?.code);
    const name = sanitizeName(payload?.name);
    const room = rooms.get(code);
    if (!room) return callback({ ok: false, error: "Room not found. Check the code and try again." });

    let player = payload?.token ? getPlayer(room, String(payload.token)) : null;
    if (!player) {
      if (!name) return callback({ ok: false, error: "Enter your name first." });
      if (room.players.length >= 2) return callback({ ok: false, error: "This room already has two players." });
      if (room.phase !== "lobby") return callback({ ok: false, error: "This game is already in progress." });
      player = {
        token: crypto.randomUUID(),
        name,
        socketId: socket.id,
        connected: true,
        score: 0,
        correct: 0,
        skipped: 0,
      };
      room.players.push(player);
    } else if (name) {
      player.name = name;
    }

    detachFromCurrentRoom(socket, false);
    attachPlayerToSocket(socket, room, player);
    callback({ ok: true, code, token: player.token });
    emitRoomState(room);
  });

  socket.on("leave-room", (callback = () => {}) => {
    detachFromCurrentRoom(socket, true);
    socket.data.roomCode = null;
    socket.data.playerToken = null;
    callback({ ok: true });
  });

  socket.on("update-settings", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return callback({ ok: false, error: "Room not found." });
    if (room.hostToken !== socket.data.playerToken) return callback({ ok: false, error: "Only the host can change settings." });
    if (room.phase !== "lobby") return callback({ ok: false, error: "Settings are locked during a game." });

    const roundSeconds = Number(payload?.roundSeconds);
    const totalRounds = Number(payload?.totalRounds);
    const wordMode = String(payload?.wordMode || "");
    if ([30, 60, 90].includes(roundSeconds)) room.settings.roundSeconds = roundSeconds;
    if ([4, 6, 8, 10].includes(totalRounds)) room.settings.totalRounds = totalRounds;
    if (WORD_MODES.has(wordMode)) room.settings.wordMode = wordMode;
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("start-game", (_payload, callbackCandidate) => {
    const callback = safeCallback(callbackCandidate);
    const room = rooms.get(socket.data.roomCode);
    if (!room) return callback({ ok: false, error: "Room not found." });
    if (room.hostToken !== socket.data.playerToken) return callback({ ok: false, error: "Only the host can start the game." });
    if (room.players.length !== 2 || !room.players.every((player) => player.connected)) {
      return callback({ ok: false, error: "Both players need to be connected." });
    }

    room.players.forEach((player) => {
      player.score = 0;
      player.correct = 0;
      player.skipped = 0;
    });
    room.game = {
      round: 1,
      explainerIndex: crypto.randomInt(2),
      roundCorrect: 0,
      roundSkipped: 0,
      currentWord: null,
      endsAt: null,
      lastRound: null,
      deck: makeDeck(room.settings.wordMode),
      deckIndex: 0,
      timer: null,
    };
    room.phase = "round_intro";
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("start-round", (_payload, callbackCandidate) => {
    const callback = safeCallback(callbackCandidate);
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return callback({ ok: false, error: "Game not found." });
    if (room.phase !== "round_intro") return callback({ ok: false, error: "The round cannot start yet." });
    if (getExplainer(room)?.token !== socket.data.playerToken) {
      return callback({ ok: false, error: "Only the explainer can start this round." });
    }

    room.game.roundCorrect = 0;
    room.game.roundSkipped = 0;
    room.game.lastRound = null;
    room.game.currentWord = nextWord(room);
    room.phase = "playing";
    startRoundTimer(room);
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("mark-word", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return callback({ ok: false, error: "Game not found." });
    if (room.phase !== "playing") return callback({ ok: false, error: "The round has ended." });
    const explainer = getExplainer(room);
    if (explainer?.token !== socket.data.playerToken) {
      return callback({ ok: false, error: "Only the explainer can score words." });
    }

    const action = payload?.action;
    if (action === "correct") {
      room.game.roundCorrect += 1;
      explainer.correct += 1;
      explainer.score += 1;
    } else if (action === "skip") {
      room.game.roundSkipped += 1;
      explainer.skipped += 1;
      explainer.score -= 1;
    } else {
      return callback({ ok: false, error: "Unknown scoring action." });
    }

    room.game.currentWord = nextWord(room);
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("next-round", (_payload, callbackCandidate) => {
    const callback = safeCallback(callbackCandidate);
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return callback({ ok: false, error: "Game not found." });
    if (room.hostToken !== socket.data.playerToken) return callback({ ok: false, error: "Only the host can continue." });
    if (room.phase !== "round_result") return callback({ ok: false, error: "The current round is not finished." });

    if (room.game.round >= room.settings.totalRounds) {
      room.phase = "finished";
    } else {
      room.game.round += 1;
      room.game.explainerIndex = (room.game.explainerIndex + 1) % room.players.length;
      room.game.roundCorrect = 0;
      room.game.roundSkipped = 0;
      room.game.currentWord = null;
      room.game.endsAt = null;
      room.phase = "round_intro";
    }
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("back-to-lobby", (_payload, callbackCandidate) => {
    const callback = safeCallback(callbackCandidate);
    const room = rooms.get(socket.data.roomCode);
    if (!room) return callback({ ok: false, error: "Room not found." });
    if (room.hostToken !== socket.data.playerToken) return callback({ ok: false, error: "Only the host can reset the game." });
    clearGameTimer(room);
    room.game = null;
    room.phase = "lobby";
    room.players.forEach((player) => {
      player.score = 0;
      player.correct = 0;
      player.skipped = 0;
    });
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("disconnect", () => detachFromCurrentRoom(socket, false));
});

server.listen(PORT, () => {
  console.log(`ClueWave is running at http://localhost:${PORT}`);
  console.log(`Loaded ${ENGLISH_WORDS.length} English and ${UKRAINIAN_WORDS.length} Ukrainian words.`);
});

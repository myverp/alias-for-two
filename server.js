const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const express = require("express");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT) || 3000;
const DEFAULT_ROUND_SECONDS = 60;
const GAME_TYPES = new Set(["alias", "taboo", "password", "categories", "whoami"]);
const WORD_MODES = new Set(["english_easy", "english_medium", "ukrainian_mixed"]);
const DIFFICULTIES = new Set(["easy", "normal"]);
const CATEGORY_LETTERS = "ABCDEFGHJKLMNPRSTW".split("");
const dataPath = (...parts) => path.join(__dirname, "data", ...parts);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: false }, maxHttpBufferSize: 100_000 });
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

function loadCsv(filename) {
  const lines = fs.readFileSync(dataPath(filename), "utf8").replace(/^\uFEFF/, "").split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  return lines.slice(1).map((line) => Object.fromEntries(headers.map((header, index) => [header, parseCsvLine(line)[index] || ""])));
}

const ENGLISH_WORDS = loadCsv("alias_words_1000.csv").map(({ word }) => word).filter(Boolean);
const UKRAINIAN_WORDS = loadCsv("ukrainian_words.csv").filter(({ word, difficulty }) => word && DIFFICULTIES.has(difficulty));
const TABOO_CARDS = loadCsv("taboo_cards.csv").map((row) => ({
  target: row.target,
  forbidden: [row.forbidden1, row.forbidden2, row.forbidden3, row.forbidden4, row.forbidden5].filter(Boolean),
}));
const WHO_AM_I = loadCsv("who_am_i.csv").filter(({ name, category }) => name && category);
const CATEGORY_POOL = loadCsv("categories.csv").map(({ category }) => category).filter(Boolean);

if (![ENGLISH_WORDS, UKRAINIAN_WORDS, TABOO_CARDS, WHO_AM_I, CATEGORY_POOL].every((deck) => deck.length > 0)) {
  throw new Error("One or more game datasets are empty.");
}

app.disable("x-powered-by");
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("/health", (_request, response) => {
  response.json({
    ok: true,
    rooms: rooms.size,
    games: GAME_TYPES.size,
    datasets: {
      words: ENGLISH_WORDS.length + UKRAINIAN_WORDS.length,
      taboo: TABOO_CARDS.length,
      identities: WHO_AM_I.length,
      categories: CATEGORY_POOL.length,
    },
  });
});

function sanitizeName(value) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, 24);
}

function sanitizeAnswer(value, maxLength = 50) {
  return String(value || "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function normalizeAnswer(value) {
  return sanitizeAnswer(value, 100).toLocaleLowerCase().replace(/[^a-zа-яіїєґ0-9]/giu, "");
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
    for (let index = 0; index < 6; index += 1) code += alphabet[crypto.randomInt(alphabet.length)];
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
  if (room.game?.timer) clearTimeout(room.game.timer);
  if (room.game) room.game.timer = null;
}

function getPlayer(room, token) {
  return room.players.find((player) => player.token === token);
}

function getPlayerIndex(room, token) {
  return room.players.findIndex((player) => player.token === token);
}

function getExplainer(room) {
  return room.game ? room.players[room.game.explainerIndex] : null;
}

function getGuesser(room) {
  return room.game ? room.players[(room.game.explainerIndex + 1) % room.players.length] : null;
}

function touchRoom(room) {
  room.lastActiveAt = Date.now();
  if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
  room.cleanupTimer = null;
}

function scheduleRoomCleanup(room) {
  if (room.players.some((player) => player.connected) || room.cleanupTimer) return;
  room.cleanupTimer = setTimeout(() => {
    clearGameTimer(room);
    rooms.delete(room.code);
  }, 30 * 60 * 1000);
}

function makeWordDeck(wordMode) {
  if (wordMode === "english_easy") return shuffle(ENGLISH_WORDS.filter((word) => word.length <= 6));
  if (wordMode === "english_medium") return shuffle(ENGLISH_WORDS.filter((word) => word.length > 6));
  return shuffle(UKRAINIAN_WORDS.map(({ word }) => word));
}

function makeDeck(room) {
  if (room.settings.gameType === "taboo") return shuffle(TABOO_CARDS);
  if (room.settings.gameType === "whoami") return shuffle(WHO_AM_I);
  return makeWordDeck(room.settings.wordMode);
}

function nextPrompt(room) {
  if (room.game.deckIndex >= room.game.deck.length) {
    room.game.deck = makeDeck(room);
    room.game.deckIndex = 0;
  }
  const prompt = room.game.deck[room.game.deckIndex];
  room.game.deckIndex += 1;
  return prompt;
}

function publicGameState(room, player) {
  if (!room.game) return null;
  const game = room.game;
  const explainer = getExplainer(room);
  const guesser = getGuesser(room);
  const isExplainer = explainer?.token === player.token;
  const isGuesser = guesser?.token === player.token;
  const state = {
    round: game.round,
    totalRounds: room.settings.totalRounds,
    explainerName: explainer?.name || "",
    guesserName: guesser?.name || "",
    isExplainer,
    isGuesser,
    roundCorrect: game.roundCorrect,
    roundSkipped: game.roundSkipped,
    roundDelta: game.roundCorrect - game.roundSkipped,
    timerExpired: game.timerExpired,
    remainingMs: game.endsAt ? Math.max(0, game.endsAt - Date.now()) : null,
    lastRound: game.lastRound,
  };

  if (room.settings.gameType === "alias" && room.phase === "playing" && isExplainer) state.word = game.currentPrompt;
  if (room.settings.gameType === "taboo" && room.phase === "playing" && isExplainer) state.tabooCard = game.currentPrompt;

  if (room.settings.gameType === "password") {
    state.attempts = game.attempts;
    state.maxAttempts = 5;
    state.clue = game.clue;
    if (isExplainer && ["password_clue", "password_guess"].includes(room.phase)) state.word = game.currentPrompt;
  }

  if (room.settings.gameType === "whoami") {
    state.questions = game.questions;
    state.maxQuestions = 20;
    state.lastAnswer = game.lastAnswer;
    if (isExplainer && room.phase === "playing") state.identity = game.currentPrompt;
  }

  if (room.settings.gameType === "categories") {
    const playerIndex = getPlayerIndex(room, player.token);
    state.letter = game.categoryLetter;
    state.categories = game.categoryNames || [];
    state.answers = game.categoryAnswers?.[playerIndex] || [];
    state.submitted = game.categorySubmitted?.[playerIndex] || false;
    state.submittedCount = game.categorySubmitted?.filter(Boolean).length || 0;
    if (room.phase === "category_review") {
      state.categoryReview = room.players.map((roomPlayer, index) => ({
        playerIndex: index,
        name: roomPlayer.name,
        answers: (game.categoryNames || []).map((category, categoryIndex) => ({
          category,
          answer: game.categoryAnswers[index][categoryIndex],
          accepted: game.categoryAccepted[index][categoryIndex],
        })),
      }));
    }
  }
  return state;
}

function publicStateFor(room, player) {
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
    game: publicGameState(room, player),
  };
}

function emitRoomState(room) {
  touchRoom(room);
  for (const player of room.players) {
    if (player.connected && player.socketId) io.to(player.socketId).emit("room-state", publicStateFor(room, player));
  }
}

function startRoundTimer(room, mode = "overtime") {
  const duration = room.settings.roundSeconds * 1000;
  room.game.timerExpired = false;
  room.game.endsAt = Date.now() + duration;
  room.game.timer = setTimeout(() => {
    if (!room.game || room.phase !== "playing") return;
    room.game.timer = null;
    room.game.timerExpired = true;
    room.game.endsAt = null;
    if (mode === "categories") finishCategoriesRound(room);
    else emitRoomState(room);
  }, duration + 100);
}

function finishScoredWordRound(room) {
  if (!room.game || room.phase !== "playing") return;
  clearGameTimer(room);
  const explainer = getExplainer(room);
  room.game.lastRound = {
    type: room.settings.gameType,
    explainerName: explainer.name,
    correct: room.game.roundCorrect,
    skipped: room.game.roundSkipped,
    delta: room.game.roundCorrect - room.game.roundSkipped,
  };
  room.game.currentPrompt = null;
  room.game.endsAt = null;
  room.phase = "round_result";
  emitRoomState(room);
}

function finishSimpleRound(room, result) {
  clearGameTimer(room);
  room.game.lastRound = result;
  room.game.currentPrompt = null;
  room.game.endsAt = null;
  room.phase = "round_result";
  emitRoomState(room);
}

function finishCategoriesRound(room) {
  if (!room.game || room.phase !== "playing" || room.settings.gameType !== "categories") return;
  clearGameTimer(room);
  const game = room.game;
  game.endsAt = null;
  game.timerExpired = true;
  game.categorySubmitted = [true, true];
  game.categoryAccepted = [[], []];
  for (let categoryIndex = 0; categoryIndex < game.categoryNames.length; categoryIndex += 1) {
    const first = normalizeAnswer(game.categoryAnswers[0][categoryIndex]);
    const second = normalizeAnswer(game.categoryAnswers[1][categoryIndex]);
    const duplicated = Boolean(first && second && first === second);
    game.categoryAccepted[0][categoryIndex] = Boolean(first) && !duplicated;
    game.categoryAccepted[1][categoryIndex] = Boolean(second) && !duplicated;
  }
  room.players.forEach((player, playerIndex) => {
    const points = game.categoryAccepted[playerIndex].filter(Boolean).length;
    player.score += points;
    player.correct += points;
  });
  room.phase = "category_review";
  emitRoomState(room);
}

function attachPlayerToSocket(socket, room, player) {
  if (player.socketId && player.socketId !== socket.id) io.sockets.sockets.get(player.socketId)?.disconnect(true);
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
  if (removePlayer && room.phase === "lobby") room.players = room.players.filter((candidate) => candidate.token !== player.token);
  if (room.players.length === 0) {
    clearGameTimer(room);
    rooms.delete(room.code);
    return;
  }
  if (room.hostToken === player.token) room.hostToken = room.players.find((candidate) => candidate.connected)?.token || room.players[0].token;
  emitRoomState(room);
  scheduleRoomCleanup(room);
}

function createPlayer(name, socket) {
  return { token: crypto.randomUUID(), name, socketId: socket.id, connected: true, score: 0, correct: 0, skipped: 0 };
}

io.on("connection", (socket) => {
  socket.on("create-room", (payload, callback = () => {}) => {
    const name = sanitizeName(payload?.name);
    if (!name) return callback({ ok: false, error: "Enter your name first." });
    detachFromCurrentRoom(socket, true);
    const code = createRoomCode();
    const player = createPlayer(name, socket);
    const room = {
      code,
      hostToken: player.token,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      cleanupTimer: null,
      phase: "lobby",
      settings: { gameType: "alias", roundSeconds: DEFAULT_ROUND_SECONDS, totalRounds: 6, wordMode: "english_easy" },
      players: [player],
      game: null,
    };
    rooms.set(code, room);
    attachPlayerToSocket(socket, room, player);
    callback({ ok: true, code, token: player.token });
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
      player = createPlayer(name, socket);
      room.players.push(player);
    } else if (name) player.name = name;
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
    const gameType = String(payload?.gameType || "");
    const roundSeconds = Number(payload?.roundSeconds);
    const totalRounds = Number(payload?.totalRounds);
    const wordMode = String(payload?.wordMode || "");
    if (GAME_TYPES.has(gameType)) room.settings.gameType = gameType;
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
    room.players.forEach((player) => Object.assign(player, { score: 0, correct: 0, skipped: 0 }));
    room.game = {
      round: 1,
      explainerIndex: crypto.randomInt(2),
      roundCorrect: 0,
      roundSkipped: 0,
      currentPrompt: null,
      endsAt: null,
      timerExpired: false,
      lastRound: null,
      deck: room.settings.gameType === "categories" ? [] : makeDeck(room),
      deckIndex: 0,
      timer: null,
      clue: null,
      attempts: 0,
      questions: 0,
      lastAnswer: null,
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
    const gameType = room.settings.gameType;
    const canStart = gameType === "categories" ? room.hostToken === socket.data.playerToken : getExplainer(room)?.token === socket.data.playerToken;
    if (!canStart) return callback({ ok: false, error: gameType === "categories" ? "Only the host can start this round." : "Only the clue giver can start this round." });

    Object.assign(room.game, {
      roundCorrect: 0,
      roundSkipped: 0,
      lastRound: null,
      timerExpired: false,
      clue: null,
      attempts: 0,
      questions: 0,
      lastAnswer: null,
    });

    if (gameType === "categories") {
      room.game.categoryLetter = CATEGORY_LETTERS[crypto.randomInt(CATEGORY_LETTERS.length)];
      room.game.categoryNames = shuffle(CATEGORY_POOL).slice(0, 4);
      room.game.categoryAnswers = [Array(4).fill(""), Array(4).fill("")];
      room.game.categorySubmitted = [false, false];
      room.game.categoryAccepted = null;
      room.phase = "playing";
      startRoundTimer(room, "categories");
    } else {
      room.game.currentPrompt = nextPrompt(room);
      if (["alias", "taboo"].includes(gameType)) {
        room.phase = "playing";
        startRoundTimer(room);
      } else if (gameType === "password") room.phase = "password_clue";
      else room.phase = "playing";
    }
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("mark-word", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return callback({ ok: false, error: "Game not found." });
    if (!["alias", "taboo"].includes(room.settings.gameType) || room.phase !== "playing") return callback({ ok: false, error: "This action is not available." });
    const explainer = getExplainer(room);
    if (explainer?.token !== socket.data.playerToken) return callback({ ok: false, error: "Only the clue giver can score words." });
    const action = payload?.action;
    if (action === "correct") {
      room.game.roundCorrect += 1;
      explainer.correct += 1;
      explainer.score += 1;
    } else if (action === "skip") {
      room.game.roundSkipped += 1;
      explainer.skipped += 1;
      explainer.score -= 1;
    } else return callback({ ok: false, error: "Unknown scoring action." });
    callback({ ok: true });
    if (room.game.timerExpired) return finishScoredWordRound(room);
    room.game.currentPrompt = nextPrompt(room);
    emitRoomState(room);
  });

  socket.on("adjust-round-result", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game?.lastRound) return callback({ ok: false, error: "Round result not found." });
    if (room.phase !== "round_result" || !["alias", "taboo"].includes(room.settings.gameType)) return callback({ ok: false, error: "This result cannot be edited." });
    const field = payload?.field;
    const delta = Number(payload?.delta);
    if (!["correct", "skipped"].includes(field) || ![-1, 1].includes(delta)) return callback({ ok: false, error: "Unknown result adjustment." });
    const result = room.game.lastRound;
    if (result[field] + delta < 0) return callback({ ok: false, error: "The result cannot be negative." });
    const explainer = getExplainer(room);
    result[field] += delta;
    room.game[field === "correct" ? "roundCorrect" : "roundSkipped"] = result[field];
    explainer[field] += delta;
    explainer.score += field === "correct" ? delta : -delta;
    result.delta = result.correct - result.skipped;
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("submit-password-clue", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "password" || room.phase !== "password_clue") return callback({ ok: false, error: "A clue is not expected now." });
    if (getExplainer(room)?.token !== socket.data.playerToken) return callback({ ok: false, error: "Only the clue giver can submit a clue." });
    const clue = sanitizeAnswer(payload?.clue, 30);
    if (!clue || clue.split(/\s+/).length !== 1) return callback({ ok: false, error: "Use exactly one word for the clue." });
    if (normalizeAnswer(clue) === normalizeAnswer(room.game.currentPrompt)) return callback({ ok: false, error: "The clue cannot be the password itself." });
    room.game.clue = clue;
    room.phase = "password_guess";
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("submit-password-guess", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "password" || room.phase !== "password_guess") return callback({ ok: false, error: "A guess is not expected now." });
    const guesser = getGuesser(room);
    if (guesser?.token !== socket.data.playerToken) return callback({ ok: false, error: "Only the guesser can answer." });
    const guess = sanitizeAnswer(payload?.guess, 50);
    if (!guess) return callback({ ok: false, error: "Enter a guess first." });
    room.game.attempts += 1;
    const guessed = normalizeAnswer(guess) === normalizeAnswer(room.game.currentPrompt);
    callback({ ok: true, guessed });
    if (guessed || room.game.attempts >= 5) {
      if (guessed) {
        guesser.score += 1;
        guesser.correct += 1;
      }
      finishSimpleRound(room, {
        type: "password",
        word: room.game.currentPrompt,
        guessed,
        attempts: room.game.attempts,
        guesserName: guesser.name,
      });
    } else {
      room.game.clue = null;
      room.phase = "password_clue";
      emitRoomState(room);
    }
  });

  socket.on("answer-whoami", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "whoami" || room.phase !== "playing") return callback({ ok: false, error: "This action is not available." });
    if (getExplainer(room)?.token !== socket.data.playerToken) return callback({ ok: false, error: "Only the helper can answer." });
    const answer = String(payload?.answer || "").toLowerCase();
    if (!["yes", "no", "maybe"].includes(answer)) return callback({ ok: false, error: "Unknown answer." });
    if (room.game.questions >= 20) return callback({ ok: false, error: "The 20-question limit has been reached." });
    room.game.questions += 1;
    room.game.lastAnswer = answer;
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("finish-whoami", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "whoami" || room.phase !== "playing") return callback({ ok: false, error: "This action is not available." });
    if (getExplainer(room)?.token !== socket.data.playerToken) return callback({ ok: false, error: "Only the helper can finish this round." });
    const guessed = payload?.outcome === "correct";
    if (!guessed && payload?.outcome !== "pass") return callback({ ok: false, error: "Unknown outcome." });
    const guesser = getGuesser(room);
    if (guessed) {
      guesser.score += 1;
      guesser.correct += 1;
    }
    callback({ ok: true });
    finishSimpleRound(room, {
      type: "whoami",
      identity: room.game.currentPrompt.name,
      category: room.game.currentPrompt.category,
      guessed,
      questions: room.game.questions,
      guesserName: guesser.name,
    });
  });

  socket.on("update-category-draft", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "categories" || room.phase !== "playing") return callback({ ok: false, error: "Categories are not active." });
    const playerIndex = getPlayerIndex(room, socket.data.playerToken);
    if (playerIndex < 0 || room.game.categorySubmitted[playerIndex]) return callback({ ok: false, error: "Answers are already submitted." });
    const answers = Array.isArray(payload?.answers) ? payload.answers.slice(0, 4).map((answer) => sanitizeAnswer(answer)) : [];
    while (answers.length < 4) answers.push("");
    room.game.categoryAnswers[playerIndex] = answers;
    callback({ ok: true });
  });

  socket.on("submit-categories", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "categories" || room.phase !== "playing") return callback({ ok: false, error: "Categories are not active." });
    const playerIndex = getPlayerIndex(room, socket.data.playerToken);
    if (playerIndex < 0) return callback({ ok: false, error: "Player not found." });
    const answers = Array.isArray(payload?.answers) ? payload.answers.slice(0, 4).map((answer) => sanitizeAnswer(answer)) : room.game.categoryAnswers[playerIndex];
    while (answers.length < 4) answers.push("");
    room.game.categoryAnswers[playerIndex] = answers;
    room.game.categorySubmitted[playerIndex] = true;
    callback({ ok: true });
    if (room.game.categorySubmitted.every(Boolean)) finishCategoriesRound(room);
    else emitRoomState(room);
  });

  socket.on("toggle-category-answer", (payload, callback = () => {}) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.settings.gameType !== "categories" || room.phase !== "category_review") return callback({ ok: false, error: "Category review is not active." });
    if (room.hostToken !== socket.data.playerToken) return callback({ ok: false, error: "Only the host can review answers." });
    const playerIndex = Number(payload?.playerIndex);
    const categoryIndex = Number(payload?.categoryIndex);
    if (![0, 1].includes(playerIndex) || !Number.isInteger(categoryIndex) || categoryIndex < 0 || categoryIndex >= 4) return callback({ ok: false, error: "Unknown answer." });
    if (!room.game.categoryAnswers[playerIndex][categoryIndex]) return callback({ ok: false, error: "An empty answer cannot score." });
    const wasAccepted = room.game.categoryAccepted[playerIndex][categoryIndex];
    room.game.categoryAccepted[playerIndex][categoryIndex] = !wasAccepted;
    const delta = wasAccepted ? -1 : 1;
    room.players[playerIndex].score += delta;
    room.players[playerIndex].correct += delta;
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("next-round", (_payload, callbackCandidate) => {
    const callback = safeCallback(callbackCandidate);
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.game) return callback({ ok: false, error: "Game not found." });
    if (room.hostToken !== socket.data.playerToken) return callback({ ok: false, error: "Only the host can continue." });
    if (!["round_result", "category_review"].includes(room.phase)) return callback({ ok: false, error: "The current round is not finished." });
    if (room.game.round >= room.settings.totalRounds) room.phase = "finished";
    else {
      room.game.round += 1;
      room.game.explainerIndex = (room.game.explainerIndex + 1) % room.players.length;
      Object.assign(room.game, {
        roundCorrect: 0,
        roundSkipped: 0,
        currentPrompt: null,
        endsAt: null,
        timerExpired: false,
        lastRound: null,
        clue: null,
        attempts: 0,
        questions: 0,
        lastAnswer: null,
      });
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
    room.players.forEach((player) => Object.assign(player, { score: 0, correct: 0, skipped: 0 }));
    callback({ ok: true });
    emitRoomState(room);
  });

  socket.on("disconnect", () => detachFromCurrentRoom(socket, false));
});

server.listen(PORT, () => {
  console.log(`ClueWave is running at http://localhost:${PORT}`);
  console.log(`Loaded 5 games and ${ENGLISH_WORDS.length + UKRAINIAN_WORDS.length + TABOO_CARDS.length + WHO_AM_I.length} prompts.`);
});

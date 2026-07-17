const socket = io({ reconnection: true, reconnectionAttempts: Infinity });

const homeView = document.querySelector("#homeView");
const roomView = document.querySelector("#roomView");
const roomContent = document.querySelector("#roomContent");
const toolbarCode = document.querySelector("#toolbarCode");
const connectionBadge = document.querySelector("#connectionBadge");
const connectionLabel = document.querySelector(".connection-label");
const createForm = document.querySelector("#createForm");
const joinForm = document.querySelector("#joinForm");
const entryDivider = document.querySelector(".divider");
const createNameInput = document.querySelector("#createName");
const joinNameInput = document.querySelector("#joinName");
const roomCodeInput = document.querySelector("#roomCode");
const leaveButton = document.querySelector("#leaveButton");
const toast = document.querySelector("#toast");
const playerTemplate = document.querySelector("#playerTemplate");

const SESSION_KEY = "clueWaveSession";
let roomState = null;
let countdownInterval = null;
let toastTimeout = null;
let pendingRejoin = false;

const params = new URLSearchParams(window.location.search);
const sharedRoomCode = (params.get("room") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
if (sharedRoomCode) {
  roomCodeInput.value = sharedRoomCode;
  createForm.hidden = true;
  entryDivider.hidden = true;
  document.querySelector("#entryTitle").textContent = "Join the room";
  document.querySelector("#entrySubtitle").textContent = "Your partner is waiting for you.";
}

function getSession() {
  try {
    return JSON.parse(localStorage.getItem(SESSION_KEY) || "null");
  } catch {
    return null;
  }
}

function saveSession(code, token, name) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ code, token, name }));
  history.replaceState({}, "", `/?room=${encodeURIComponent(code)}`);
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY);
  history.replaceState({}, "", "/");
}

function setConnectionStatus(connected) {
  connectionBadge.classList.toggle("is-online", connected);
  connectionBadge.classList.toggle("is-offline", !connected);
  connectionLabel.textContent = connected ? "Connected" : "Reconnecting";
}

function showToast(message, type = "default") {
  clearTimeout(toastTimeout);
  toast.textContent = message;
  toast.className = `toast show ${type === "error" ? "error" : ""}`;
  toastTimeout = setTimeout(() => {
    toast.classList.remove("show");
  }, 3200);
}

function setButtonBusy(button, busy, label = "Working…") {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.innerHTML;
    button.textContent = label;
    button.disabled = true;
  } else {
    button.innerHTML = button.dataset.originalLabel || button.innerHTML;
    button.disabled = false;
  }
}

function emitWithFeedback(event, payload, callback) {
  socket.emit(event, payload, (result) => {
    if (!result?.ok) showToast(result?.error || "Something went wrong.", "error");
    callback?.(result);
  });
}

function enterRoom(code, token, name) {
  saveSession(code, token, name);
  homeView.hidden = true;
  roomView.hidden = false;
  toolbarCode.textContent = code;
}

function returnHome() {
  roomState = null;
  clearInterval(countdownInterval);
  roomContent.replaceChildren();
  homeView.hidden = false;
  roomView.hidden = true;
  createForm.hidden = false;
  entryDivider.hidden = false;
  document.querySelector("#entryTitle").textContent = "Start a game";
  document.querySelector("#entrySubtitle").textContent = "Create a room and invite your favourite person.";
  createForm.reset();
  joinForm.reset();
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createGameCard(extraClass = "") {
  return createElement("div", `card game-card ${extraClass}`.trim());
}

function addHeading(container, kicker, title, subtitle) {
  container.append(createElement("p", "section-kicker", kicker));
  container.append(createElement("h1", "section-title", title));
  container.append(createElement("p", "section-subtitle", subtitle));
}

function makeButton(label, className, onClick) {
  const button = createElement("button", `button ${className}`, label);
  button.type = "button";
  button.addEventListener("click", () => onClick(button));
  return button;
}

function renderPlayer(player) {
  const node = playerTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".avatar").textContent = player.name.slice(0, 1).toUpperCase();
  node.querySelector(".player-name").textContent = player.name;
  const roleParts = [];
  if (player.isSelf) roleParts.push("You");
  if (player.isHost) roleParts.push("Host");
  node.querySelector(".player-role").textContent = roleParts.join(" · ") || "Player";
  node.querySelector(".player-status").classList.toggle("offline", !player.connected);
  node.querySelector(".player-status").title = player.connected ? "Connected" : "Disconnected";
  return node;
}

function renderLobby() {
  const card = createGameCard();
  addHeading(card, "Room ready", "Invite your person", "Share the private link below. The game starts when both of you are here.");

  const inviteBox = createElement("div", "invite-box");
  const inviteText = createElement("div");
  inviteText.append(createElement("span", "", "Room code"));
  inviteText.append(createElement("strong", "", roomState.code));
  const copyButton = createElement("button", "copy-button", "Copy invite link");
  copyButton.type = "button";
  copyButton.addEventListener("click", async () => {
    const inviteUrl = `${window.location.origin}/?room=${roomState.code}`;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      showToast("Invite link copied.");
    } catch {
      window.prompt("Copy this invite link:", inviteUrl);
    }
  });
  inviteBox.append(inviteText, copyButton);
  card.append(inviteBox);

  const lobbyGrid = createElement("div", "lobby-grid");
  const playerColumn = createElement("div");
  playerColumn.append(createElement("h2", "subsection-title", "Players"));
  const playersList = createElement("div", "players-list");
  roomState.players.forEach((player) => playersList.append(renderPlayer(player)));
  if (roomState.players.length < 2) {
    playersList.append(createElement("div", "empty-player", "Waiting for your partner…"));
  }
  playerColumn.append(playersList);

  const settingsColumn = createElement("div");
  settingsColumn.append(createElement("h2", "subsection-title", "Game settings"));
  const settingsGrid = createElement("div", "settings-grid");
  const durationLabel = createElement("label", "", "Round time");
  const durationSelect = createElement("select");
  [30, 45, 60, 90].forEach((value) => {
    const option = createElement("option", "", `${value} seconds`);
    option.value = String(value);
    option.selected = roomState.settings.roundSeconds === value;
    durationSelect.append(option);
  });
  durationSelect.disabled = !roomState.isHost;
  durationLabel.append(durationSelect);

  const roundsLabel = createElement("label", "", "Total rounds");
  const roundsSelect = createElement("select");
  [4, 6, 8, 10].forEach((value) => {
    const option = createElement("option", "", `${value} rounds`);
    option.value = String(value);
    option.selected = roomState.settings.totalRounds === value;
    roundsSelect.append(option);
  });
  roundsSelect.disabled = !roomState.isHost;
  roundsLabel.append(roundsSelect);
  settingsGrid.append(durationLabel, roundsLabel);
  settingsColumn.append(settingsGrid);
  settingsColumn.append(createElement("p", "settings-note", "Classic scoring: +1 for a correct word and −1 for a skip. The explainer changes every round."));

  const updateSettings = () => {
    emitWithFeedback("update-settings", {
      roundSeconds: Number(durationSelect.value),
      totalRounds: Number(roundsSelect.value),
    });
  };
  durationSelect.addEventListener("change", updateSettings);
  roundsSelect.addEventListener("change", updateSettings);
  lobbyGrid.append(playerColumn, settingsColumn);
  card.append(lobbyGrid);

  if (roomState.isHost) {
    const startButton = makeButton("Start game →", "button-primary button-large lobby-action", (button) => {
      setButtonBusy(button, true, "Starting…");
      emitWithFeedback("start-game", {}, (result) => {
        if (!result?.ok) setButtonBusy(button, false);
      });
    });
    startButton.disabled = roomState.players.length !== 2 || !roomState.players.every((player) => player.connected);
    card.append(startButton);
    if (startButton.disabled) card.append(createElement("p", "waiting-note", "Both players need to be connected before you can start."));
  } else {
    card.append(createElement("p", "waiting-note", "The host will start the game when you are both ready."));
  }

  roomContent.replaceChildren(card);
}

function addRoundMeta(card) {
  const meta = createElement("div", "round-meta");
  meta.append(createElement("span", "", `Round ${roomState.game.round} of ${roomState.game.totalRounds}`));
  meta.append(createElement("span", "", `${roomState.settings.roundSeconds}s · Classic score`));
  card.append(meta);
}

function renderRoundIntro() {
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const initial = roomState.game.explainerName.slice(0, 1).toUpperCase();
  card.append(createElement("div", "round-avatar", initial));
  const title = roomState.game.isExplainer ? "You explain this round" : `${roomState.game.explainerName} explains`;
  const subtitle = roomState.game.isExplainer
    ? "Your partner will hear your clues on the call. The secret word appears only on this screen."
    : "Listen on your call and guess as many words as you can. The secret word stays hidden here.";
  addHeading(card, "Next up", title, subtitle);

  const actions = createElement("div", "round-actions");
  if (roomState.game.isExplainer) {
    actions.append(makeButton("Reveal first word →", "button-primary button-large", (button) => {
      setButtonBusy(button, true, "Getting ready…");
      emitWithFeedback("start-round", {}, (result) => {
        if (!result?.ok) setButtonBusy(button, false);
      });
    }));
  } else {
    const waitingButton = makeButton("Waiting for partner…", "button-secondary button-large", () => {});
    waitingButton.disabled = true;
    actions.append(waitingButton);
  }
  card.append(actions);
  roomContent.replaceChildren(card);
}

function updateTimer() {
  const timerNumber = document.querySelector("#timerNumber");
  const timerFill = document.querySelector("#timerFill");
  if (!timerNumber || !timerFill || !roomState?.game?.endsAt) return;
  const remainingMs = Math.max(0, roomState.game.endsAt - Date.now());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const ratio = Math.max(0, Math.min(1, remainingMs / (roomState.settings.roundSeconds * 1000)));
  timerNumber.textContent = `${remainingSeconds}s`;
  timerFill.style.transform = `scaleX(${ratio})`;
}

function renderPlaying() {
  const card = createGameCard("round-card");
  addRoundMeta(card);

  const timerWrap = createElement("div", "timer-wrap");
  const timerHead = createElement("div", "timer-head");
  timerHead.append(createElement("span", "", "Time left"));
  const timerNumber = createElement("strong", "timer-number", "0s");
  timerNumber.id = "timerNumber";
  timerHead.append(timerNumber);
  const timerTrack = createElement("div", "timer-track");
  const timerFill = createElement("div", "timer-fill");
  timerFill.id = "timerFill";
  timerTrack.append(timerFill);
  timerWrap.append(timerHead, timerTrack);
  card.append(timerWrap);

  const scoreStrip = createElement("div", "score-strip");
  [
    ["Correct", roomState.game.roundCorrect],
    ["Skipped", roomState.game.roundSkipped],
    ["Round score", roomState.game.roundDelta > 0 ? `+${roomState.game.roundDelta}` : roomState.game.roundDelta],
  ].forEach(([label, value]) => {
    const item = createElement("div");
    item.append(createElement("span", "", label));
    item.append(createElement("strong", "", String(value)));
    scoreStrip.append(item);
  });
  card.append(scoreStrip);

  if (roomState.game.isExplainer) {
    const wordCard = createElement("div", "word-card");
    wordCard.append(createElement("span", "", roomState.game.word || "…"));
    card.append(wordCard);
    const actions = createElement("div", "play-actions");
    actions.append(makeButton("Skip −1", "button-danger-soft", (button) => scoreWord(button, "skip")));
    actions.append(makeButton("Correct +1", "button-success", (button) => scoreWord(button, "correct")));
    card.append(actions);
  } else {
    const listenVisual = createElement("div", "listen-visual");
    for (let index = 0; index < 5; index += 1) listenVisual.append(createElement("span"));
    card.append(listenVisual);
    card.append(createElement("p", "section-subtitle", `Listen to ${roomState.game.explainerName} and say your guesses out loud.`));
  }

  roomContent.replaceChildren(card);
  clearInterval(countdownInterval);
  updateTimer();
  countdownInterval = setInterval(updateTimer, 100);
}

function scoreWord(button, action) {
  const buttons = document.querySelectorAll(".play-actions button");
  buttons.forEach((candidate) => { candidate.disabled = true; });
  emitWithFeedback("mark-word", { action }, (result) => {
    if (!result?.ok) buttons.forEach((candidate) => { candidate.disabled = false; });
  });
}

function renderRoundResult() {
  clearInterval(countdownInterval);
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const result = roomState.game.lastRound;
  const isLastRound = roomState.game.round >= roomState.game.totalRounds;
  addHeading(card, "Time", `${result.explainerName}'s round is done`, isLastRound ? "That was the final round. One more tap reveals the result." : "Nice work. Take a breath, then switch roles for the next round.");

  const resultGrid = createElement("div", "result-grid");
  [
    ["Correct", result.correct, "positive"],
    ["Skipped", result.skipped, "negative"],
    ["Round score", result.delta > 0 ? `+${result.delta}` : result.delta, result.delta >= 0 ? "positive" : "negative"],
  ].forEach(([label, value, modifier]) => {
    const stat = createElement("div", `result-stat ${modifier}`);
    stat.append(createElement("span", "", label));
    stat.append(createElement("strong", "", String(value)));
    resultGrid.append(stat);
  });
  card.append(resultGrid);

  const actions = createElement("div", "round-actions");
  if (roomState.isHost) {
    actions.append(makeButton(isLastRound ? "See final result →" : "Next round →", "button-primary button-large", (button) => {
      setButtonBusy(button, true, "Loading…");
      emitWithFeedback("next-round", {}, (response) => {
        if (!response?.ok) setButtonBusy(button, false);
      });
    }));
  } else {
    const waitingButton = makeButton("Waiting for host…", "button-secondary button-large", () => {});
    waitingButton.disabled = true;
    actions.append(waitingButton);
  }
  card.append(actions);
  roomContent.replaceChildren(card);
}

function renderFinished() {
  const card = createGameCard("round-card");
  const rankedPlayers = [...roomState.players].sort((a, b) => b.score - a.score);
  const isTie = rankedPlayers[0].score === rankedPlayers[1].score;
  const title = isTie ? "Perfectly in sync" : `${rankedPlayers[0].name} takes this one`;
  addHeading(card, "Game complete", title, isTie ? "A draw feels right for a team of two." : "The words are done, but you can keep the call going.");

  const leaderboard = createElement("div", "leaderboard");
  rankedPlayers.forEach((player, index) => {
    const row = createElement("div", "leader-row");
    row.append(createElement("div", "leader-rank", String(index + 1)));
    const info = createElement("div", "leader-info");
    info.append(createElement("strong", "", player.name));
    info.append(createElement("span", "", `${player.correct} correct · ${player.skipped} skipped`));
    row.append(info);
    row.append(createElement("div", "leader-score", String(player.score)));
    leaderboard.append(row);
  });
  card.append(leaderboard);

  const actions = createElement("div", "round-actions");
  if (roomState.isHost) {
    actions.append(makeButton("Play again", "button-primary button-large", (button) => {
      setButtonBusy(button, true, "Resetting…");
      emitWithFeedback("back-to-lobby", {}, (response) => {
        if (!response?.ok) setButtonBusy(button, false);
      });
    }));
  } else {
    const waitingButton = makeButton("Host can start another game", "button-secondary button-large", () => {});
    waitingButton.disabled = true;
    actions.append(waitingButton);
  }
  card.append(actions);
  roomContent.replaceChildren(card);
}

function renderRoom() {
  if (!roomState) return;
  toolbarCode.textContent = roomState.code;
  switch (roomState.phase) {
    case "lobby": renderLobby(); break;
    case "round_intro": renderRoundIntro(); break;
    case "playing": renderPlaying(); break;
    case "round_result": renderRoundResult(); break;
    case "finished": renderFinished(); break;
    default: showToast("Unknown room state.", "error");
  }
}

createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const button = createForm.querySelector("button");
  const name = createNameInput.value.trim();
  setButtonBusy(button, true, "Creating room…");
  emitWithFeedback("create-room", { name }, (result) => {
    setButtonBusy(button, false);
    if (result?.ok) enterRoom(result.code, result.token, name);
  });
});

joinForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const button = joinForm.querySelector("button");
  const name = joinNameInput.value.trim();
  const code = roomCodeInput.value.trim().toUpperCase();
  setButtonBusy(button, true, "Joining…");
  emitWithFeedback("join-room", { name, code }, (result) => {
    setButtonBusy(button, false);
    if (result?.ok) enterRoom(result.code, result.token, name);
  });
});

roomCodeInput.addEventListener("input", () => {
  roomCodeInput.value = roomCodeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
});

leaveButton.addEventListener("click", () => {
  socket.emit("leave-room", () => {
    clearSession();
    returnHome();
  });
});

socket.on("connect", () => {
  setConnectionStatus(true);
  const session = getSession();
  if (!session || pendingRejoin) return;
  pendingRejoin = true;
  socket.emit("join-room", session, (result) => {
    pendingRejoin = false;
    if (result?.ok) {
      enterRoom(result.code, result.token, session.name);
    } else {
      clearSession();
      returnHome();
      showToast(result?.error || "Your previous room has expired.", "error");
    }
  });
});

socket.on("disconnect", () => setConnectionStatus(false));

socket.on("room-state", (state) => {
  roomState = state;
  const session = getSession();
  const self = state.players.find((player) => player.isSelf);
  if (!session || session.code !== state.code || session.token !== state.selfToken) {
    saveSession(state.code, state.selfToken, self?.name || session?.name || "Player");
  }
  enterRoom(state.code, state.selfToken, self?.name || "Player");
  renderRoom();
});

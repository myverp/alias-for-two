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
const GAME_INFO = {
  alias: { name: "Alias", icon: "A", description: "Explain as many words as you can before the timer ends." },
  taboo: { name: "Taboo", icon: "T", description: "Explain the target without saying any of the five forbidden words." },
  password: { name: "Password", icon: "P", description: "Give one-word clues. Your partner gets up to five guesses." },
  categories: { name: "Categories", icon: "C", description: "Find answers for four categories that begin with the same letter." },
  whoami: { name: "Who Am I?", icon: "?", description: "Answer yes-or-no questions while your partner guesses a hidden identity." },
};

let roomState = null;
let countdownInterval = null;
let countdownDeadline = null;
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
  try { return JSON.parse(localStorage.getItem(SESSION_KEY) || "null"); } catch { return null; }
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
  toastTimeout = setTimeout(() => toast.classList.remove("show"), 3200);
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
  countdownDeadline = null;
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

function makeSelect(options, selectedValue) {
  const select = createElement("select");
  options.forEach(([value, label]) => {
    const option = createElement("option", "", label);
    option.value = value;
    select.append(option);
  });
  select.value = selectedValue;
  return select;
}

function renderPlayer(player) {
  const node = playerTemplate.content.firstElementChild.cloneNode(true);
  node.querySelector(".avatar").textContent = player.name.slice(0, 1).toUpperCase();
  node.querySelector(".player-name").textContent = player.name;
  const roles = [];
  if (player.isSelf) roles.push("You");
  if (player.isHost) roles.push("Host");
  node.querySelector(".player-role").textContent = roles.join(" · ") || "Player";
  node.querySelector(".player-status").classList.toggle("offline", !player.connected);
  node.querySelector(".player-status").title = player.connected ? "Connected" : "Disconnected";
  return node;
}

function renderLobby() {
  const card = createGameCard();
  addHeading(card, "Room ready", "Choose your game", "Share the private link, pick a game, and start when both of you are here.");

  const inviteBox = createElement("div", "invite-box");
  const inviteText = createElement("div");
  inviteText.append(createElement("span", "", "Room code"), createElement("strong", "", roomState.code));
  const copyButton = createElement("button", "copy-button", "Copy invite link");
  copyButton.type = "button";
  copyButton.addEventListener("click", async () => {
    const inviteUrl = `${window.location.origin}/?room=${roomState.code}`;
    try { await navigator.clipboard.writeText(inviteUrl); showToast("Invite link copied."); }
    catch { window.prompt("Copy this invite link:", inviteUrl); }
  });
  inviteBox.append(inviteText, copyButton);
  card.append(inviteBox);

  const gamePicker = createElement("div", "game-picker");
  Object.entries(GAME_INFO).forEach(([type, info]) => {
    const button = createElement("button", `game-option${roomState.settings.gameType === type ? " selected" : ""}`);
    button.type = "button";
    button.disabled = !roomState.isHost;
    button.dataset.game = type;
    button.append(createElement("span", "game-option-icon", info.icon));
    const copy = createElement("span", "game-option-copy");
    copy.append(createElement("strong", "", info.name), createElement("small", "", info.description));
    button.append(copy);
    button.addEventListener("click", () => updateSettings({ gameType: type }));
    gamePicker.append(button);
  });
  card.append(gamePicker);

  const lobbyGrid = createElement("div", "lobby-grid lobby-grid-games");
  const playerColumn = createElement("div");
  playerColumn.append(createElement("h2", "subsection-title", "Players"));
  const playersList = createElement("div", "players-list");
  roomState.players.forEach((player) => playersList.append(renderPlayer(player)));
  if (roomState.players.length < 2) playersList.append(createElement("div", "empty-player", "Waiting for your partner…"));
  playerColumn.append(playersList);

  const settingsColumn = createElement("div");
  settingsColumn.append(createElement("h2", "subsection-title", "Game settings"));
  const settingsGrid = createElement("div", "settings-grid");
  const controls = {};
  const addSetting = (key, label, select) => {
    const wrapper = createElement("label", "", label);
    select.disabled = !roomState.isHost;
    wrapper.append(select);
    settingsGrid.append(wrapper);
    controls[key] = select;
  };

  if (["alias", "taboo", "categories"].includes(roomState.settings.gameType)) {
    addSetting("roundSeconds", "Round time", makeSelect([[30, "30 seconds"], [60, "60 seconds"], [90, "90 seconds"]], String(roomState.settings.roundSeconds)));
  }
  addSetting("totalRounds", "Total rounds", makeSelect([[4, "4 rounds"], [6, "6 rounds"], [8, "8 rounds"], [10, "10 rounds"]], String(roomState.settings.totalRounds)));
  if (["alias", "password"].includes(roomState.settings.gameType)) {
    addSetting("wordMode", "Word set", makeSelect([
      ["english_easy", "English · Easy"],
      ["english_medium", "English · Medium"],
      ["ukrainian_mixed", "Ukrainian · Easy & Medium"],
    ], roomState.settings.wordMode));
  }
  Object.values(controls).forEach((control) => control.addEventListener("change", () => updateSettings({
    roundSeconds: controls.roundSeconds ? Number(controls.roundSeconds.value) : roomState.settings.roundSeconds,
    totalRounds: Number(controls.totalRounds.value),
    wordMode: controls.wordMode?.value || roomState.settings.wordMode,
  })));
  settingsColumn.append(settingsGrid);
  settingsColumn.append(createElement("p", "settings-note", GAME_INFO[roomState.settings.gameType].description));
  lobbyGrid.append(playerColumn, settingsColumn);
  card.append(lobbyGrid);

  if (roomState.isHost) {
    const startButton = makeButton(`Start ${GAME_INFO[roomState.settings.gameType].name} →`, "button-primary button-large lobby-action", (button) => {
      setButtonBusy(button, true, "Starting…");
      emitWithFeedback("start-game", {}, (result) => { if (!result?.ok) setButtonBusy(button, false); });
    });
    startButton.disabled = roomState.players.length !== 2 || !roomState.players.every((player) => player.connected);
    card.append(startButton);
    if (startButton.disabled) card.append(createElement("p", "waiting-note", "Both players need to be connected before you can start."));
  } else card.append(createElement("p", "waiting-note", "The host will start the game when you are both ready."));
  roomContent.replaceChildren(card);
}

function updateSettings(changes) {
  emitWithFeedback("update-settings", { ...roomState.settings, ...changes });
}

function addRoundMeta(card) {
  const meta = createElement("div", "round-meta");
  meta.append(createElement("span", "", `Round ${roomState.game.round} of ${roomState.game.totalRounds}`));
  const game = GAME_INFO[roomState.settings.gameType].name;
  const time = ["alias", "taboo", "categories"].includes(roomState.settings.gameType) ? ` · ${roomState.settings.roundSeconds}s` : "";
  meta.append(createElement("span", "", `${game}${time}`));
  card.append(meta);
}

function renderRoundIntro() {
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const type = roomState.settings.gameType;
  const info = GAME_INFO[type];
  const starts = type === "categories" ? roomState.isHost : roomState.game.isExplainer;
  let title;
  let subtitle;
  if (type === "categories") {
    title = "A shared challenge";
    subtitle = "You will both get the same letter and four categories. Unique valid answers score one point.";
  } else if (type === "password") {
    title = roomState.game.isExplainer ? "You give the clues" : `${roomState.game.explainerName} gives the clues`;
    subtitle = roomState.game.isExplainer ? "You will see the password and give one word at a time." : "You get up to five guesses to find the password.";
  } else if (type === "whoami") {
    title = roomState.game.isExplainer ? "You know the identity" : "You are the mystery person";
    subtitle = roomState.game.isExplainer ? `Answer ${roomState.game.guesserName}'s questions with Yes, No, or Maybe.` : "Ask up to 20 yes-or-no questions over your call.";
  } else {
    title = roomState.game.isExplainer ? "You explain this round" : `${roomState.game.explainerName} explains`;
    subtitle = type === "taboo"
      ? (roomState.game.isExplainer ? "Describe the target without using any forbidden words." : "Guess the target while your partner avoids five forbidden words.")
      : (roomState.game.isExplainer ? "Your partner hears your clues on the call. The word appears only here." : "Listen on your call and guess as many words as you can.");
  }
  card.append(createElement("div", "round-avatar", info.icon));
  addHeading(card, "Next up", title, subtitle);
  const actions = createElement("div", "round-actions");
  if (starts) {
    actions.append(makeButton(type === "categories" ? "Reveal challenge →" : "Reveal prompt →", "button-primary button-large", (button) => {
      setButtonBusy(button, true, "Getting ready…");
      emitWithFeedback("start-round", {}, (result) => { if (!result?.ok) setButtonBusy(button, false); });
    }));
  } else {
    const wait = makeButton("Waiting for partner…", "button-secondary button-large", () => {});
    wait.disabled = true;
    actions.append(wait);
  }
  card.append(actions);
  roomContent.replaceChildren(card);
}

function buildTimer(isFinalWord = false) {
  const timerWrap = createElement("div", "timer-wrap");
  const timerHead = createElement("div", "timer-head");
  timerHead.append(createElement("span", "", isFinalWord ? "Final prompt" : "Time left"));
  const timerNumber = createElement("strong", "timer-number", isFinalWord ? "No limit" : `${roomState.settings.roundSeconds}s`);
  timerNumber.id = "timerNumber";
  timerHead.append(timerNumber);
  const timerTrack = createElement("div", `timer-track${isFinalWord ? " is-expired" : ""}`);
  const timerFill = createElement("div", "timer-fill");
  timerFill.id = "timerFill";
  if (isFinalWord) timerFill.style.transform = "scaleX(0)";
  timerTrack.append(timerFill);
  timerWrap.append(timerHead, timerTrack);
  if (isFinalWord) timerWrap.append(createElement("p", "final-word-note", "Finish this prompt — take as much time as you need."));
  return timerWrap;
}

function updateTimer() {
  const timerNumber = document.querySelector("#timerNumber");
  const timerFill = document.querySelector("#timerFill");
  if (!timerNumber || !timerFill || countdownDeadline === null) return;
  const remainingMs = Math.max(0, countdownDeadline - performance.now());
  timerNumber.textContent = `${Math.ceil(remainingMs / 1000)}s`;
  timerFill.style.transform = `scaleX(${Math.max(0, Math.min(1, remainingMs / (roomState.settings.roundSeconds * 1000)))})`;
}

function startTimerUpdates(enabled = true) {
  clearInterval(countdownInterval);
  if (!enabled) return;
  updateTimer();
  countdownInterval = setInterval(updateTimer, 100);
}

function buildScoreStrip() {
  const scoreStrip = createElement("div", "score-strip");
  [["Correct", roomState.game.roundCorrect], ["Skipped", roomState.game.roundSkipped], ["Round score", roomState.game.roundDelta > 0 ? `+${roomState.game.roundDelta}` : roomState.game.roundDelta]].forEach(([label, value]) => {
    const item = createElement("div");
    item.append(createElement("span", "", label), createElement("strong", "", String(value)));
    scoreStrip.append(item);
  });
  return scoreStrip;
}

function renderWordGame() {
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const isFinal = roomState.game.timerExpired;
  card.append(buildTimer(isFinal), buildScoreStrip());
  if (roomState.game.isExplainer) {
    const promptCard = createElement("div", `word-card${roomState.settings.gameType === "taboo" ? " taboo-card" : ""}`);
    if (roomState.settings.gameType === "taboo") {
      promptCard.append(createElement("small", "prompt-label", "Describe"));
      promptCard.append(createElement("span", "", roomState.game.tabooCard?.target || "…"));
      const forbidden = createElement("div", "forbidden-list");
      roomState.game.tabooCard?.forbidden.forEach((word) => forbidden.append(createElement("b", "", word)));
      promptCard.append(createElement("small", "prompt-label forbidden-label", "Do not say"), forbidden);
    } else promptCard.append(createElement("span", "", roomState.game.word || "…"));
    card.append(promptCard);
    const actions = createElement("div", "play-actions");
    actions.append(makeButton("Skip −1", "button-danger-soft", (button) => scoreWord(button, "skip")));
    actions.append(makeButton("Correct +1", "button-success", (button) => scoreWord(button, "correct")));
    card.append(actions);
  } else {
    card.append(buildListeningVisual());
    card.append(createElement("p", "section-subtitle", `Listen to ${roomState.game.explainerName} and say your guesses out loud.`));
  }
  roomContent.replaceChildren(card);
  startTimerUpdates(!isFinal);
}

function buildListeningVisual() {
  const visual = createElement("div", "listen-visual");
  for (let index = 0; index < 5; index += 1) visual.append(createElement("span"));
  return visual;
}

function scoreWord(button, action) {
  document.querySelectorAll(".play-actions button").forEach((candidate) => { candidate.disabled = true; });
  emitWithFeedback("mark-word", { action }, (result) => {
    if (!result?.ok) document.querySelectorAll(".play-actions button").forEach((candidate) => { candidate.disabled = false; });
  });
}

function renderPassword() {
  clearInterval(countdownInterval);
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const cluePhase = roomState.phase === "password_clue";
  if (cluePhase) {
    if (roomState.game.isExplainer) {
      addHeading(card, `Clue ${roomState.game.attempts + 1} of 5`, roomState.game.word, "Give exactly one word. You cannot use the password itself.");
      card.append(buildSingleInputForm("One-word clue", "e.g. ocean", "Give clue →", (value, done) => emitWithFeedback("submit-password-clue", { clue: value }, done)));
    } else {
      addHeading(card, `Attempt ${roomState.game.attempts + 1} of 5`, "Waiting for a clue", `${roomState.game.explainerName} is choosing one word to help you.`);
      card.append(buildListeningVisual());
    }
  } else {
    card.append(createElement("p", "section-kicker", `Attempt ${roomState.game.attempts + 1} of 5`));
    card.append(createElement("div", "clue-pill", roomState.game.clue || "…"));
    if (roomState.game.isGuesser) {
      card.append(createElement("p", "section-subtitle", "What is the password?"));
      card.append(buildSingleInputForm("Your guess", "Type the password", "Submit guess →", (value, done) => emitWithFeedback("submit-password-guess", { guess: value }, (result) => {
        if (result?.ok && !result.guessed) showToast("Not this time — wait for another clue.");
        done(result);
      })));
    } else {
      card.append(createElement("div", "secret-reminder", `Password: ${roomState.game.word}`));
      card.append(createElement("p", "section-subtitle", `${roomState.game.guesserName} is making a guess.`));
    }
  }
  roomContent.replaceChildren(card);
}

function buildSingleInputForm(label, placeholder, buttonLabel, onSubmit) {
  const form = createElement("form", "game-input-form");
  const textLabel = createElement("label", "", label);
  const input = createElement("input");
  input.placeholder = placeholder;
  input.maxLength = 50;
  input.required = true;
  textLabel.append(input);
  const button = createElement("button", "button button-primary button-large", buttonLabel);
  button.type = "submit";
  form.append(textLabel, button);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    setButtonBusy(button, true, "Sending…");
    onSubmit(input.value.trim(), (result) => { if (!result?.ok) setButtonBusy(button, false); });
  });
  setTimeout(() => input.focus(), 0);
  return form;
}

function renderWhoAmI() {
  clearInterval(countdownInterval);
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const count = `${roomState.game.questions} / ${roomState.game.maxQuestions} questions`;
  if (roomState.game.isExplainer) {
    card.append(createElement("p", "section-kicker", count));
    const identity = createElement("div", "identity-card");
    identity.append(createElement("small", "", roomState.game.identity?.category || "Identity"));
    identity.append(createElement("strong", "", roomState.game.identity?.name || "…"));
    card.append(identity);
    card.append(createElement("p", "section-subtitle", `Answer ${roomState.game.guesserName}'s questions.`));
    const answers = createElement("div", "answer-buttons");
    [["Yes", "yes", "button-success"], ["No", "no", "button-danger-soft"], ["Maybe", "maybe", "button-secondary"]].forEach(([label, answer, style]) => {
      const button = makeButton(label, style, () => emitWithFeedback("answer-whoami", { answer }));
      button.disabled = roomState.game.questions >= roomState.game.maxQuestions;
      answers.append(button);
    });
    card.append(answers);
    const finish = createElement("div", "play-actions who-finish");
    finish.append(makeButton("Pass", "button-danger-soft", (button) => finishWhoAmI(button, "pass")));
    finish.append(makeButton("Guessed it +1", "button-success", (button) => finishWhoAmI(button, "correct")));
    card.append(finish);
  } else {
    addHeading(card, count, "Who are you?", "Ask yes-or-no questions over your call. Your partner can see the identity.");
    const answer = roomState.game.lastAnswer;
    card.append(createElement("div", `last-answer ${answer || "waiting"}`, answer ? answer.toUpperCase() : "WAITING FOR YOUR FIRST QUESTION"));
  }
  roomContent.replaceChildren(card);
}

function finishWhoAmI(button, outcome) {
  document.querySelectorAll(".who-finish button").forEach((candidate) => { candidate.disabled = true; });
  emitWithFeedback("finish-whoami", { outcome }, (result) => {
    if (!result?.ok) document.querySelectorAll(".who-finish button").forEach((candidate) => { candidate.disabled = false; });
  });
}

function renderCategories() {
  const card = createGameCard("round-card categories-card");
  addRoundMeta(card);
  card.append(buildTimer(false));
  const challenge = createElement("div", "category-challenge");
  challenge.append(createElement("small", "", "Every answer starts with"), createElement("strong", "", roomState.game.letter || "?"));
  card.append(challenge);
  if (roomState.game.submitted) {
    addHeading(card, `${roomState.game.submittedCount} of 2 ready`, "Answers submitted", "Waiting for your partner or the timer to finish.");
  } else {
    const form = createElement("form", "category-form");
    roomState.game.categories.forEach((category, index) => {
      const label = createElement("label", "", category);
      const input = createElement("input");
      input.maxLength = 50;
      input.placeholder = `${roomState.game.letter}…`;
      input.value = roomState.game.answers[index] || "";
      input.dataset.index = String(index);
      input.addEventListener("input", () => {
        const answers = [...form.querySelectorAll("input")].map((field) => field.value);
        socket.emit("update-category-draft", { answers });
      });
      label.append(input);
      form.append(label);
    });
    const submit = createElement("button", "button button-primary button-large", "Submit answers →");
    submit.type = "submit";
    form.append(submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const answers = [...form.querySelectorAll("input")].map((field) => field.value.trim());
      setButtonBusy(submit, true, "Submitting…");
      emitWithFeedback("submit-categories", { answers }, (result) => { if (!result?.ok) setButtonBusy(submit, false); });
    });
    card.append(form);
  }
  roomContent.replaceChildren(card);
  startTimerUpdates(true);
}

function renderCategoryReview() {
  clearInterval(countdownInterval);
  const card = createGameCard("category-review-card");
  addRoundMeta(card);
  addHeading(card, `Letter ${roomState.game.letter}`, "Review your answers", roomState.isHost ? "Accepted answers score one point. Tap any answer to correct the result." : "The host can correct which answers count.");
  const review = createElement("div", "category-review-grid");
  roomState.game.categoryReview.forEach((player) => {
    const column = createElement("div", "category-player-column");
    column.append(createElement("h2", "", player.name));
    player.answers.forEach((item, categoryIndex) => {
      const answer = createElement("button", `category-answer ${item.accepted ? "accepted" : "rejected"}`);
      answer.type = "button";
      answer.disabled = !roomState.isHost || !item.answer;
      answer.append(createElement("small", "", item.category), createElement("strong", "", item.answer || "No answer"), createElement("span", "", item.accepted ? "+1" : "0"));
      answer.addEventListener("click", () => emitWithFeedback("toggle-category-answer", { playerIndex: player.playerIndex, categoryIndex }));
      column.append(answer);
    });
    review.append(column);
  });
  card.append(review, buildContinueActions());
  roomContent.replaceChildren(card);
}

function renderRoundResult() {
  clearInterval(countdownInterval);
  const card = createGameCard("round-card");
  addRoundMeta(card);
  const result = roomState.game.lastRound;
  if (["alias", "taboo"].includes(result.type)) renderScoredWordResult(card, result);
  else if (result.type === "password") {
    addHeading(card, "Round complete", result.guessed ? `${result.guesserName} found it` : "Password missed", result.guessed ? `Solved in ${result.attempts} ${result.attempts === 1 ? "guess" : "guesses"}.` : "All five guesses were used.");
    card.append(buildRevealCard("Password", result.word, result.guessed ? "+1 point" : "0 points", result.guessed));
  } else {
    addHeading(card, "Round complete", result.guessed ? `${result.guesserName} guessed correctly` : "Identity revealed", `${result.questions} of 20 questions used.`);
    card.append(buildRevealCard(result.category, result.identity, result.guessed ? "+1 point" : "0 points", result.guessed));
  }
  card.append(buildContinueActions());
  roomContent.replaceChildren(card);
}

function renderScoredWordResult(card, result) {
  const isLastRound = roomState.game.round >= roomState.game.totalRounds;
  addHeading(card, "Round complete", `${result.explainerName}'s round is done`, isLastRound ? "Check the tally, then reveal the final result." : "Check the tally and fix any mistakes before the next round.");
  const grid = createElement("div", "result-grid");
  [["Correct", result.correct, "positive", "correct"], ["Skipped", result.skipped, "negative", "skipped"], ["Round score", result.delta > 0 ? `+${result.delta}` : result.delta, result.delta >= 0 ? "positive" : "negative", null]].forEach(([label, value, modifier, field]) => {
    const stat = createElement("div", `result-stat ${modifier}`);
    stat.append(createElement("span", "", label), createElement("strong", "", String(value)));
    if (field) {
      const controls = createElement("div", "result-controls");
      [-1, 1].forEach((delta) => {
        const button = createElement("button", "result-step", delta < 0 ? "−" : "+");
        button.type = "button";
        button.setAttribute("aria-label", `${delta < 0 ? "Decrease" : "Increase"} ${label.toLowerCase()}`);
        button.disabled = delta < 0 && Number(value) === 0;
        button.addEventListener("click", () => adjustRoundResult(field, delta));
        controls.append(button);
      });
      stat.append(controls);
    }
    grid.append(stat);
  });
  card.append(grid);
}

function adjustRoundResult(field, delta) {
  document.querySelectorAll(".result-step").forEach((button) => { button.disabled = true; });
  emitWithFeedback("adjust-round-result", { field, delta });
}

function buildRevealCard(kicker, value, footer, positive) {
  const reveal = createElement("div", `reveal-card ${positive ? "positive" : ""}`);
  reveal.append(createElement("small", "", kicker), createElement("strong", "", value), createElement("span", "", footer));
  return reveal;
}

function buildContinueActions() {
  const actions = createElement("div", "round-actions");
  const isLast = roomState.game.round >= roomState.game.totalRounds;
  if (roomState.isHost) {
    actions.append(makeButton(isLast ? "See final result →" : "Next round →", "button-primary button-large", (button) => {
      setButtonBusy(button, true, "Loading…");
      emitWithFeedback("next-round", {}, (result) => { if (!result?.ok) setButtonBusy(button, false); });
    }));
  } else {
    const wait = makeButton("Waiting for host…", "button-secondary button-large", () => {});
    wait.disabled = true;
    actions.append(wait);
  }
  return actions;
}

function renderFinished() {
  clearInterval(countdownInterval);
  const card = createGameCard("round-card");
  const ranked = [...roomState.players].sort((a, b) => b.score - a.score);
  const tie = ranked[0].score === ranked[1].score;
  addHeading(card, `${GAME_INFO[roomState.settings.gameType].name} complete`, tie ? "Perfectly in sync" : `${ranked[0].name} takes this one`, tie ? "You finished level." : "Ready for another game?");
  const leaderboard = createElement("div", "leaderboard");
  ranked.forEach((player, index) => {
    const row = createElement("div", "leader-row");
    row.append(createElement("div", "leader-rank", String(index + 1)));
    const info = createElement("div", "leader-info");
    info.append(createElement("strong", "", player.name), createElement("span", "", `${player.correct} scoring answers`));
    row.append(info, createElement("div", "leader-score", String(player.score)));
    leaderboard.append(row);
  });
  card.append(leaderboard);
  const actions = createElement("div", "round-actions");
  if (roomState.isHost) actions.append(makeButton("Choose another game", "button-primary button-large", (button) => {
    setButtonBusy(button, true, "Resetting…");
    emitWithFeedback("back-to-lobby", {}, (result) => { if (!result?.ok) setButtonBusy(button, false); });
  }));
  else {
    const wait = makeButton("Host can choose another game", "button-secondary button-large", () => {});
    wait.disabled = true;
    actions.append(wait);
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
    case "playing":
      if (["alias", "taboo"].includes(roomState.settings.gameType)) renderWordGame();
      else if (roomState.settings.gameType === "categories") renderCategories();
      else renderWhoAmI();
      break;
    case "password_clue":
    case "password_guess": renderPassword(); break;
    case "category_review": renderCategoryReview(); break;
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
  socket.emit("leave-room", () => { clearSession(); returnHome(); });
});

socket.on("connect", () => {
  setConnectionStatus(true);
  const session = getSession();
  if (!session || pendingRejoin) return;
  pendingRejoin = true;
  socket.emit("join-room", session, (result) => {
    pendingRejoin = false;
    if (result?.ok) enterRoom(result.code, result.token, session.name);
    else {
      clearSession();
      returnHome();
      showToast(result?.error || "Your previous room has expired.", "error");
    }
  });
});

socket.on("disconnect", () => setConnectionStatus(false));

socket.on("room-state", (state) => {
  countdownDeadline = state.phase === "playing" && Number.isFinite(state.game?.remainingMs)
    ? performance.now() + state.game.remainingMs
    : null;
  roomState = state;
  const session = getSession();
  const self = state.players.find((player) => player.isSelf);
  if (!session || session.code !== state.code || session.token !== state.selfToken) {
    saveSession(state.code, state.selfToken, self?.name || session?.name || "Player");
  }
  enterRoom(state.code, state.selfToken, self?.name || "Player");
  renderRoom();
});

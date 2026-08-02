# ClueWave

ClueWave is a small real-time game collection for two people on separate devices. Keep a voice or video call open, create a private room, share its link, and choose a game.

## Games

- Alias — explain timed English or Ukrainian words
- Taboo — explain an English target without five forbidden words
- Password — exchange one-word clues with up to five guesses
- Categories — answer four prompts with the same starting letter and review scoring together
- Who Am I? — ask up to twenty yes-or-no questions to find an identity

## Prototype features

- Private six-character room codes and shareable links
- Exactly two players per room
- Real-time game state with Socket.IO
- Secret prompts sent only to the player who should see them
- Three word modes: English Easy, English Medium, and mixed-difficulty Ukrainian
- 30, 60, or 90 second rounds
- Four to ten alternating rounds
- Classic scoring: +1 correct, -1 skipped
- Unlimited time to finish the final word after the timer reaches zero
- Editable correct and skipped totals before the next round
- Reconnection support and automatic room cleanup
- Responsive English interface for phones and laptops

Rooms and scores are currently stored in server memory. Restarting the server clears active rooms, which is appropriate for this prototype.

## Run locally

Requirements: Node.js 20 or newer.

```bash
npm install
npm start
```

Open `http://localhost:3000`. To test both players on one computer, use two different browsers or one normal and one private browser window so each player has separate local storage.

## Deployment

Deploy the repository as a persistent Node.js web service rather than a serverless function because active games use WebSocket connections.

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`
- Optional environment variable: `PORT`

Render, Railway, Fly.io, or another host with persistent WebSocket support will work for the prototype. A single application instance is required while room state remains in memory.

## Prototype limitations

- No accounts or room passwords beyond the private invite code
- No database or multi-instance synchronization
- No built-in voice/video calling
- No moderation or public matchmaking

These constraints keep the first version small and focused on the two-person remote play flow.

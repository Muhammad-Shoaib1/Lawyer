# LawyerAI MERN Demo

A demo MERN application for a **Law Firm AI Avatar Assistant**:
- Visitors ask legal questions by **text or voice**
- The backend sends the question to **Claude** (Anthropic API)
- Claude returns a **general legal guidance** reply (with jurisdiction disclaimer)
- The reply is sent to **LiveAvatar** to speak (or uses a browser speech fallback)
- **MongoDB** stores chat history, session logs, and minimal analytics

## Project Layout

- `server/` Express + MongoDB + Claude + LiveAvatar routes
- `client/` React (Vite) premium split-screen hero UI

## Prerequisites

1. Node.js 18+ (or compatible with `fetch` and `AbortController`)
2. MongoDB (optional for the demo; if `MONGO_URI` is unset, the app still runs without saving)
3. Anthropic API key (Claude)
4. LiveAvatar API key + base URL + avatar id

## Setup

### 1) Backend

```powershell
cd server
npm install
npm run dev
```

Edit `server/.env`:

```env
PORT=5000
MONGO_URI=your_mongodb_connection_string

ANTHROPIC_API_KEY=your_anthropic_key

LIVEAVATAR_API_KEY=your_liveavatar_key
LIVEAVATAR_BASE_URL=https://your-liveavatar-base-url
LIVEAVATAR_AVATAR_ID=your_avatar_id
```

If you leave keys blank, the demo remains runnable:
- Claude reply will use a safe placeholder reply
- LiveAvatar will use a browser speech fallback

### 2) Frontend

Open another terminal:

```powershell
cd client
npm install
npm run dev
```

Then open the URL shown by Vite (typically `http://localhost:5173`).

## API Endpoints

- `POST /api/chat`
  - Body: `{ "message": string, "practiceArea"?: string }`
  - Response: `{ "reply": string }`

- `POST /api/avatar/session`
  - Body: `{ "practiceArea"?: string }`
  - Response: `{ "sessionId": string, "videoUrl"?: string, "isMock"?: boolean }`

- `POST /api/avatar/speak`
  - Body: `{ "sessionId": string, "text": string, "practiceArea"?: string }`
  - Response: `{ ok: boolean, fallbackSpeech?: boolean, data?: any }`

## Notes / Demo Adjustments

- LiveAvatar endpoint paths can vary by vendor; the backend tries multiple common session/speak patterns.
- If your LiveAvatar returns a different payload shape, update `server/utils/liveAvatar.js` mappings.


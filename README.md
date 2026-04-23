# Voice Transcript Bot

A Discord bot that automatically joins voice channels, listens to conversations, and produces real-time transcripts powered by OpenAI Whisper (or a self-hosted Whisper server).

---

## Features

- **Auto-join** — Bot joins a voice channel the moment any human member enters.
- **Auto-leave** — Bot leaves and finalises the transcript when the last human member exits.
- **Real-time transcription** — Each speaker's audio segment is transcribed and posted to a dedicated text channel as `[HH:MM:SS] **Name:** text`.
- **Per-speaker audio capture** — Each user's audio stream is decoded independently (Opus → PCM → WAV) and sent to Whisper.
- **Dual Whisper modes** — Switch between the OpenAI Whisper API (`openai`) and a self-hosted Whisper instance (`local`) via a single env var.
- **End-of-session summary** — On session end, an embed shows start time, duration, and the last 10 transcript lines, plus a full `.txt` transcript file is uploaded.
- **Slash commands** — Admins/Mods can force-stop a session or check status at any time.
- **Logging** — Structured Winston logging with daily-rotating log files under `logs/`.

---

## Project Structure

```
src/
├── index.js                  # Entry point — client setup, command + event registration
├── config/
│   ├── settings.js           # Env var loader (required + optional with defaults)
│   └── constants.js          # Shared constants (brand colour, etc.)
├── commands/
│   └── vcTranscript.js       # /vctranscript slash command (stop / status)
├── events/
│   └── voiceStateUpdate.js   # Handles join/leave events to start/stop sessions
├── utils/
│   ├── logger.js             # Winston logger
│   └── helpers.js            # hasAdminRole, sendError utilities
└── voice/
    └── index.js              # Core: session management, audio capture, Whisper, summary
```

---

## Prerequisites

| Requirement | Notes |
|---|---|
| Node.js ≥ 18 | ES Modules (`"type": "module"`) |
| Discord bot token | With **Server Members Intent** and **Voice State Intent** enabled in the Developer Portal |
| Whisper API key **or** local Whisper server | See [Whisper Modes](#whisper-modes) |

---

## Setup

### 1. Clone & install

```bash
git clone <repo-url>
cd voice-transcript-bot
npm install
```

### 2. Configure environment

Copy the template and fill in your values:

```bash
cp .env.example .env
```

> `.env` is git-ignored — never commit it.

### 3. Run

```bash
# Production
npm start

# Development (auto-restarts on file change)
npm run dev
```

---

## Environment Variables

### Required

| Variable | Description |
|---|---|
| `DISCORD_TOKEN` | Your Discord bot token |
| `GUILD_ID` | The ID of the server the bot operates in |
| `ADMIN_ROLE_ID` | Role ID that can use admin commands (e.g. `/vctranscript stop`) |
| `MOD_ROLE_ID` | Moderator role ID (also granted admin command access) |
| `VC_TRANSCRIPT_CHANNEL_ID` | Text channel ID where transcripts are posted |

### Optional / Whisper

| Variable | Default | Description |
|---|---|---|
| `WHISPER_MODE` | `openai` | `openai` or `local` |
| `WHISPER_OPENAI_KEY` | _(none)_ | OpenAI API key (required when `WHISPER_MODE=openai`) |
| `WHISPER_OPENAI_BASE_URL` | `https://api.openai.com/v1/audio/transcriptions` | Override for Azure / proxy endpoints |
| `WHISPER_OPENAI_MODEL` | `whisper-1` | Whisper model name |
| `WHISPER_LOCAL_URL` | `http://localhost:9000/asr` | URL of a self-hosted Whisper HTTP server |
| `WHISPER_LANGUAGE` | `en` | BCP-47 language code for transcription hint |

---

## Whisper Modes

### `WHISPER_MODE=openai` (default)

Sends audio to the OpenAI Transcriptions API. Requires `WHISPER_OPENAI_KEY`. Works out of the box — no local setup needed.

### `WHISPER_MODE=local`

Sends audio to a self-hosted Whisper server (e.g. [ahmetoner/whisper-asr-webservice](https://github.com/ahmetoner/whisper-asr-webservice)).

```bash
# Quick local Whisper server with Docker
docker run -d -p 9000:9000 onerahmet/openai-whisper-asr-webservice --model base
```

Set `WHISPER_LOCAL_URL=http://localhost:9000/asr` in your `.env`.

---

## Slash Commands

| Command | Who | Description |
|---|---|---|
| `/vctranscript stop` | Admin / Mod | Force-stops the active transcription for the guild and posts the summary |
| `/vctranscript status` | Everyone | Shows currently active transcription sessions (VC name, duration, line count, participants) |

---

## How It Works

1. **User joins VC** → `voiceStateUpdate` fires → `startSession()` called.
2. Bot joins the channel (self-muted, not self-deafened) and creates a `Session` object tracking participants, lines, and start time.
3. A `🔴 Live Transcript Started` embed is posted to the transcript channel.
4. When a user **starts speaking**, the bot subscribes to their audio stream. The Opus stream is decoded to stereo 48 kHz PCM and buffered.
5. After 1 second of silence the buffer is closed, converted to WAV, and sent to Whisper.
6. The transcript line `[HH:MM:SS] **Name:** text` is posted to the transcript channel.
7. **Last human leaves** → `stopSession()` → connection destroyed → summary embed + full `.txt` file uploaded.

### Audio pipeline

```
Discord Opus RTP  →  prism-media Opus Decoder  →  PCM buffer
  →  pcmToWav()  →  FormData  →  Whisper HTTP API  →  text
```

---

## Troubleshooting

### Bot can't join the voice channel
- Ensure the bot has **View Channel**, **Connect**, and **Use Voice Activity** permissions in that VC.

### DAVE / end-to-end encryption error
Discord's DAVE protocol (E2E voice encryption, close codes `4016`/`4017`) is not yet supported by `@discordjs/voice`. 

**Fix:** Go to **Server Settings → Safety Setup → End-to-End Encryption in Calls → Off**.

### No transcripts appearing
- Check `WHISPER_OPENAI_KEY` is set correctly.
- Check `VC_TRANSCRIPT_CHANNEL_ID` points to a channel the bot can send messages to.
- Review `logs/` for Whisper API errors.

### Bot leaves immediately after joining
The session stops when no humans remain. If the bot joins and leaves instantly, a race condition guard detected an empty channel — this is expected behaviour if the member left before the bot connected.

---

## Dependencies

| Package | Purpose |
|---|---|
| `discord.js` | Discord API client |
| `@discordjs/voice` | Voice channel connection + audio receive |
| `prism-media` | Opus → PCM decoding |
| `opusscript` | Opus codec (native fallback) |
| `sodium-native` / `tweetnacl` | Voice encryption |
| `axios` | HTTP client for Whisper API calls |
| `form-data` | Multipart form builder for audio upload |
| `winston` + `winston-daily-rotate-file` | Structured logging with log rotation |
| `dotenv` | `.env` file loading |

---

## License

MIT

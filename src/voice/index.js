/**
 * voice/index.js — VC auto-join + Whisper transcription
 * Uses @discordjs/voice for Discord voice receive
 */

import {
  joinVoiceChannel,
  VoiceConnectionStatus,
  EndBehaviorType,
  entersState,
  getVoiceConnection,
  version as voiceVersion,
} from '@discordjs/voice';
import prism from 'prism-media';
import axios from 'axios';
import FormData from 'form-data';
import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { settings } from '../config/settings.js';
import { BRAND_COLOR } from '../config/constants.js';
import { logger } from '../utils/logger.js';

// ── Audio constants ────────────────────────────────────────────────────────
const SAMPLE_RATE  = 48_000;
const CHANNELS     = 2;
const FRAME_SIZE   = 960;
const BPS          = SAMPLE_RATE * CHANNELS * 2;
const SILENCE_MS   = 1_000;
const MIN_SEG_MS   = 400;
const VC_READY_TIMEOUT_MS = 60_000;
const VC_TRACE_LIMIT = 8;
const LEGACY_VOICE_BUILD = /^0\.1[0-8]\./.test(voiceVersion);

function rememberTrace(list, value) {
  list.push(value);
  if (list.length > VC_TRACE_LIMIT) list.shift();
}

function isLikelyDaveFailure(disconnectCode, errMessage, recentStates, recentDebug) {
  if (disconnectCode === 4016 || disconnectCode === 4017) return true;

  const combined = [errMessage, ...recentStates, ...recentDebug]
    .filter(Boolean)
    .join('\n')
    .toLowerCase();

  if (combined.includes('4016') || combined.includes('4017')) return true;
  if (combined.includes('dave') || combined.includes('no compatible encryption modes')) return true;

  return LEGACY_VOICE_BUILD
    && errMessage === 'The operation was aborted'
    && recentStates.some(line => line.includes('connecting') && line.includes('signalling'));
}

function buildVcFailureDescription(disconnectCode, errMessage, recentStates, recentDebug) {
  const likelyDAVE = isLikelyDaveFailure(disconnectCode, errMessage, recentStates, recentDebug);
  const summary = recentStates.length
    ? recentStates.slice(-4).join(' | ')
    : 'none';
  const lastDebug = recentDebug.at(-1) ?? 'none';

  if (likelyDAVE) {
    return [
      '❌ Failed to join VC. This looks like a voice encryption handshake issue.',
      '',
      `This bot is using \`@discordjs/voice\` \`${voiceVersion}\`, which only advertises the legacy \`xsalsa20_poly1305*\` voice modes.`,
      'If this server/channel requires Discord DAVE end-to-end encryption, the connection can loop between connecting and signalling and then abort.',
      '',
      'Try this:',
      '• Turn off End-to-End Encryption in Calls for the server.',
      '• Or move the bot to a newer voice stack and test DAVE support there.',
      '',
      `Close code: \`${disconnectCode ?? 'unknown'}\``,
      `Recent states: \`${summary}\``,
      `Last debug: \`${lastDebug}\``,
    ].join('\n');
  }

  return [
    `❌ Failed to join VC (code ${disconnectCode ?? 'unknown'}): ${errMessage}`,
    '',
    `Recent states: \`${summary}\``,
    `Last debug: \`${lastDebug}\``,
  ].join('\n');
}

// ── PCM → WAV ──────────────────────────────────────────────────────────────
function pcmToWav(pcm) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(BPS, 28);
  header.writeUInt16LE(CHANNELS * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

// ── Whisper ────────────────────────────────────────────────────────────────
async function transcribe(pcm) {
  if (pcm.length < (BPS * MIN_SEG_MS) / 1000) return '';
  const wav  = pcmToWav(pcm);
  const form = new FormData();

  if (settings.WHISPER_MODE === 'openai') {
    form.append('file', wav, { filename: 'audio.wav', contentType: 'audio/wav' });
    form.append('model', settings.WHISPER_OPENAI_MODEL);
    if (settings.WHISPER_LANGUAGE) form.append('language', settings.WHISPER_LANGUAGE);
    try {
      const res = await axios.post(
        settings.WHISPER_OPENAI_BASE_URL,
        form,
        { headers: { ...form.getHeaders(), Authorization: `Bearer ${settings.WHISPER_OPENAI_KEY}` }, timeout: 30_000 }
      );
      return res.data?.text?.trim() ?? '';
    } catch (err) {
      logger.error(`Whisper OpenAI: ${err.message}`);
      return '';
    }
  } else {
    form.append('audio_file', wav, { filename: 'audio.wav', contentType: 'audio/wav' });
    const params = new URLSearchParams({ output: 'txt' });
    if (settings.WHISPER_LANGUAGE) params.set('language', settings.WHISPER_LANGUAGE);
    try {
      const res = await axios.post(`${settings.WHISPER_LOCAL_URL}?${params}`, form, {
        headers: form.getHeaders(), timeout: 30_000,
      });
      return typeof res.data === 'string' ? res.data.trim() : '';
    } catch (err) {
      logger.error(`Whisper local: ${err.message}`);
      return '';
    }
  }
}

// ── Session class ──────────────────────────────────────────────────────────
class Session {
  constructor(vc, txChannel, connection) {
    this.vc         = vc;
    this.txChannel  = txChannel;
    this.connection = connection;
    this.startedAt  = new Date();
    this.participants = new Map();
    this.lines        = [];
    this.activeSubs   = new Set();
  }

  duration() {
    const s = Math.floor((Date.now() - this.startedAt) / 1000);
    const h = Math.floor(s / 3600), r = s % 3600;
    const m = Math.floor(r / 60), sec = r % 60;
    return h ? `${h}h ${m}m ${sec}s` : m ? `${m}m ${sec}s` : `${sec}s`;
  }
}

// ── Active sessions ────────────────────────────────────────────────────────
export const sessions = new Map(); // guildId → Session

// ── Subscribe to a user's audio ─────────────────────────────────────────────
function subscribeUser(session, userId, displayName) {
  if (session.activeSubs.has(userId)) return;
  session.activeSubs.add(userId);

  const sub = session.connection.receiver.subscribe(userId, {
    end: { behavior: EndBehaviorType.AfterSilence, duration: SILENCE_MS },
  });

  const decoder = new prism.opus.Decoder({ rate: SAMPLE_RATE, channels: CHANNELS, frameSize: FRAME_SIZE });
  const chunks  = [];

  decoder.on('data', chunk => chunks.push(chunk));
  sub.pipe(decoder);

  decoder.on('end', async () => {
    session.activeSubs.delete(userId);
    if (!chunks.length) return;
    const text = await transcribe(Buffer.concat(chunks));
    if (!text) return;

    const ts = new Date().toISOString().slice(11, 19);
    session.lines.push({ ts: new Date(), speaker: displayName, text });
    try {
      await session.txChannel.send(`\`${ts}\` **${displayName}:** ${text}`);
    } catch (err) {
      logger.error(`Post transcript line: ${err.message}`);
    }
  });

  sub.on('error', err => {
    logger.error(`Audio sub error for ${displayName}: ${err.message}`);
    session.activeSubs.delete(userId);
  });
}

// ── Start a session ────────────────────────────────────────────────────────
export async function startSession(client, guild, channel) {
  const txChannel = guild.channels.cache.get(settings.VC_TRANSCRIPT_CHANNEL_ID);
  if (!txChannel) {
    logger.warn('VC_TRANSCRIPT_CHANNEL_ID not found — skipping VC session');
    return;
  }

  // Race condition guard — don't connect if channel already empty
  const humans = channel.members.filter(m => !m.user.bot);
  if (humans.size === 0) return;

  if ('joinable' in channel && !channel.joinable) {
    logger.warn(`VC not joinable | #${channel.name} | ${guild.name}`);
    await txChannel.send({
      embeds: [new EmbedBuilder()
        .setDescription(`❌ I do not have permission to join ${channel.toString()}. Check **View Channel** and **Connect**.`)
        .setColor(0xed4245)],
    });
    return;
  }

  // Destroy any existing voice connection for this guild
  const existing = sessions.get(guild.id);
  if (existing) {
    try { existing.connection.destroy(); } catch {}
    sessions.delete(guild.id);
  }
  const staleConn = getVoiceConnection(guild.id);
  if (staleConn) {
    try { staleConn.destroy(); } catch {}
    await new Promise(r => setTimeout(r, 500));
  }

  let connection;
  let disconnectCode = null;
  const recentStates = [];
  const recentDebug = [];

  try {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId:   guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf:  false,
      selfMute:  true,
      debug:     true,
    });

    connection.on('debug', message => {
      rememberTrace(recentDebug, message);
      logger.info(`VC debug: ${message}`);
    });

    connection.on('error', err => {
      rememberTrace(recentDebug, `error: ${err.message}`);
      logger.error(`VC error: ${err.message}`);
    });

    // Log every state transition so we can diagnose exactly where it stalls
    connection.on('stateChange', (oldState, newState) => {
      const transition = `${oldState.status} -> ${newState.status}`;
      rememberTrace(recentStates, transition);
      logger.info(`VC state: ${oldState.status} → ${newState.status}`);
      if (newState.status === VoiceConnectionStatus.Disconnected) {
        disconnectCode = newState?.closeCode ?? null;
        logger.error(`VC disconnected | closeCode: ${disconnectCode} | reason: ${JSON.stringify(newState?.reason)}`);
        // Attempt to reconnect once; if it fails, destroy so entersState throws cleanly
        Promise.race([
          entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
        ]).catch(() => { try { connection.destroy(); } catch {} });
      }
    });

    await entersState(connection, VoiceConnectionStatus.Ready, VC_READY_TIMEOUT_MS);
  } catch (err) {
    try { connection?.destroy(); } catch {}
    const errMessage = err?.message ?? 'Unknown error';
    logger.error(`VC connect failed | closeCode: ${disconnectCode} | err: ${errMessage}`);
    const msg = buildVcFailureDescription(disconnectCode, errMessage, recentStates, recentDebug); /*
      ? '❌ This server has End-to-End Encryption (DAVE) enabled. To fix: **Server Settings → Safety Setup → End-to-End Encryption in Calls → Off**'
      : `❌ Failed to join VC (code ${disconnectCode ?? 'unknown'}): ${err.message}`;
    */ await txChannel.send({ embeds: [new EmbedBuilder().setDescription(msg).setColor(0xed4245)] });
    return;
  }

  const session = new Session(channel, txChannel, connection);
  for (const [, m] of channel.members) {
    if (!m.user.bot) session.participants.set(m.id, m.displayName);
  }
  sessions.set(guild.id, session);

  // Wire speaking events — subscribe per-user when they start talking
  connection.receiver.speaking.on('start', userId => {
    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot) return;
    session.participants.set(userId, member.displayName);
    subscribeUser(session, userId, member.displayName);
  });

  // Subscribe to anyone already speaking when the bot joined (missed the speaking event)
  for (const [userId] of connection.receiver.speaking.speakingTimeouts) {
    const member = guild.members.cache.get(userId);
    if (!member || member.user.bot) continue;
    session.participants.set(userId, member.displayName);
    subscribeUser(session, userId, member.displayName);
  }

  logger.info(`VC session started | #${channel.name} | ${guild.name}`);

  await txChannel.send({
    embeds: [new EmbedBuilder()
      .setTitle('🔴 Live Transcript Started')
      .setDescription(
        `**Channel:** ${channel.toString()}\n` +
        `**Participants:** ${[...session.participants.values()].join(', ') || 'none yet'}`
      )
      .setColor(0xed4245)
      .setTimestamp()],
  });
}

// ── Stop a session ─────────────────────────────────────────────────────────
export async function stopSession(guildId) {
  const session = sessions.get(guildId);
  if (!session) return;
  sessions.delete(guildId);

  logger.info(`VC session stopped | #${session.vc.name} | dur=${session.duration()} lines=${session.lines.length}`);
  try { session.connection.destroy(); } catch {}

  await postSummary(session);
}

// ── Post summary ───────────────────────────────────────────────────────────
async function postSummary(session) {
  const embed = new EmbedBuilder()
    .setTitle(`📋 Transcript — #${session.vc.name}`)
    .setColor(BRAND_COLOR)
    .setTimestamp()
    .addFields(
      { name: '🕐 Started', value: `<t:${Math.floor(session.startedAt / 1000)}:F>`, inline: true },
      { name: '⏱️ Duration', value: session.duration(), inline: true },
    );

  if (session.participants.size) {
    embed.addFields({
      name: `👥 Participants (${session.participants.size})`,
      value: [...session.participants.values()].join(', ').slice(0, 1024),
      inline: false,
    });
  }

  if (session.lines.length) {
    const tail    = session.lines.slice(-10);
    let preview   = tail.map(l => `\`${l.ts.toISOString().slice(11, 19)}\` **${l.speaker}:** ${l.text}`).join('\n');
    if (session.lines.length > 10) preview = `*…${session.lines.length - 10} earlier lines…*\n` + preview;
    embed.addFields({ name: `💬 Transcript (${session.lines.length} lines)`, value: preview.slice(0, 1024), inline: false });
  } else {
    embed.addFields({ name: '💬 Transcript', value: 'No speech detected', inline: false });
  }

  await session.txChannel.send({ embeds: [embed] });

  const linesText = session.lines.length
    ? session.lines.map(l => `[${l.ts.toISOString().slice(11, 19)}] ${l.speaker}: ${l.text}`).join('\n')
    : '(no speech detected)';

  const full = [
    'VC TRANSCRIPT', '='.repeat(60),
    `Channel  : #${session.vc.name}`,
    `Started  : ${session.startedAt.toISOString().replace('T', ' ').slice(0, 19)} UTC`,
    `Duration : ${session.duration()}`,
    'Participants:', ...[...session.participants.values()].map(n => `  • ${n}`),
    '', 'TRANSCRIPT', '-'.repeat(40), linesText, '='.repeat(60),
  ].join('\n');

  const stamp = session.startedAt.toISOString().slice(0, 19).replace(/:/g, '-');
  const fname = `transcript_${session.vc.name.replace(/\s+/g, '_')}_${stamp}.txt`;

  await session.txChannel.send({
    content: '📄 Full transcript:',
    files: [new AttachmentBuilder(Buffer.from(full, 'utf8'), { name: fname })],
  });
}

import { logger } from '../utils/logger.js';

export const name = 'voiceStateUpdate';
export const once = false;

export async function execute(client, oldState, newState) {
  const member = newState.member ?? oldState.member;
  if (!member || member.user.bot) return;

  try {
    const { startSession, stopSession, sessions } = await import('../voice/index.js');
    const guild = newState.guild;

    // User joined a VC
    if (newState.channelId && !oldState.channelId) {
      const channel = newState.channel;
      if (!channel) return;
      const session = sessions.get(guild.id);
      if (!session) {
        await startSession(client, guild, channel);
      } else if (session.vc.id === channel.id) {
        session.participants.set(member.id, member.displayName);
      }
      return;
    }

    // User left a VC
    if (oldState.channelId && oldState.channelId !== newState.channelId) {
      const session = sessions.get(guild.id);
      if (!session || session.vc.id !== oldState.channelId) return;
      const remaining = oldState.channel?.members.filter(m => !m.user.bot && m.id !== member.id);
      if ((remaining?.size ?? 0) === 0) {
        await stopSession(guild.id);
      }
    }
  } catch (err) {
    logger.error(`voiceStateUpdate error: ${err.message}`);
  }
}

import { SlashCommandBuilder, EmbedBuilder } from 'discord.js';
import { hasAdminRole, sendError } from '../utils/helpers.js';
import { BRAND_COLOR } from '../config/constants.js';

export const commands = [
  {
    data: new SlashCommandBuilder()
      .setName('vctranscript')
      .setDescription('VC transcription commands')
      .addSubcommand(sub =>
        sub.setName('stop').setDescription('[ADMIN] Force-stop the active transcription')
      )
      .addSubcommand(sub =>
        sub.setName('status').setDescription('Show active transcription sessions')
      ),

    async execute(interaction) {
      const sub = interaction.options.getSubcommand();
      const { sessions, stopSession } = await import('../voice/index.js');

      if (sub === 'stop') {
        if (!hasAdminRole(interaction.member)) {
          return sendError(interaction, '❌ Admin/Mod role required.');
        }
        await interaction.deferReply({ flags: 64 });
        const guildId = interaction.guildId;
        if (!sessions.has(guildId)) {
          return interaction.followUp({ content: '❌ No active transcription.', flags: 64 });
        }
        await stopSession(guildId);
        await interaction.followUp({ content: '✅ Transcription stopped.', flags: 64 });
        return;
      }

      if (sub === 'status') {
        await interaction.deferReply({ flags: 64 });
        if (!sessions.size) {
          return interaction.followUp({
            embeds: [new EmbedBuilder().setDescription('📭 No active transcription sessions.').setColor(BRAND_COLOR)],
            flags: 64,
          });
        }
        const embed = new EmbedBuilder()
          .setTitle('🔴 Active Transcriptions')
          .setColor(0xed4245)
          .setTimestamp();
        for (const session of sessions.values()) {
          embed.addFields({
            name: `#${session.vc.name}`,
            value: `**Duration:** ${session.duration()}\n**Lines so far:** ${session.lines.length}\n**Participants:** ${[...session.participants.values()].join(', ') || 'none'}`,
            inline: false,
          });
        }
        await interaction.followUp({ embeds: [embed], flags: 64 });
      }
    },
  },
];

import { EmbedBuilder } from 'discord.js';
import { settings } from '../config/settings.js';

export function hasAdminRole(member) {
  return (
    member.permissions.has('Administrator') ||
    member.roles.cache.has(settings.ADMIN_ROLE_ID) ||
    member.roles.cache.has(settings.MOD_ROLE_ID)
  );
}

export async function sendError(interaction, message) {
  const embed = new EmbedBuilder().setDescription(message).setColor(0xed4245);
  const method = interaction.deferred || interaction.replied ? 'followUp' : 'reply';
  await interaction[method]({ embeds: [embed], flags: 64 });
}

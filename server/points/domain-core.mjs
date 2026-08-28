export const PLAYER_REGISTRATION_POINTS = 100;
export const APPOINTMENT_CONFIRMED_POINTS = 25;
export const CYCLE_DISCORD_PARTICIPATION_POINTS = 50;

export const POINT_REASONS = Object.freeze({
  playerRegistered: "player_registered",
  appointmentConfirmed: "appointment_confirmed",
  cycleDiscordParticipation: "cycle_discord_participation",
});

export function pointBalance(rows) {
  return rows.reduce((total, row) => total + Number(row.points_delta), 0);
}

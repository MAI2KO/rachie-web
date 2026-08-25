export async function readAllianceEventsCommunityCore(gameProfile, communityCode, dependencies) {
  const repository = dependencies.createRepository(gameProfile);
  if (!repository) throw new Error("Community database is unavailable.");
  const membership = await repository.findCommunityGuilds(communityCode);
  if (!membership) return null;
  if (membership.guildIds.length === 0) {
    return { community: membership.community, availability: "available", alliances: [] };
  }
  const client = dependencies.getClient(gameProfile);
  if (!client) {
    return { community: membership.community, availability: "unavailable", alliances: [] };
  }
  try {
    const model = await client.read(communityCode, membership.guildIds);
    return { community: membership.community, availability: "available", alliances: model.alliances };
  } catch {
    return { community: membership.community, availability: "unavailable", alliances: [] };
  }
}

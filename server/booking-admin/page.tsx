import "server-only";

import { headers } from "next/headers";
import { notFound } from "next/navigation";

import type { GameProfile } from "@/brands/types";
import { getBrandRequestContext } from "@/brands/server";
import { BookingAdmin } from "@/components/booking-admin/booking-admin";

import { authorizeBookingAdminRequest } from "./access";
import { createBookingAdminRepository } from "./repository";
import { createBookingAdminService } from "./service-core.mjs";

export async function BookingAdminPage({ communityCode, requiredProfile }: {
  readonly communityCode: string;
  readonly requiredProfile: GameProfile;
}) {
  const { brand } = await getBrandRequestContext();
  if (brand.game.profile !== requiredProfile) notFound();
  let configuration;
  try {
    const requestHeaders = await headers();
    const request = new Request("https://booking-admin.internal/", { headers: requestHeaders });
    const authorization = await authorizeBookingAdminRequest(request, communityCode);
    if (authorization.discordSession.gameProfile !== requiredProfile) notFound();
    const repository = createBookingAdminRepository(requiredProfile);
    if (!repository) notFound();
    configuration = await createBookingAdminService({
      gameProfile: requiredProfile,
      communityId: authorization.managerContext.authorizedCommunityId,
      managerContext: authorization.managerContext,
      repository,
    }).read();
  } catch {
    notFound();
  }
  return <BookingAdmin initialConfiguration={configuration} />;
}

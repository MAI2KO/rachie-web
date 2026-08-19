import { handleRegistrationUpsert } from "@/server/native-booking/registration-route-handler";

export const runtime = "nodejs";

export async function PUT(request: Request): Promise<Response> {
  return handleRegistrationUpsert(request);
}

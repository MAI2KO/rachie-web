import { handleManagerAppointmentBoard } from "@/server/booking-board/route-handler";

export const runtime = "nodejs";

type Context = { params: Promise<{ communityCode: string }> };

export async function GET(request: Request, context: Context) {
  return handleManagerAppointmentBoard(request, (await context.params).communityCode);
}

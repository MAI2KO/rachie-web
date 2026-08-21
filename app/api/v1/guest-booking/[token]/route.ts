import { handleGuestBookingRead, handleGuestBookingSubmit } from "@/server/booking-approval/guest-route-handler";

export const runtime = "nodejs";
type Context = { params: Promise<{ token: string }> };
export async function GET(request: Request, context: Context) { return handleGuestBookingRead(request, (await context.params).token); }
export async function POST(request: Request, context: Context) { return handleGuestBookingSubmit(request, (await context.params).token); }

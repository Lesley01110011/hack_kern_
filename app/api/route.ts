import { handleAction } from "@/lib/api";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function dispatch(request: Request): Promise<Response> {
  const action = new URL(request.url).searchParams.get("action") ?? "";
  return handleAction(action, request);
}

export function GET(request: Request) {
  return dispatch(request);
}

export function POST(request: Request) {
  return dispatch(request);
}

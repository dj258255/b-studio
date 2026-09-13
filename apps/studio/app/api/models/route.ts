import { requireUser } from '@/lib/server/access';
import { errorResponse, StudioError } from '@/lib/server/errors';
import { listModelOptions, routingDecision } from '@/lib/server/model-registry';

export async function GET(request: Request) {
  try {
    requireUser(request.headers);
    return Response.json(listModelOptions());
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    requireUser(request.headers);
    const body = (await request.json().catch(() => ({}))) as { prompt?: unknown; intent?: unknown };
    if (typeof body.prompt !== 'string') throw new StudioError(400, 'prompt가 필요합니다');
    const intent = body.intent ?? 'build';
    if (intent !== 'build' && intent !== 'ask' && intent !== 'evaluate') throw new StudioError(400, 'intent가 올바르지 않습니다');
    return Response.json(routingDecision(body.prompt, intent));
  } catch (error) {
    return errorResponse(error);
  }
}

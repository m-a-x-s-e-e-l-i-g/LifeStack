import type { PageServerLoad } from "./$types";
import { backendJson } from "$lib/server/backend";
import type { AiStatus } from "$lib/types";

export const load: PageServerLoad = async () => {
  try {
    const ai = await backendJson<AiStatus>("/api/ai/status");
    return { ai };
  } catch {
    return { ai: { configured: false, model: null, baseUrl: null, hasKey: false } as AiStatus };
  }
};

import type { PageServerLoad } from "./$types";
import { backendJson } from "$lib/server/backend";
import type { ModuleDetail, ModuleSummary, AiStatus } from "$lib/types";

export const load: PageServerLoad = async () => {
  try {
    const { modules } = await backendJson<{ modules: ModuleSummary[] }>("/api/modules");
    const details = await Promise.all(
      modules.map((m) => backendJson<ModuleDetail>(`/api/modules/${m.id}`)),
    );
    let ai: AiStatus = { configured: false, model: null, baseUrl: null, hasKey: false };
    try {
      ai = await backendJson<AiStatus>("/api/ai/status");
    } catch {
      // leave default unconfigured status
    }
    return { modules: details, ai, ok: true };
  } catch {
    return {
      modules: [] as ModuleDetail[],
      ai: { configured: false, model: null, baseUrl: null, hasKey: false } as AiStatus,
      ok: false,
    };
  }
};

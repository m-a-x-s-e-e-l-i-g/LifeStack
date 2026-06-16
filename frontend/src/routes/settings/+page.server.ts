import type { PageServerLoad } from "./$types";
import { backendJson } from "$lib/server/backend";
import type { ModuleDetail, ModuleSummary } from "$lib/types";

export const load: PageServerLoad = async () => {
  try {
    const { modules } = await backendJson<{ modules: ModuleSummary[] }>("/api/modules");
    const details = await Promise.all(
      modules.map((m) => backendJson<ModuleDetail>(`/api/modules/${m.id}`)),
    );
    return { modules: details, ok: true };
  } catch {
    return { modules: [] as ModuleDetail[], ok: false };
  }
};

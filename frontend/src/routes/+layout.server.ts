import type { LayoutServerLoad } from "./$types";
import { backendJson } from "$lib/server/backend";
import type { ModuleSummary } from "$lib/types";

export const load: LayoutServerLoad = async () => {
  try {
    const data = await backendJson<{ modules: ModuleSummary[] }>("/api/modules");
    return { modules: data.modules, backendUp: true };
  } catch {
    return { modules: [] as ModuleSummary[], backendUp: false };
  }
};

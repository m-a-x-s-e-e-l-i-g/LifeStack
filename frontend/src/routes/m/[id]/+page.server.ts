import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { backendJson } from "$lib/server/backend";
import type { ModuleDetail, WidgetResult, ModuleMeta } from "$lib/types";

interface Stats {
  module: ModuleMeta;
  enabled: boolean;
  widgets: WidgetResult[];
}

export const load: PageServerLoad = async ({ params }) => {
  let stats: Stats;
  let detail: ModuleDetail;
  try {
    [stats, detail] = await Promise.all([
      backendJson<Stats>(`/api/modules/${params.id}/stats`),
      backendJson<ModuleDetail>(`/api/modules/${params.id}`),
    ]);
  } catch {
    throw error(404, "Module not found");
  }
  return { stats, detail };
};

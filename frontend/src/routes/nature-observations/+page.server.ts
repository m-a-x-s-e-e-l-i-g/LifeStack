import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { backendJson } from "$lib/server/backend";
import type {
  ModuleDetail,
  ModuleMeta,
  ObservationInsights,
  WidgetResult,
} from "$lib/types";

interface Stats {
  module: ModuleMeta;
  enabled: boolean;
  widgets: WidgetResult[];
}

export const load: PageServerLoad = async () => {
  let stats: Stats;
  let detail: ModuleDetail;
  let insights: ObservationInsights;
  try {
    [stats, detail, insights] = await Promise.all([
      backendJson<Stats>("/api/modules/observations/stats"),
      backendJson<ModuleDetail>("/api/modules/observations"),
      backendJson<ObservationInsights>("/api/modules/observations/insights"),
    ]);
  } catch {
    throw error(404, "Nature observations module not found");
  }
  return { stats, detail, insights };
};

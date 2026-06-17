import type { PageServerLoad } from "./$types";
import { backendJson } from "$lib/server/backend";
import type { OverviewData } from "$lib/types";

export const load: PageServerLoad = async () => {
  try {
    const overview = await backendJson<OverviewData>("/api/overview");
    return { overview, ok: true };
  } catch {
    return { overview: { modules: [], featured: [] } as OverviewData, ok: false };
  }
};

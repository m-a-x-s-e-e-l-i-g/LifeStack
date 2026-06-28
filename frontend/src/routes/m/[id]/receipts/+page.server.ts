import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { backendJson } from "$lib/server/backend";
import type { InboxReceiptReviewResponse, ModuleDetail } from "$lib/types";

const EMPTY_REVIEW: InboxReceiptReviewResponse = {
  status: "pending",
  totals: { pending: 0, approved: 0, declined: 0 },
  receipts: [],
};

export const load: PageServerLoad = async ({ params }) => {
  if (params.id !== "inbox") throw error(404, "Not found");

  let detail: ModuleDetail;
  try {
    detail = await backendJson<ModuleDetail>("/api/modules/inbox");
  } catch {
    throw error(404, "Module not found");
  }

  let inboxReview = EMPTY_REVIEW;
  try {
    inboxReview = await backendJson<InboxReceiptReviewResponse>(
      "/api/inbox/receipts?status=pending&limit=500",
    );
  } catch {
    // Keep empty review list when API/table is unavailable.
  }

  return { detail, inboxReview };
};

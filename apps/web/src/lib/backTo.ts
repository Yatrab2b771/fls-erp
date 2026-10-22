import { useLocation } from "react-router-dom";

// A lead page opened from the Visiting Cards screens goes back to where it came from (not always to the Leads list): the link or navigate() that opens
// it carries `state` saying where from, and the page's Back link reads it.
export interface BackTo {
  from: string;
  label: string;
}

/** Link / navigate options for opening a lead page from the Visiting Cards screens ("saved" brings back its list, otherwise the scanner). */
export const fromVisitingCards = (tab?: "saved" | "verify") => ({ state: { backTo: { from: tab ? `/visiting-cards?tab=${tab}` : "/visiting-cards", label: "Visiting Cards" } satisfies BackTo } });

export function useBackTo(fallback: BackTo): BackTo {
  const state = useLocation().state as { backTo?: BackTo } | null;
  return state?.backTo ?? fallback;
}

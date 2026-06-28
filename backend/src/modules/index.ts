import type { LifeStackModule } from "../core/types";
import watching from "./watching";
import finance from "./finance";
import energy from "./energy";
import fuel from "./fuel";
import mobility from "./mobility";
import food from "./food";
import inbox from "./inbox";
import groceries from "./groceries";
import revolut from "./revolut";
import observations from "./observations";
import flights from "./flights";
import reservations from "./reservations";

/**
 * Registered modules. Add a new module here to make it available.
 * Order controls the navigation order in the UI.
 */
export const modules: LifeStackModule[] = [
  watching,
  observations,
  finance,
  revolut,
  energy,
  fuel,
  mobility,
  flights,
  reservations,
  food,
  groceries,
  inbox,
];

import type { LifeStackModule } from "../core/types";
import watching from "./watching";
import finance from "./finance";
import energy from "./energy";
import fuel from "./fuel";
import mobility from "./mobility";

/**
 * Registered modules. Add a new module here to make it available.
 * Order controls the navigation order in the UI.
 */
export const modules: LifeStackModule[] = [watching, finance, energy, fuel, mobility];

import type { LifeStackModule } from "../core/types";
import movies from "./movies";
import finance from "./finance";
import energy from "./energy";
import fuel from "./fuel";
import mobility from "./mobility";

/**
 * Registered modules. Add a new module here to make it available.
 * Order controls the navigation order in the UI.
 */
export const modules: LifeStackModule[] = [movies, finance, energy, fuel, mobility];

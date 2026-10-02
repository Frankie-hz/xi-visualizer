import type { RouteDefinition } from "@solidjs/router";
import { lazy } from "solid-js";

import HomePage from "./pages/home";

// Every page but the landing one is loaded when it is first opened. They do not share much: the
// regions editor has no use for the packet tables, chart.js or the local database, and shipping all
// of it in one file made the first load carry six pages nobody asked for.
export const routes: RouteDefinition[] = [
  {
    path: "/",
    component: HomePage,
  },
  {
    path: "/roam/:id?",
    component: lazy(() => import("./pages/roam")),
  },
  {
    path: "/zone/:id?",
    component: lazy(() => import("./pages/zones")),
  },
  {
    path: "/navmesh",
    component: lazy(() => import("./pages/navmesh")),
  },
  {
    path: "/navmesh-diff",
    component: lazy(() => import("./pages/navmesh_diff")),
  },
  {
    path: "/regions/:zone?",
    component: lazy(() => import("./pages/regions")),
  },
  {
    path: "**",
    component: lazy(() => import("./errors/404")),
  },
];

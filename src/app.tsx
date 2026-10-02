import { A } from "@solidjs/router";
import { type JSX, Suspense } from "solid-js";

const App = (props: { children?: JSX.Element; }) => {
  return (
    <div class="content">
      <nav class="bg-slate-800 rounded-lg flex items-center">
        <ul class="flex space-x-4 font-bold items-center flex-1">
          <li class="py-2 px-4">
            <A href="/" class="no-underline hover:underline">
              Home
            </A>
          </li>
          <li class="py-2 px-4">
            <A href="/roam" class="no-underline hover:underline">
              Roam
            </A>
          </li>
          <li class="py-2 px-4">
            <A href="/zone" class="no-underline hover:underline">
              Zone
            </A>
          </li>
          <li class="py-2 px-4">
            <A href="/navmesh" class="no-underline hover:underline">
              Navmesh
            </A>
          </li>
          <li class="py-2 px-4">
            <A href="/navmesh-diff" class="no-underline hover:underline">
              Navmesh Diff
            </A>
          </li>
          <li class="py-2 px-4">
            <A href="/regions" class="no-underline hover:underline">
              Regions
            </A>
          </li>
        </ul>
        {/* Which build is actually running. A reload can keep an index.html pointing at the
            previous chunk, and without this the only way to tell is the network panel. */}
        <span class="ml-auto mr-4 self-center text-xs text-slate-500 font-mono" title="The commit this build came from">
          {__BUILD__}
        </span>
      </nav>

      <main>
        <Suspense>{props.children}</Suspense>
      </main>
    </div>
  );
};

export default App;

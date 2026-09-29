import { A } from "@solidjs/router";

export default function HomePage() {
  return (
    <section class="p-8">
      <h1 class="text-2xl font-bold">Home</h1>

      <div class="content">
        <ul>
          <li>
            <A href="/regions">Spawn regions editor</A>: draw where mobs spawn from their recorded roam trails, and open a pull request with it
          </li>
          <li>
            <A href="/regions-diff">Regions diff</A>: paste a pull request to see what it does to the spawn regions
          </li>
          <li>
            <A href="/zone">Zone viewer</A>
          </li>
        </ul>
      </div>
    </section>
  );
}

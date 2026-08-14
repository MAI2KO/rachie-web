import { getBrandRequestContext } from "@/brands/server";

export default async function Home() {
  const { brand, hostname } = await getBrandRequestContext();

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl items-center px-6 py-16">
      <section aria-labelledby="diagnostic-heading" className="w-full">
        <h1 id="diagnostic-heading" className="mb-8 text-3xl font-semibold">
          Brand diagnostics
        </h1>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-8 gap-y-4 border-t border-zinc-200 py-6">
          <dt className="font-medium text-zinc-600">Active brand</dt>
          <dd>{brand.name}</dd>
          <dt className="font-medium text-zinc-600">Game</dt>
          <dd>{brand.game.name}</dd>
          <dt className="font-medium text-zinc-600">Game profile</dt>
          <dd>{brand.game.profile}</dd>
          <dt className="font-medium text-zinc-600">Hostname detected</dt>
          <dd>{hostname}</dd>
        </dl>
      </section>
    </main>
  );
}

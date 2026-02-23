export async function onRequest() {
  const r = await fetch("https://example.com", { cache: "no-store" });
  return new Response("status=" + r.status);
}

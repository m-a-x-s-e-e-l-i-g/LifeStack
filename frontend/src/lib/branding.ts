const PROVIDER_LOGOS: Record<string, string> = {
  uber: "https://upload.wikimedia.org/wikipedia/commons/6/62/Uber_logo.svg",
  bolt: "https://upload.wikimedia.org/wikipedia/commons/2/28/Vector_logo_of_Bolt.svg",
  lime: "https://upload.wikimedia.org/wikipedia/commons/e/e1/Lime_%28transportation_company%29_logo.svg",
};

function normalizeProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

export function providerLogoUrl(provider: string): string | null {
  const name = normalizeProvider(provider);
  for (const [key, url] of Object.entries(PROVIDER_LOGOS)) {
    if (name.includes(key)) return url;
  }
  return null;
}

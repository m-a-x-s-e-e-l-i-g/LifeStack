const PROVIDER_LOGOS: Record<string, string> = {
  uber: "https://upload.wikimedia.org/wikipedia/commons/6/62/Uber_logo.svg",
  bolt: "https://upload.wikimedia.org/wikipedia/commons/2/28/Vector_logo_of_Bolt.svg",
  lime: "https://upload.wikimedia.org/wikipedia/commons/e/e1/Lime_%28transportation_company%29_logo.svg",
  trakt: "https://walter.trakt.tv/assets/logos/header/trakt-header-white.png",
  "trakt tv": "https://walter.trakt.tv/assets/logos/header/trakt-header-white.png",
  revolut: "https://upload.wikimedia.org/wikipedia/commons/thumb/8/8f/Revolut_logo.svg/1024px-Revolut_logo.svg.png",
  gmail: "https://upload.wikimedia.org/wikipedia/commons/thumb/7/7e/Gmail_icon_%282020%29.svg/1024px-Gmail_icon_%282020%29.svg.png",
  outlook: "https://upload.wikimedia.org/wikipedia/commons/thumb/d/df/Microsoft_Office_Outlook_%282018%E2%80%93present%29.svg/1024px-Microsoft_Office_Outlook_%282018%E2%80%93present%29.svg.png",
  thuisbezorgd: "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Thuisbezorgd.svg/1024px-Thuisbezorgd.svg.png",
  "takeaway com": "https://upload.wikimedia.org/wikipedia/commons/thumb/a/a9/Thuisbezorgd.svg/1024px-Thuisbezorgd.svg.png",
  "uber eats": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Uber_Eats.svg/1024px-Uber_Eats.svg.png",
  ubereats: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Uber_Eats.svg/1024px-Uber_Eats.svg.png",
  "albert heijn": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Albert_Heijn_logo.svg/1024px-Albert_Heijn_logo.svg.png",
  albertheijn: "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Albert_Heijn_logo.svg/1024px-Albert_Heijn_logo.svg.png",
  "ah nl": "https://upload.wikimedia.org/wikipedia/commons/thumb/1/1c/Albert_Heijn_logo.svg/1024px-Albert_Heijn_logo.svg.png",
  jumbo: "https://upload.wikimedia.org/wikipedia/commons/thumb/c/cc/Jumbo_supermarkt_logo.svg/1024px-Jumbo_supermarkt_logo.svg.png",
};

function normalizeProvider(provider: string): string {
  return provider
    .trim()
    .toLowerCase()
    .replace(/[\s._/-]+/g, " ")
    .replace(/\s+/g, " ");
}

export function providerLogoUrl(provider: string): string | null {
  const name = normalizeProvider(provider);
  for (const [key, url] of Object.entries(PROVIDER_LOGOS)) {
    if (name.includes(key)) return url;
  }
  return null;
}

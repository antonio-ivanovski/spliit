import type { CategoryId } from '../categories'

/**
 * Best-effort mapping of Cospend category names to Spliit category ids.
 *
 * Cospend categories are user-defined and may be in any language, so this is a
 * keyword-based heuristic that falls back to `general` when nothing matches.
 * Matching is case-insensitive and runs on the trimmed, lower-cased name.
 */
const KEYWORDS: Array<[readonly string[], CategoryId]> = [
  // Food & drink
  [
    [
      'lebensmittel',
      'supermarkt',
      'rewe',
      'lidl',
      'aldi',
      'markt',
      'grocer',
      'groceries',
      'supermarket',
    ],
    'groceries',
  ],
  [
    [
      'restaurant',
      'essen',
      'kantine',
      'cafe',
      'café',
      'pizzeria',
      'pizza',
      'bistro',
      'dining',
      'fastfood',
      'fast food',
      'imbiss',
    ],
    'dining-out',
  ],
  [
    [
      'getraenk',
      'getränke',
      'drink',
      'drinks',
      'bar',
      'kneipe',
      'bier',
      'liquor',
      'alcohol',
      'alkohol',
    ],
    'liquor',
  ],
  [['food', 'snack', 'imbiß', 'verpflegung'], 'food-and-drink'],
  // Home
  [['miete', 'rent'], 'rent'],
  [['strom', 'electricity', 'energie', 'energy'], 'electricity'],
  [['gas', 'heizung', 'heat', 'warme', 'wärme'], 'heat-gas'],
  [['wasser', 'water'], 'water'],
  [
    ['internet', 'tv', 'telefon', 'phone', 'kabel', 'broadband'],
    'tv-phone-internet',
  ],
  [
    ['handwerk', 'reparatur', 'maintenance', 'repair', 'handwerker'],
    'maintenance',
  ],
  [['mobel', 'möbel', 'furniture'], 'furniture'],
  [['garten', 'gardening', 'garden', 'pflanzen', 'plants'], 'gardening'],
  [['haushalt', 'household', 'reinigung', 'cleaning'], 'household-supplies'],
  // Transportation
  [['taxi', 'uber'], 'taxi'],
  [['tanken', 'diesel', 'fuel', 'kraftstoff', 'benzin'], 'gas-fuel'],
  [['parken', 'parking', 'parkplatz'], 'parking'],
  [['vignette', 'maut', 'toll', 'tolls', 'autobahn'], 'tolls'],
  [
    ['bahn', 'bus', 'train', 'ubahn', 's-bahn', 'bus/train', 'public'],
    'bus-train',
  ],
  [['flug', 'flughafen', 'plane', 'flight', 'airline'], 'plane'],
  [
    [
      'hotel',
      'unterkunft',
      'hostel',
      'motel',
      'airbnb',
      'lodging',
      'accommodation',
    ],
    'hotel',
  ],
  [
    [
      'auto',
      'car',
      'kfz',
      'fahrzeug',
      'vehicle',
      'fahrrad',
      'bicycle',
      'bike',
      'suv',
    ],
    'car',
  ],
  [
    ['verkehr', 'transport', 'transportation', 'anfahrt', 'reise', 'trip'],
    'transportation',
  ],
  // Life
  [['versicherung', 'insurance', 'haftpflicht', 'kasko'], 'insurance'],
  [
    [
      'arzt',
      'apotheke',
      'medical',
      'health',
      'gesundheit',
      'zahnarzt',
      'dental',
      'medication',
      'arznei',
    ],
    'medical-expenses',
  ],
  [['steuer', 'tax', 'taxes'], 'taxes'],
  [
    ['kind', 'child', 'kita', 'kinder', 'school', 'schule', 'education'],
    'childcare',
  ],
  [['kleidung', 'clothing', 'shoppen', 'shopping', 'kauf', 'shop'], 'clothing'],
  [['geschenk', 'gift', 'gifts', 'spende', 'donation'], 'gifts'],
  // Entertainment
  [['kino', 'movies', 'movie', 'cinema', 'film'], 'movies'],
  [['musik', 'music', 'konzert', 'concert', 'cd'], 'music'],
  [['sport', 'sports', 'fitness', 'gym', 'turnhalle', 'verein'], 'sports'],
  [['spiel', 'games', 'game', 'spielen', 'console'], 'games'],
  [
    [
      'ausflug',
      'kultur',
      'event',
      'events',
      'aktivitaet',
      'aktivität',
      'activity',
      'freizeit',
      'hobby',
      'spaß',
      'spass',
    ],
    'events-and-activities',
  ],
  [['vergnuegen', 'vergnügen', 'entertainment'], 'entertainment'],
  // Subscriptions
  [
    [
      'abo',
      'subscription',
      'subscriptions',
      'streaming',
      'netflix',
      'spotify',
      'mitgliedschaft',
      'membership',
    ],
    'subscriptions-and-memberships',
  ],
  // Utilities / services
  [['utility', 'utilities', 'nebenkosten'], 'utilities'],
  [['service', 'services', 'dienstleistung'], 'services'],
  // Income
  [
    ['salary', 'einkommen', 'income', 'lohn', 'gage', 'gehalt', 'bonus'],
    'income',
  ],
  // Settlement / Reimbursement
  [
    ['reimbursement', 'rückzahlung', 'ausgleich', 'settlement', 'repayment'],
    'settlement',
  ],
]

export function cospendCategoryToId(
  name: string | null | undefined,
): CategoryId {
  if (!name) return 'general'
  const normalized = name.trim().toLowerCase()
  if (!normalized) return 'general'
  for (const [keywords, categoryId] of KEYWORDS) {
    if (
      keywords.some((keyword) => {
        if (normalized === keyword) return true
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const pattern = new RegExp(
          `(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`,
          'u',
        )
        return pattern.test(normalized)
      })
    ) {
      return categoryId
    }
  }
  return 'general'
}
